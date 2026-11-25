/**
 * Exercise schema + validator tests.
 *
 * The validator is a pure function of the run evidence, so most tests inject a
 * deterministic fake runner. The three example validators are driven through a
 * tiny topology oracle (a documented test double that answers only the
 * questions those fixtures ask) so the reference and trap topologies produce
 * different evidence without pulling `@netlab/cli` into this package.
 */

import { describe, expect, test } from "bun:test";
import type { Trace } from "@netlab/core";
import {
  EXERCISE_VERSION,
  type ExerciseJSON,
  parseExerciseJson,
  parseExerciseText,
  type ScenarioLike,
} from "../src/schema";
import {
  exerciseExamples,
  planProbes,
  prepareScenario,
  type RunEvidence,
  type ShellTranscriptLike,
  validateExercise,
} from "../src/validate";

const BASE_SCENARIO: ScenarioLike = {
  version: 1,
  seed: 0,
  until: "1ms",
  nodes: [
    {
      type: "host",
      id: "h1",
      interfaces: [
        {
          name: "eth0",
          mac: "02:00:00:00:00:0a",
          ip: "10.0.0.1",
          mask: "255.255.255.0",
        },
      ],
    },
    {
      type: "host",
      id: "h2",
      interfaces: [
        {
          name: "eth0",
          mac: "02:00:00:00:00:0b",
          ip: "10.0.0.2",
          mask: "255.255.255.0",
        },
      ],
    },
    { type: "switch", id: "sw1", ports: [{ name: "p1" }, { name: "p2" }] },
  ],
  links: [
    {
      id: "l1",
      a: { node: "h1", iface: "eth0" },
      b: { node: "sw1", iface: "p1" },
      params: { latencyUs: 10 },
    },
    {
      id: "l2",
      a: { node: "h2", iface: "eth0" },
      b: { node: "sw1", iface: "p2" },
      params: { latencyUs: 10 },
    },
  ],
  actions: [],
};

/** Raw exercise envelope with a valid base and one MAC-table check. */
function rawExercise(): Record<string, unknown> {
  return {
    version: 1,
    id: "l2-mac-learning",
    title: "MAC learning",
    kind: "construir",
    objective: "Wire h1 into sw1 p1.",
    seed: 3,
    until: "1ms",
    base: BASE_SCENARIO,
    hints: [{ level: 1, text: "Cable ends matter.", penalty: 5 }],
    checks: [
      {
        type: "macTable",
        switch: "sw1",
        mac: "02:00:00:00:00:0a",
        port: "p1",
      },
    ],
  };
}

function exerciseWith(checks: Array<unknown>): ExerciseJSON {
  return parseExerciseJson({
    ...rawExercise(),
    checks,
  });
}

function macRow(
  mac: string,
  port: string,
): {
  mac: { toString(): string };
  port: string;
  vlan: number;
  expiresAt: number;
} {
  return { mac: { toString: () => mac }, port, vlan: 1, expiresAt: 1 };
}

function evidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    traces: [],
    macTables: {},
    routes: {},
    shellTranscripts: [],
    seed: 0,
    finalTime: 0,
    processed: 0,
    ...overrides,
  };
}

function pingOutput(
  host: string,
  command: string,
  transmitted: number,
  received: number,
): ShellTranscriptLike {
  return {
    host,
    command,
    lines: [
      `--- ${command} ping statistics ---`,
      `${transmitted} packets transmitted, ${received} received, ` +
        `${(((transmitted - received) / transmitted) * 100).toFixed(1)}% packet loss`,
    ],
  };
}

function dropTrace(link: string, reason: "loss" | "mtu_exceeded"): Trace {
  return {
    t: 0,
    kind: "frame_drop",
    link,
    where: "link",
    reason,
    length: 84,
    frame: new Uint8Array(0),
  };
}

/**
 * Deterministic stand-in for the simulator. It answers only the questions the
 * three example fixtures ask, and answers them from the topology, so the
 * reference and trap topologies yield different evidence.
 */
