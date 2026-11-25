/**
 * `netlab run --snapshot-out` and `netlab replay` end to end (F-98, F-99).
 *
 * A recording is the deterministic run saved: the scenario, the seed, the
 * horizon and the whole result (traces as hex, MAC/routing tables, shell
 * transcripts). Replay therefore never simulates: it loads the recording and
 * scrubs it. `--until` cuts the traces at T, `--break-on-packet` stops at the
 * first frame the filter matches and `--break-on-tcp` stops when the wire
 * proves a TCP state — the tests pin the exact trace each one lands on.
 *
 * The expectations are computed from the recording itself (hex → Ethernet →
 * IPv4/TCP with `@netlab/protocols`), never from the CLI's own matcher, so a
 * regression in either side shows up as a mismatch.
 *
 * Fixtures live under the OS temp dir, like the pcap and validate suites: the
 * commands go through the same file reads and writes the `netlab` bin uses.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ETHERTYPE_IPV4,
  IPV4_PROTOCOL_ICMP,
  IPV4_PROTOCOL_TCP,
  parseEthernet,
  parseIpv4,
  parseTcp,
} from "@netlab/protocols";
import { main } from "../src/main";
import { RECORDING_VERSION } from "../src/replay";

const FIXTURES = join(tmpdir(), "netlab-replay-fixtures");

/** Two hosts behind a switch: ARP, then two echo requests. */
const ICMP_SCENARIO = JSON.stringify(
  {
    version: 1,
    seed: 7,
    until: "50ms",
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
      {
        type: "switch",
        id: "sw1",
        ports: [{ name: "p1" }, { name: "p2" }],
      },
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
    actions: [
      {
        at: "5ms",
        host: "h1",
        destIp: "10.0.0.2",
        ping: { count: 2, size: 32, interval: "1ms" },
      },
    ],
  },
  null,
  2,
);

/** Two hosts behind a hub: an HTTP server and the client that greets it. */
const TCP_SCENARIO = JSON.stringify(
  {
    version: 1,
    seed: 7,
    until: "4s",
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
      {
        type: "hub",
        id: "hub1",
        ports: [{ name: "p1" }, { name: "p2" }],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "hub1", iface: "p1" },
        params: { latencyUs: 1000 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "hub1", iface: "p2" },
        params: { latencyUs: 1000 },
      },
    ],
    actions: [
      { at: 0, host: "h2", exec: "http-server 80" },
      { at: "100ms", host: "h1", exec: "nc 10.0.0.2 80" },
    ],
  },
  null,
  2,
);

type StdoutWrite = typeof process.stdout.write;