function topologyOracle(scenario: ScenarioLike): RunEvidence {
  const nodes = scenario.nodes;
  const node = (id: string) => nodes.find((entry) => entry.id === id);
  const interfaces = (id: string) => node(id)?.interfaces ?? [];
  const hostMac = (id: string) => interfaces(id)[0]?.mac;
  const links = (scenario.links ?? []) as Array<{
    id: string;
    a: { node: string; iface: string };
    b: { node: string; iface: string };
    params?: { lossRate?: number };
  }>;

  // A switch learns the MAC of every host wired into one of its ports.
  const macTables: Record<string, Array<ReturnType<typeof macRow>>> = {};
  for (const link of links) {
    for (const [hostEnd, switchEnd] of [
      [link.a, link.b],
      [link.b, link.a],
    ] as const) {
      if (node(switchEnd.node)?.type !== "switch") {
        continue;
      }
      if (node(hostEnd.node)?.type !== "host") {
        continue;
      }
      const mac = hostMac(hostEnd.node);
      if (mac === undefined) {
        continue;
      }
      const rows = macTables[switchEnd.node];
      if (rows === undefined) {
        macTables[switchEnd.node] = [macRow(mac, switchEnd.iface)];
      } else {
        rows.push(macRow(mac, switchEnd.iface));
      }
    }
  }

  // Every router port installs its connected route.
  const routes: Record<
    string,
    Array<{ destination: string; iface: string }>
  > = {};
  for (const entry of nodes) {
    if (entry.type !== "router" || entry.id === undefined) {
      continue;
    }
    routes[entry.id] = interfaces(entry.id).flatMap((iface) => {
      const cidr = connectedCidr(iface);
      return cidr === undefined || iface.name === undefined
        ? []
        : [{ destination: cidr, iface: iface.name }];
    });
  }

  // A lossy link drops the frames that cross it.
  const traces: Array<Trace> = [];
  for (const link of links) {
    if ((link.params?.lossRate ?? 0) > 0) {
      traces.push(dropTrace(link.id, "loss"));
    }
  }

  // Shell probes: ping answers only when the source can route to the target.
  const shellTranscripts: Array<ShellTranscriptLike> = [];
  for (const action of scenario.actions ?? []) {
    const { host, exec } = action as { host?: string; exec?: string };
    if (typeof host !== "string" || typeof exec !== "string") {
      continue;
    }
    const match = /^ping -c (\d+) (\S+)$/.exec(exec);
    if (match === null) {
      shellTranscripts.push({ host, command: exec, lines: ["ok"] });
      continue;
    }
    const count = Number(match[1]);
    const dst = match[2] as string;
    shellTranscripts.push(
      reachable(scenario, host, dst)
        ? pingOutput(host, exec, count, count)
        : {
            host,
            command: exec,
            error: `${host}: no route to ${dst}: no gateway configured`,
          },
    );
  }

  return {
    traces,
    macTables,
    routes,
    shellTranscripts,
    seed: scenario.seed ?? 0,
    finalTime: 1_000_000,
    processed: shellTranscripts.length,
  };
}