function collector(sink: Array<string>): StdoutWrite {
  return ((chunk: string | Uint8Array) => {
    sink.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as unknown as StdoutWrite;
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the entrypoint in-process with its output captured. */
async function withCapturedOutput(
  run: () => Promise<number>,
): Promise<Captured> {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = collector(stdout);
  process.stderr.write = collector(stderr);
  try {
    const code = await run();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function captureMain(argv: Array<string>): Promise<Captured> {
  return withCapturedOutput(() => main(argv));
}

async function fixture(name: string, text: string): Promise<string> {
  await mkdir(FIXTURES, { recursive: true });
  const file = join(FIXTURES, name);
  await writeFile(file, text, "utf8");
  return file;
}

/** One decoded JSON trace line, straight from the CLI's output. */
interface JsonTrace {
  t: number;
  kind: string;
  link: string;
  from?: "a" | "b";
  to?: "a" | "b";
  frame: string;
}

function jsonTraces(stdout: string): Array<JsonTrace> {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonTrace);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The IPv4 header of a frame, or undefined when it is not plain IPv4. */
function ipv4Of(trace: JsonTrace): { protocol: number } | undefined {
  if (trace.kind !== "frame_tx" && trace.kind !== "frame_rx") {
    return undefined;
  }
  const ethernet = parseEthernet(hexToBytes(trace.frame));
  if (!ethernet.ok || ethernet.value.etherType !== ETHERTYPE_IPV4) {
    return undefined;
  }
  const ipv4 = parseIpv4(ethernet.value.payload);
  return ipv4.ok ? ipv4.value.header : undefined;
}

/** The first `frame_tx` ICMP packet the recording holds. */
function firstIcmpTx(stdout: string): JsonTrace {
  for (const trace of jsonTraces(stdout)) {
    if (trace.kind !== "frame_tx") {
      continue;
    }
    if (ipv4Of(trace)?.protocol === IPV4_PROTOCOL_ICMP) {
      return trace;
    }
  }
  throw new Error("the recording carries no ICMP frame_tx trace");
}

interface TcpProbe {
  t: number;
  link: string;
  flags: { syn: boolean; ack: boolean; fin: boolean; rst: boolean };
}

/** Every `frame_tx` TCP segment, in recording order, decoded from the bytes. */
function tcpProbes(stdout: string): Array<TcpProbe> {
  const probes: Array<TcpProbe> = [];
  for (const trace of jsonTraces(stdout)) {
    if (trace.kind !== "frame_tx") {
      continue;
    }
    const ethernet = parseEthernet(hexToBytes(trace.frame));
    if (!ethernet.ok || ethernet.value.etherType !== ETHERTYPE_IPV4) {
      continue;
    }
    const ipv4 = parseIpv4(ethernet.value.payload);
    if (!ipv4.ok || ipv4.value.header.protocol !== IPV4_PROTOCOL_TCP) {
      continue;
    }
    const tcp = parseTcp(ipv4.value.payload);
    if (!tcp.ok) {
      continue;
    }
    probes.push({ t: trace.t, link: trace.link, flags: tcp.value.flags });
  }
  return probes;
}

/**
 * The segment that completes the three-way handshake: the first plain ACK
 * after the SYN and the SYN+ACK. That is the wire's proof of ESTABLISHED.
 */
function handshakeAck(stdout: string): TcpProbe {
  const probes = tcpProbes(stdout);
  let sawSyn = false;
  let sawSynAck = false;
  for (const probe of probes) {
    if (probe.flags.syn && !probe.flags.ack) {
      sawSyn = true;
      continue;
    }
    if (sawSyn && probe.flags.syn && probe.flags.ack) {
      sawSynAck = true;
      continue;
    }
    if (sawSynAck && probe.flags.ack && !probe.flags.syn) {
      return probe;
    }
  }
  throw new Error("the recording carries no completed TCP handshake");
}

async function record(
  scenarioText: string,
  scenarioName: string,
  recordingName: string,
): Promise<string> {
  const scenario = await fixture(scenarioName, scenarioText);
  const recording = join(FIXTURES, recordingName);
  const recorded = await captureMain([
    "run",
    scenario,
    "--format",
    "json",
    "--snapshot-out",
    recording,
  ]);
  expect(recorded.code).toBe(0);
  return recording;
}

describe("netlab run --snapshot-out", () => {
  test("writes a versioned recording next to the normal output", async () => {
    const scenario = await fixture("snapshot-icmp.json", ICMP_SCENARIO);
    const recording = join(FIXTURES, "snapshot-icmp.grab.json");
    const recorded = await captureMain([
      "run",
      scenario,
      "--format",
      "json",
      "--snapshot-out",
      recording,
    ]);
    expect(recorded.code).toBe(0);
    // The normal output is untouched by the extra file.
    expect(recorded.stdout.length).toBeGreaterThan(0);
    expect(recorded.stderr).toContain("macTables");

    const saved = JSON.parse(await readFile(recording, "utf8")) as {
      version: number;
      seed: number;
      untilUs: number;
      scenario: { version: number };
      traces: Array<unknown>;
      summary: { macTables: Record<string, Array<unknown>> };
    };
    expect(saved.version).toBe(RECORDING_VERSION);
    expect(saved.seed).toBe(7);
    expect(saved.untilUs).toBe(50_000);
    expect(saved.scenario.version).toBe(1);
    expect(saved.traces.length).toBeGreaterThan(0);
    // The switch learned where the hosts live: the tables travel too.
    expect(Object.keys(saved.summary.macTables)).toContain("sw1");
  });

  test("needs a file after --snapshot-out", async () => {
    const scenario = await fixture(
      "snapshot-missing-value.json",
      ICMP_SCENARIO,
    );
    const out = await captureMain(["run", scenario, "--snapshot-out"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--snapshot-out");
  });
});

describe("netlab replay", () => {
  test("a snapshot replays the same packets, byte for byte", async () => {
    const recording = await record(
      ICMP_SCENARIO,
      "replay-icmp.json",
      "replay-icmp.grab.json",
    );
    const scenario = join(FIXTURES, "replay-icmp.json");
    const recorded = await captureMain(["run", scenario, "--format", "json"]);
    const replayed = await captureMain([
      "replay",
      recording,
      "--format",
      "json",
    ]);
    expect(replayed.code).toBe(0);
    expect(replayed.stdout).toBe(recorded.stdout);
    expect(replayed.stderr).toBe(recorded.stderr);
    expect(jsonTraces(replayed.stdout).length).toBe(
      jsonTraces(recorded.stdout).length,
    );
  });

  test("the human report is identical too", async () => {
    const recording = await record(
      ICMP_SCENARIO,
      "replay-human.json",
      "replay-human.grab.json",
    );
    const recorded = await captureMain([
      "run",
      join(FIXTURES, "replay-human.json"),
    ]);
    const replayed = await captureMain(["replay", recording]);
    expect(replayed.code).toBe(0);
    expect(replayed.stdout).toBe(recorded.stdout);
    expect(replayed.stdout).toContain("MAC tables:");
  });

  test("--until cuts the recorded traces at T and nothing else", async () => {
    const recording = await record(
      ICMP_SCENARIO,
      "replay-until.json",
      "replay-until.grab.json",
    );
    const full = await captureMain(["replay", recording, "--format", "json"]);
    const cut = await captureMain([
      "replay",
      recording,
      "--format",
      "json",
      "--until",
      "5500us",
    ]);
    expect(cut.code).toBe(0);
    const fullTraces = jsonTraces(full.stdout);
    const cutTraces = jsonTraces(cut.stdout);
    expect(cutTraces.length).toBeGreaterThan(0);
    expect(cutTraces.length).toBeLessThan(fullTraces.length);
    for (const trace of cutTraces) {
      expect(trace.t).toBeLessThanOrEqual(5_500);
    }
    const expected = fullTraces.filter((trace) => trace.t <= 5_500);
    expect(cut.stdout).toBe(
      `${expected.map((trace) => JSON.stringify(trace)).join("\n")}\n`,
    );

    const human = await captureMain(["replay", recording, "--until", "5500us"]);
    // The report is honest about the cut: the horizon is the one asked for.
    expect(human.stdout).toContain("final t=5500us");
    expect(human.stdout).toContain("MAC tables:");
  });

  test("replay never simulates: a broken scenario still replays", async () => {
    const recording = await record(
      ICMP_SCENARIO,
      "replay-nosim.json",
      "replay-nosim.grab.json",
    );
    const before = await captureMain(["replay", recording, "--format", "json"]);
    const saved = JSON.parse(await readFile(recording, "utf8")) as {
      scenario: { links: Array<{ a: { node: string } }> };
    };
    const link = saved.scenario.links[0];
    if (link === undefined) {
      throw new Error("the recording lost its links");
    }
    link.a.node = "ghost";
    await writeFile(recording, JSON.stringify(saved), "utf8");
    const after = await captureMain(["replay", recording, "--format", "json"]);
    expect(after.code).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  test("break-on-packet stops at the exact packet", async () => {
    const recording = await record(
      ICMP_SCENARIO,
      "replay-break-packet.json",
      "replay-break-packet.grab.json",
    );
    const full = await captureMain(["replay", recording, "--format", "json"]);
    const expected = firstIcmpTx(full.stdout);
    const out = await captureMain([
      "replay",
      recording,
      "--break-on-packet",
      "protocol == icmp && kind == frame_tx",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`break on packet at t=${expected.t}us`);
    expect(out.stdout).toContain("protocol == icmp && kind == frame_tx");
    const evidence = out.stdout
      .split("\n")
      .filter((line) => line.startsWith("["));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toContain(
      `[t=${expected.t}us] TX ${expected.link} from=${expected.from} `,
    );
  });

  test("break-on-tcp stops when the handshake completes", async () => {
    const recording = await record(
      TCP_SCENARIO,
      "replay-break-tcp.json",
      "replay-break-tcp.grab.json",
    );
    const full = await captureMain(["replay", recording, "--format", "json"]);
    const expected = handshakeAck(full.stdout);
    const out = await captureMain([
      "replay",
      recording,
      "--break-on-tcp",
      "ESTABLISHED",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("break on tcp at t=");
    expect(out.stdout).toContain("ESTABLISHED");
    expect(out.stdout).toContain(`t=${expected.t}us`);
    expect(out.stdout).toContain(`TX ${expected.link}`);
    const evidence = out.stdout
      .split("\n")
      .filter((line) => line.startsWith("["));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toContain(`[t=${expected.t}us]`);
  });

  test("a breakpoint without a match runs the whole recording", async () => {
    const recording = await record(
      ICMP_SCENARIO,
      "replay-nomatch.json",
      "replay-nomatch.grab.json",
    );
    const full = await captureMain(["replay", recording]);
    const out = await captureMain([
      "replay",
      recording,
      "--break-on-packet",
      "protocol == udp",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(full.stdout);
    expect(out.stdout).not.toContain("break on");

    const tcp = await captureMain([
      "replay",
      recording,
      "--break-on-tcp",
      "ESTABLISHED",
    ]);
    expect(tcp.code).toBe(0);
    expect(tcp.stdout).toBe(full.stdout);
  });

  test("a corrupt recording is a parse error (2)", async () => {
    const notJson = await fixture("corrupt-json.grab.json", "{ not json");
    const badJson = await captureMain(["replay", notJson]);
    expect(badJson.code).toBe(2);
    expect(badJson.stderr).toContain("recording");

    const wrongVersion = await fixture(
      "corrupt-version.grab.json",
      JSON.stringify({ version: RECORDING_VERSION + 1 }),
    );
    const badVersion = await captureMain(["replay", wrongVersion]);
    expect(badVersion.code).toBe(2);
    expect(badVersion.stderr).toContain("version");

    const badHex = await fixture(
      "corrupt-trace.grab.json",
      JSON.stringify({
        version: RECORDING_VERSION,
        scenario: { version: 1 },
        seed: 1,
        untilUs: 1000,
        finalTime: 0,
        processed: 0,
        traces: [
          {
            t: 0,
            kind: "frame_tx",
            link: "l1",
            from: "a",
            length: 1,
            frame: "abc",
          },
        ],
        summary: { macTables: {}, routes: {}, shell: [] },
      }),
    );
    const badTrace = await captureMain(["replay", badHex]);
    expect(badTrace.code).toBe(2);
    expect(badTrace.stderr).toContain("traces[0].frame");
  });

  test("a missing recording is a read error (1)", async () => {
    const out = await captureMain([
      "replay",
      join(FIXTURES, "does-not-exist.grab.json"),
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("cannot read");
  });

  test("usage errors exit 2 before touching the file", async () => {
    const missing = await captureMain(["replay"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Usage: netlab replay");

    const recording = await record(
      ICMP_SCENARIO,
      "replay-usage.json",
      "replay-usage.grab.json",
    );
    const badField = await captureMain([
      "replay",
      recording,
      "--break-on-packet",
      "bogus == 1",
    ]);
    expect(badField.code).toBe(2);
    expect(badField.stderr).toContain("bogus");

    const badOp = await captureMain([
      "replay",
      recording,
      "--break-on-packet",
      "protocol = icmp",
    ]);
    expect(badOp.code).toBe(2);
    expect(badOp.stderr).toContain("--break-on-packet");

    const badState = await captureMain([
      "replay",
      recording,
      "--break-on-tcp",
      "ESTABLISHED,NOPE",
    ]);
    expect(badState.code).toBe(2);
    expect(badState.stderr).toContain("NOPE");

    const badUntil = await captureMain([
      "replay",
      recording,
      "--until",
      "soon",
    ]);
    expect(badUntil.code).toBe(2);
    expect(badUntil.stderr).toContain("--until");
  });
});