function toU32(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function prefixLength(iface: {
  ip?: string | undefined;
  mask?: string | undefined;
}): number {
  const fromIp = iface.ip?.split("/")[1];
  if (fromIp !== undefined) {
    return Number(fromIp);
  }
  if (iface.mask === undefined) {
    return 24; // the fixtures are /24
  }
  return iface.mask.split(".").reduce(
    (bits, octet) =>
      bits +
      (Number(octet)
        .toString(2)
        .split("")
        .filter((bit) => bit === "1").length ?? 0),
    0,
  );
}

function samePrefix(a: string, b: string, length: number): boolean {
  if (length <= 0) {
    return true;
  }
  const mask = length >= 32 ? 0xffffffff : ~((1 << (32 - length)) - 1) >>> 0;
  return (toU32(a) & mask) === (toU32(b) & mask);
}

function connectedCidr(iface: {
  ip?: string | undefined;
  mask?: string | undefined;
}): string | undefined {
  const [ip] = (iface.ip ?? "").split("/");
  if (ip === undefined || ip === "") {
    return undefined;
  }
  const length = prefixLength(iface);
  const mask = length >= 32 ? 0xffffffff : ~((1 << (32 - length)) - 1) >>> 0;
  const network = (toU32(ip) & mask) >>> 0;
  const text = [24, 16, 8, 0]
    .map((shift) => (network >>> shift) & 0xff)
    .join(".");
  return `${text}/${length}`;
}

/** Same subnet, or a gateway to hand the packet to (single-router fixtures). */
function reachable(
  scenario: ScenarioLike,
  from: string,
  dstIp: string,
): boolean {
  const ifaces =
    scenario.nodes.find((entry) => entry.id === from)?.interfaces ?? [];
  for (const iface of ifaces) {
    const [ip] = (iface.ip ?? "").split("/");
    if (
      ip !== undefined &&
      ip !== "" &&
      samePrefix(ip, dstIp, prefixLength(iface))
    ) {
      return true;
    }
  }
  return ifaces.some((iface) => iface.gateway !== undefined);
}

describe("exercise schema", () => {
  test("accepts a v1 exercise and applies defaults", () => {
    const parsed = parseExerciseJson(rawExercise());
    expect(parsed.version).toBe(EXERCISE_VERSION);
    expect(parsed.seed).toBe(3);
    expect(parsed.kind).toBe("construir");
    expect(parsed.hints).toHaveLength(1);
    expect(parsed.checks).toHaveLength(1);

    const { seed: _seed, ...withoutSeed } = rawExercise();
    expect(parseExerciseJson(withoutSeed).seed).toBe(0);
  });

  test("rejects unknown versions and kinds", () => {
    expect(() => parseExerciseJson({ ...rawExercise(), version: 2 })).toThrow(
      /version/,
    );
    expect(() =>
      parseExerciseJson({ ...rawExercise(), kind: "jugar" }),
    ).toThrow(/kind/);
  });

  test("rejects an exercise without checks and with duplicate names", () => {
    expect(() => parseExerciseJson({ ...rawExercise(), checks: [] })).toThrow(
      /at least one check/,
    );
    expect(() =>
      parseExerciseJson({
        ...rawExercise(),
        checks: [
          {
            type: "arp",
            name: "same",
            host: "h1",
            ip: "10.0.0.2",
            mac: "02:00:00:00:00:0b",
          },
          {
            type: "arp",
            name: "same",
            host: "h1",
            ip: "10.0.0.2",
            mac: "02:00:00:00:00:0b",
          },
        ],
      }),
    ).toThrow(/duplicate check name/);
  });

  test("rejects unsound check fields with a path", () => {
    expect(() =>
      parseExerciseJson({
        ...rawExercise(),
        checks: [
          { type: "ping", from: "h1", to: "h2", minReplies: 4, count: 2 },
        ],
      }),
    ).toThrow(/checks\[0\].*minReplies/);

    expect(() =>
      parseExerciseJson({
        ...rawExercise(),
        checks: [
          {
            type: "exec",
            host: "h1",
            command: "arp -a",
            expect: { stdoutMatches: "(" },
          },
        ],
      }),
    ).toThrow(/expect\.stdoutMatches/);

    expect(() =>
      parseExerciseJson({
        ...rawExercise(),
        checks: [{ type: "trace", kind: "frame_tx", reason: "loss" }],
      }),
    ).toThrow(/frame_drop/);

    expect(() =>
      parseExerciseJson({
        ...rawExercise(),
        checks: [
          {
            type: "macTable",
            switch: "sw1",
            mac: "02:00:00:00:00",
            port: "p1",
          },
        ],
      }),
    ).toThrow(/checks\[0\].*mac/);

    expect(() =>
      parseExerciseJson({
        ...rawExercise(),
        checks: [{ type: "nope" }],
      }),
    ).toThrow(/checks\[0\].*type/);
  });

  test("rejects a base that is not a v1 scenario", () => {
    expect(() =>
      parseExerciseJson({ ...rawExercise(), base: { version: 2, nodes: [] } }),
    ).toThrow(/base/);
    expect(() =>
      parseExerciseJson({
        ...rawExercise(),
        base: { version: 1, nodes: [{}] },
      }),
    ).toThrow(/base\.nodes\[0\]/);
  });

  test("parses exercise text and reports bad JSON", () => {
    const parsed = parseExerciseText(JSON.stringify(rawExercise()), "e.json");
    expect(parsed.id).toBe("l2-mac-learning");
    expect(() => parseExerciseText("{", "e.json")).toThrow(
      /cannot parse exercise/,
    );
  });
});

describe("probe planning", () => {
  test("plans ping, exec and arp probes before the run", () => {
    const exercise = exerciseWith([
      { type: "ping", from: "h1", to: "h2", minReplies: 2 },
      { type: "exec", host: "h1", command: "arp -a", expect: { exitOk: true } },
      { type: "arp", host: "h1", ip: "10.0.0.2", mac: "02:00:00:00:00:0b" },
      { type: "trace", kind: "frame_drop", maxCount: 0 },
    ]);
    const plan = planProbes(exercise, BASE_SCENARIO);
    expect(plan.entries.map((entry) => [entry.check, entry.command])).toEqual([
      [0, "ping -c 2 10.0.0.2"],
      [1, "arp -a"],
      [2, "arp -a"],
    ]);

    const prepared = prepareScenario(exercise, BASE_SCENARIO);
    expect(prepared.seed).toBe(exercise.seed);
    // The 1 ms exercise horizon grows to cover the ping probe's worst case.
    expect(prepared.until).toBe(1_000_000 + 2 * 2_000_000);
    expect(
      (prepared.actions ?? []).map(
        (action) => (action as { exec: string }).exec,
      ),
    ).toEqual(["ping -c 2 10.0.0.2", "arp -a", "arp -a"]);
  });

  test("records why a ping target cannot be probed", async () => {
    const exercise = exerciseWith([
      { type: "ping", from: "h1", to: "ghost", minReplies: 1 },
    ]);
    const plan = planProbes(exercise, BASE_SCENARIO);
    expect(plan.entries[0]?.command).toBeUndefined();
    const result = await validateExercise(
      exercise,
      prepareScenario(exercise, BASE_SCENARIO),
      () => evidence(),
    );
    expect(result.pass).toBe(false);
    expect(result.checks[0]?.detail).toMatch(/ghost/);
  });

  test("refuses a scenario that does not carry the planned probes", async () => {
    const exercise = exerciseWith([
      { type: "ping", from: "h1", to: "h2", minReplies: 2 },
    ]);
    await expect(
      validateExercise(exercise, BASE_SCENARIO, topologyOracle),
    ).rejects.toThrow(/prepareScenario/);
  });
});

describe("check evaluation", () => {
  test("macTable wants the MAC on the declared port", async () => {
    const exercise = exerciseWith([
      { type: "macTable", switch: "sw1", mac: "02:00:00:00:00:0a", port: "p1" },
    ]);
    const scenario = prepareScenario(exercise, BASE_SCENARIO);

    const ok = await validateExercise(exercise, scenario, () =>
      evidence({ macTables: { sw1: [macRow("02:00:00:00:00:0a", "p1")] } }),
    );
    expect(ok.pass).toBe(true);

    const wrongPort = await validateExercise(exercise, scenario, () =>
      evidence({ macTables: { sw1: [macRow("02:00:00:00:00:0a", "p2")] } }),
    );
    expect(wrongPort.pass).toBe(false);
    expect(wrongPort.checks[0]?.detail).toMatch(/p2/);

    const empty = await validateExercise(exercise, scenario, () =>
      evidence({ macTables: { sw1: [] } }),
    );
    expect(empty.pass).toBe(false);
    expect(empty.checks[0]?.detail).toMatch(/not learned/);
  });

  test("trace counts drops and respects min/max", async () => {
    const exercise = exerciseWith([
      { type: "trace", kind: "frame_drop", maxCount: 0 },
    ]);
    const scenario = prepareScenario(exercise, BASE_SCENARIO);

    expect(
      (
        await validateExercise(exercise, scenario, () =>
          evidence({ traces: [dropTrace("l1", "loss")] }),
        )
      ).pass,
    ).toBe(false);
    expect(
      (await validateExercise(exercise, scenario, () => evidence())).pass,
    ).toBe(true);
  });

  test("route matches destination and interface", async () => {
    const exercise = exerciseWith([
      {
        type: "route",
        router: "r1",
        destination: "10.0.1.0/24",
        iface: "p1",
      },
    ]);
    const scenario = prepareScenario(exercise, BASE_SCENARIO);

    const ok = await validateExercise(exercise, scenario, () =>
      evidence({
        routes: { r1: [{ destination: "10.0.1.0/24", iface: "p1" }] },
      }),
    );
    expect(ok.pass).toBe(true);

    const missing = await validateExercise(exercise, scenario, () =>
      evidence({
        routes: { r1: [{ destination: "10.0.0.0/24", iface: "p0" }] },
      }),
    );
    expect(missing.pass).toBe(false);
    expect(missing.checks[0]?.detail).toMatch(/10.0.0.0\/24/);
  });

  test("exec checks exit status and stdout", async () => {
    const exercise = exerciseWith([
      {
        type: "exec",
        host: "h1",
        command: "arp -a",
        expect: { exitOk: true, stdoutMatches: "\\(10\\.0\\.0\\.1\\)" },
      },
    ]);
    const scenario = prepareScenario(exercise, BASE_SCENARIO);

    const ok = await validateExercise(exercise, scenario, () =>
      evidence({
        shellTranscripts: [
          {
            host: "h1",
            command: "arp -a",
            lines: ["? (10.0.0.1) at 02:00:00:00:00:0b [ether] on eth0"],
          },
        ],
      }),
    );
    expect(ok.pass).toBe(true);

    const mismatch = await validateExercise(exercise, scenario, () =>
      evidence({
        shellTranscripts: [{ host: "h1", command: "arp -a", lines: [] }],
      }),
    );
    expect(mismatch.pass).toBe(false);
    expect(mismatch.checks[0]?.detail).toMatch(/does not match/);

    const failed = await validateExercise(exercise, scenario, () =>
      evidence({
        shellTranscripts: [{ host: "h1", command: "arp -a", error: "boom" }],
      }),
    );
    expect(failed.pass).toBe(false);
    expect(failed.checks[0]?.detail).toMatch(/boom/);
  });

  test("arp reads the neighbor snapshot", async () => {
    const exercise = exerciseWith([
      { type: "arp", host: "h1", ip: "10.0.0.2", mac: "02:00:00:00:00:0b" },
    ]);
    const scenario = prepareScenario(exercise, BASE_SCENARIO);

    const ok = await validateExercise(exercise, scenario, () =>
      evidence({
        shellTranscripts: [
          {
            host: "h1",
            command: "arp -a",
            lines: ["? (10.0.0.2) at 02:00:00:00:00:0b [ether] on eth0"],
          },
        ],
      }),
    );
    expect(ok.pass).toBe(true);

    const missing = await validateExercise(exercise, scenario, () =>
      evidence({
        shellTranscripts: [{ host: "h1", command: "arp -a", lines: [] }],
      }),
    );
    expect(missing.pass).toBe(false);
    expect(missing.checks[0]?.detail).toMatch(/no ARP entry/);
  });

  test("ping counts replies from the statistics line", async () => {
    const exercise = exerciseWith([
      { type: "ping", from: "h1", to: "h2", minReplies: 2 },
    ]);
    const scenario = prepareScenario(exercise, BASE_SCENARIO);
    const command = "ping -c 2 10.0.0.2";

    const ok = await validateExercise(exercise, scenario, () =>
      evidence({ shellTranscripts: [pingOutput("h1", command, 2, 2)] }),
    );
    expect(ok.pass).toBe(true);

    const partial = await validateExercise(exercise, scenario, () =>
      evidence({ shellTranscripts: [pingOutput("h1", command, 2, 1)] }),
    );
    expect(partial.pass).toBe(false);

    const unreachable = await validateExercise(exercise, scenario, () =>
      evidence({
        shellTranscripts: [
          { host: "h1", command, error: "no gateway configured" },
        ],
      }),
    );
    expect(unreachable.pass).toBe(false);
    expect(unreachable.checks[0]?.detail).toMatch(/no gateway configured/);
  });
});

describe("example validators", () => {
  for (const example of exerciseExamples) {
    test(`${example.exercise.id}: the reference solution passes`, async () => {
      const prepared = prepareScenario(example.exercise, example.solution);
      const result = await validateExercise(
        example.exercise,
        prepared,
        topologyOracle,
      );
      expect(result.checks.filter((check) => !check.pass)).toEqual([]);
      expect(result.pass).toBe(true);
      expect(result.run.seed).toBe(example.exercise.seed);
    });

    test(`${example.exercise.id}: the trap solution fails`, async () => {
      const prepared = prepareScenario(example.exercise, example.trap);
      const result = await validateExercise(
        example.exercise,
        prepared,
        topologyOracle,
      );
      expect(result.checks.some((check) => !check.pass)).toBe(true);
      expect(result.pass).toBe(false);
    });
  }

  test("the same seed and solution replay the same result", async () => {
    const example = exerciseExamples[0];
    if (example === undefined) {
      throw new Error("no examples");
    }
    const once = await validateExercise(
      example.exercise,
      prepareScenario(example.exercise, example.solution),
      topologyOracle,
    );
    const twice = await validateExercise(
      example.exercise,
      prepareScenario(example.exercise, example.solution),
      topologyOracle,
    );
    expect(twice).toEqual(once);
  });
});
