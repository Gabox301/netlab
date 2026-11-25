/**
 * Exercise validators (F-112).
 *
 * A check is a pure predicate over the *evidence* of one deterministic run —
 * traces, tables and shell transcripts — never over the configuration the
 * student typed, so "configured but unreachable" cannot pass.
 *
 * The runner is injected (`ScenarioRunner`) because this package sits below
 * `@netlab/cli` (ADR-001). The CLI passes its `runScenario`, this package
 * nothing of the sort: `RunEvidence` is the structural slice the checks read.
 *
 * Probe synthesis is plan-first: `planProbes()` derives one shell action per
 * `ping`/`exec`/`arp` check from the exercise and the topology, and
 * `prepareScenario()` appends them to a copy of the solution *before* the
 * single run. `validateExercise()` re-derives the same plan (pure, no clock
 * involved) to match each probe to its transcript, and refuses a scenario that
 * was not prepared, so a forgotten probe is a loud error, not a silent fail.
 */

import type { Trace } from "@netlab/core";
import {
  type CheckDef,
  DEFAULT_UNTIL_US,
  EXERCISE_VERSION,
  type ExerciseJSON,
  parseDurationToUs,
  parseExerciseJson,
  type ScenarioLike,
  type ScenarioShellActionLike,
} from "./schema";

/** One MAC-table row as the checks read it (a core `MacTableEntry` fits). */
export interface MacRowLike {
  mac: { toString(): string };
  port: string;
  vlan?: number | undefined;
  expiresAt?: number | undefined;
}

/** One routing-table row as the checks read it (a CLI `RouterTableRow` fits). */
export interface RouteRowLike {
  destination: string;
  gateway?: string | undefined;
  iface: string;
  metric?: number | undefined;
  kind?: string | undefined;
}

/** One shell transcript as the checks read it (the CLI's fits). */
export interface ShellTranscriptLike {
  host: string;
  command: string;
  lines?: ReadonlyArray<string> | undefined;
  error?: string | undefined;
}

/** Everything a check is allowed to look at after the run. */
export interface RunEvidence {
  traces: ReadonlyArray<Trace>;
  macTables: Readonly<Record<string, ReadonlyArray<MacRowLike>>>;
  routes: Readonly<Record<string, ReadonlyArray<RouteRowLike>>>;
  shellTranscripts: ReadonlyArray<ShellTranscriptLike>;
  seed: number;
  finalTime: number;
  processed: number;
}

/** Injected simulator: the CLI passes its `runScenario`. */
export type ScenarioRunner = (
  scenario: ScenarioLike,
) => RunEvidence | Promise<RunEvidence>;

/** Outcome of one declarative check. */
export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** Run summary echoed back to the caller. */
export interface RunSummary {
  seed: number;
  finalTime: number;
  processed: number;
}

/** Final verdict of an exercise attempt. */
export interface ExerciseValidationResult {
  pass: boolean;
  checks: Array<CheckResult>;
  run: RunSummary;
}

/** One probe a check needs, derived from the exercise before the run. */
export interface ProbePlanEntry {
  /** Index into `exercise.checks`. */
  check: number;
  /** Display name of the check this probe answers. */
  name: string;
  type: "ping" | "exec" | "arp";
  host: string;
  /** Shell command to run; absent when the target cannot be probed. */
  command?: string | undefined;
  /** Why no command could be planned (the check then fails with it). */
  unavailable?: string | undefined;
}

/** Probes to append, and the virtual time they start at. */
export interface ProbePlan {
  atUs: number;
  entries: Array<ProbePlanEntry>;
}

/** Virtual time one ping request can burn: one timeout plus one interval. */
const PING_REQUEST_US = 2_000_000;
/** Slack for the run itself once the probes are done. */
const RUN_SLACK_US = 1_000_000;

/** Default display name of a check, stable across runs. */
function checkName(def: CheckDef): string {
  if (def.name !== undefined) {
    return def.name;
  }
  switch (def.type) {
    case "ping":
      return `ping ${def.from} -> ${def.to}`;
    case "exec":
      return `${def.host}$ ${def.command}`;
    case "trace": {
      const where = def.where === undefined ? "" : ` where=${def.where}`;
      const reason = def.reason === undefined ? "" : ` reason=${def.reason}`;
      return `trace ${def.kind}${where}${reason}`;
    }
    case "macTable":
      return `macTable ${def.switch} ${def.mac} -> ${def.port}`;
    case "route":
      return `route ${def.router} ${def.destination}`;
    case "arp":
      return `arp ${def.host} ${def.ip} -> ${def.mac}`;
  }
}

/** Lowercase colon-separated MAC (`02:0:a:...` → `02:00:00:00:00:0a`). */
function normalizeMac(text: string): string {
  const separator = text.includes(":") ? ":" : "-";
  return text
    .split(separator)
    .map((group) => group.toLowerCase().padStart(2, "0"))
    .join(":");
}

/** First IPv4 address of a node, with the reason when there is none. */
function nodeAddress(
  scenario: ScenarioLike,
  id: string,
): { ip?: string; reason?: string } {
  const node = scenario.nodes.find((entry) => entry.id === id);
  if (node === undefined) {
    return { reason: `node ${JSON.stringify(id)} is not in the topology` };
  }
  const iface = (node.interfaces ?? []).find((entry) => entry.ip !== undefined);
  const ip = iface?.ip?.split("/")[0];
  if (ip === undefined || ip === "") {
    return { reason: `node ${JSON.stringify(id)} has no IPv4 address` };
  }
  return { ip };
}

/**
 * Derive the probes the checks need. Pure: it reads the exercise and the
 * topology only, so calling it again on the prepared scenario reproduces the
 * same plan (that is how transcripts are matched to checks).
 */
export function planProbes(
  exercise: ExerciseJSON,
  scenario: ScenarioLike,
): ProbePlan {
  let atUs = 0;
  for (const action of scenario.actions ?? []) {
    const at = (action as { at?: number | string | undefined }).at;
    if (at !== undefined) {
      atUs = Math.max(atUs, parseDurationToUs(at, 0, "actions[].at"));
    }
  }
  const entries: Array<ProbePlanEntry> = [];
  exercise.checks.forEach((def, check) => {
    const name = checkName(def);
    if (def.type === "ping") {
      const target = nodeAddress(scenario, def.to);
      if (target.ip === undefined) {
        entries.push({
          check,
          name,
          type: "ping",
          host: def.from,
          unavailable: `cannot ping ${def.to}: ${target.reason ?? "no address"}`,
        });
        return;
      }
      const count = def.count ?? def.minReplies;
      entries.push({
        check,
        name,
        type: "ping",
        host: def.from,
        command: `ping -c ${count} ${target.ip}`,
      });
      return;
    }
    if (def.type === "exec") {
      entries.push({
        check,
        name,
        type: "exec",
        host: def.host,
        command: def.command,
      });
      return;
    }
    if (def.type === "arp") {
      entries.push({
        check,
        name,
        type: "arp",
        host: def.host,
        command: "arp -a",
      });
    }
  });
  return { atUs, entries };
}

/** Shell actions for the probes that could be planned. */
function probeActions(plan: ProbePlan): Array<ScenarioShellActionLike> {
  const actions: Array<ScenarioShellActionLike> = [];
  for (const entry of plan.entries) {
    if (entry.command === undefined) {
      continue;
    }
    actions.push({ at: plan.atUs, host: entry.host, exec: entry.command });
  }
  return actions;
}

/** Horizon that covers the requested run *and* the probes' worst case. */
function horizonUs(
  exercise: ExerciseJSON,
  solution: ScenarioLike,
  plan: ProbePlan,
): number {
  const requested = parseDurationToUs(
    exercise.until ?? solution.until,
    DEFAULT_UNTIL_US,
    "until",
  );
  let budget = RUN_SLACK_US;
  for (const def of exercise.checks) {
    if (def.type === "ping") {
      budget += (def.count ?? def.minReplies) * PING_REQUEST_US;
    }
  }
  return Math.max(requested, plan.atUs + budget);
}

/**
 * Copy the solution with the probes appended, the seed pinned to the
 * exercise's and a horizon that covers them.
 *
 * The copy keeps the caller's scenario shape (`version`, nodes, links), so the
 * CLI can hand the result straight to `runScenario`.
 */
export function prepareScenario(
  exercise: ExerciseJSON,
  solution: ScenarioLike,
): ScenarioLike {
  const plan = planProbes(exercise, solution);
  return {
    ...solution,
    version: solution.version ?? EXERCISE_VERSION,
    seed: exercise.seed,
    until: horizonUs(exercise, solution, plan),
    actions: [...(solution.actions ?? []), ...probeActions(plan)],
  };
}

/**
 * Fail loudly when the probes are missing: without them the checks would read
 * an empty transcript and blame the student for the caller's mistake.
 */
function assertPrepared(
  exercise: ExerciseJSON,
  scenario: ScenarioLike,
  expected: Array<ScenarioShellActionLike>,
): void {
  if (expected.length === 0) {
    return;
  }
  const actions = scenario.actions ?? [];
  const tail = actions.slice(actions.length - expected.length);
  if (JSON.stringify(tail) !== JSON.stringify(expected)) {
    throw new Error(
      `validateExercise: exercise ${JSON.stringify(exercise.id)} needs its probes appended before the run; call prepareScenario(exercise, solution) first`,
    );
  }
}

/** FIFO queues of transcripts per `host` + `command`, in scheduling order. */
function transcriptQueues(
  transcripts: ReadonlyArray<ShellTranscriptLike>,
): Map<string, Array<ShellTranscriptLike>> {
  const queues = new Map<string, Array<ShellTranscriptLike>>();
  for (const transcript of transcripts) {
    const key = `${transcript.host}\u0000${transcript.command}`;
    const queue = queues.get(key);
    if (queue === undefined) {
      queues.set(key, [transcript]);
    } else {
      queue.push(transcript);
    }
  }
  return queues;
}

/** One line, bounded length: details end up in JSON and in the terminal. */
function brief(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s*\n\s*/g, " | ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

const PING_STATS = /(\d+) packets transmitted, (\d+) received/;
const ARP_LINE = /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-f:]{17})/i;

interface EvaluationContext {
  evidence: RunEvidence;
  takeTranscript: (
    host: string,
    command: string,
  ) => ShellTranscriptLike | undefined;
}

interface Outcome {
  pass: boolean;
  detail: string;
}

function evaluatePing(
  def: Extract<CheckDef, { type: "ping" }>,
  probe: ProbePlanEntry | undefined,
  ctx: EvaluationContext,
): Outcome {
  if (probe === undefined || probe.command === undefined) {
    return {
      pass: false,
      detail: probe?.unavailable ?? "no ping probe was planned for this check",
    };
  }
  const transcript = ctx.takeTranscript(probe.host, probe.command);
  if (transcript === undefined) {
    return { pass: false, detail: `no transcript for ${probe.command}` };
  }
  if (transcript.error !== undefined) {
    return {
      pass: false,
      detail: `no reply from ${def.to}: ${brief(transcript.error)}`,
    };
  }
  const match = PING_STATS.exec((transcript.lines ?? []).join("\n"));
  if (match === null) {
    return {
      pass: false,
      detail: `cannot read the ping statistics: ${brief((transcript.lines ?? []).join(" ")) || "(empty)"}`,
    };
  }
  const received = Number(match[2]);
  return {
    pass: received >= def.minReplies,
    detail: `${received}/${def.minReplies} replies`,
  };
}

function evaluateExec(
  def: Extract<CheckDef, { type: "exec" }>,
  probe: ProbePlanEntry | undefined,
  ctx: EvaluationContext,
): Outcome {
  const command = probe?.command ?? def.command;
  const transcript = ctx.takeTranscript(def.host, command);
  if (transcript === undefined) {
    return { pass: false, detail: `no transcript for ${command}` };
  }
  const wantExitOk = def.expect.exitOk ?? true;
  const exitOk = transcript.error === undefined;
  if (exitOk !== wantExitOk) {
    return {
      pass: false,
      detail: exitOk
        ? "the command exited 0 but had to fail"
        : `the command failed: ${brief(transcript.error)}`,
    };
  }
  const pattern = def.expect.stdoutMatches;
  if (pattern === undefined) {
    return {
      pass: true,
      detail: exitOk
        ? "exited 0"
        : `failed as expected: ${brief(transcript.error)}`,
    };
  }
  const stdout = (transcript.lines ?? []).join("\n");
  if (!new RegExp(pattern).test(stdout)) {
    return {
      pass: false,
      detail: `stdout does not match /${pattern}/: ${brief(stdout) || "(empty)"}`,
    };
  }
  return { pass: true, detail: `stdout matches /${pattern}/` };
}

function evaluateTrace(
  def: Extract<CheckDef, { type: "trace" }>,
  ctx: EvaluationContext,
): Outcome {
  const min = def.minCount ?? 0;
  const max = def.maxCount ?? Number.POSITIVE_INFINITY;
  let count = 0;
  for (const trace of ctx.evidence.traces) {
    if (trace.kind !== def.kind) {
      continue;
    }
    if (
      trace.kind === "frame_drop" &&
      ((def.where !== undefined && trace.where !== def.where) ||
        (def.reason !== undefined && trace.reason !== def.reason))
    ) {
      continue;
    }
    count += 1;
  }
  const want = `${min}..${max === Number.POSITIVE_INFINITY ? "inf" : max}`;
  return {
    pass: count >= min && count <= max,
    detail: `${count} matching trace(s), want ${want}`,
  };
}

function evaluateMacTable(
  def: Extract<CheckDef, { type: "macTable" }>,
  ctx: EvaluationContext,
): Outcome {
  const rows = ctx.evidence.macTables[def.switch];
  if (rows === undefined) {
    return {
      pass: false,
      detail: `no MAC table for switch ${JSON.stringify(def.switch)}`,
    };
  }
  const want = normalizeMac(def.mac);
  const row = rows.find((entry) => entry.mac.toString() === want);
  if (row === undefined) {
    const seen = rows.map((entry) => `${entry.mac.toString()}->${entry.port}`);
    return {
      pass: false,
      detail: `${want} not learned (table: ${seen.join(", ") || "empty"})`,
    };
  }
  if (row.port !== def.port) {
    return {
      pass: false,
      detail: `${want} learned on ${row.port}, want ${def.port}`,
    };
  }
  return { pass: true, detail: `${want} -> ${def.port}` };
}

function evaluateRoute(
  def: Extract<CheckDef, { type: "route" }>,
  ctx: EvaluationContext,
): Outcome {
  const rows = ctx.evidence.routes[def.router] ?? [];
  const row = rows.find(
    (entry) =>
      entry.destination === def.destination &&
      (def.gateway === undefined || entry.gateway === def.gateway) &&
      (def.iface === undefined || entry.iface === def.iface),
  );
  if (row === undefined) {
    const seen = rows.map((entry) => entry.destination);
    const via = def.iface === undefined ? "" : ` on ${def.iface}`;
    return {
      pass: false,
      detail: `no ${def.destination} route${via} (have: ${seen.join(", ") || "none"})`,
    };
  }
  const gateway =
    row.gateway === undefined ? "connected" : `via ${row.gateway}`;
  return {
    pass: true,
    detail: `${row.destination} ${gateway} dev ${row.iface}`,
  };
}

function evaluateArp(
  def: Extract<CheckDef, { type: "arp" }>,
  probe: ProbePlanEntry | undefined,
  ctx: EvaluationContext,
): Outcome {
  const command = probe?.command ?? "arp -a";
  const transcript = ctx.takeTranscript(def.host, command);
  if (transcript === undefined) {
    return { pass: false, detail: `no transcript for ${command}` };
  }
  const entries: Array<{ ip: string; mac: string }> = [];
  for (const line of transcript.lines ?? []) {
    const match = ARP_LINE.exec(line);
    if (match !== null) {
      entries.push({
        ip: match[1] as string,
        mac: normalizeMac(match[2] as string),
      });
    }
  }
  const want = normalizeMac(def.mac);
  const entry = entries.find((candidate) => candidate.ip === def.ip);
  if (entry === undefined) {
    const seen = entries.map(
      (candidate) => `${candidate.ip}->${candidate.mac}`,
    );
    return {
      pass: false,
      detail: `no ARP entry for ${def.ip} on ${def.host} (seen: ${seen.join(", ") || brief(transcript.error) || "none"})`,
    };
  }
  return {
    pass: entry.mac === want,
    detail: `${def.ip} at ${entry.mac}${entry.mac === want ? "" : `, want ${want}`}`,
  };
}

function evaluateCheck(
  def: CheckDef,
  probe: ProbePlanEntry | undefined,
  ctx: EvaluationContext,
): CheckResult {
  let outcome: Outcome;
  switch (def.type) {
    case "ping":
      outcome = evaluatePing(def, probe, ctx);
      break;
    case "exec":
      outcome = evaluateExec(def, probe, ctx);
      break;
    case "trace":
      outcome = evaluateTrace(def, ctx);
      break;
    case "macTable":
      outcome = evaluateMacTable(def, ctx);
      break;
    case "route":
      outcome = evaluateRoute(def, ctx);
      break;
    case "arp":
      outcome = evaluateArp(def, probe, ctx);
      break;
  }
  return { name: checkName(def), pass: outcome.pass, detail: outcome.detail };
}

/**
 * Run the prepared scenario once and evaluate every check against the result.
 *
 * The runner is awaited exactly once: checks never re-run the simulation, so
 * two checks that look at the same clock see the same clock.
 */
export async function validateExercise(
  exercise: ExerciseJSON,
  scenario: ScenarioLike,
  run: ScenarioRunner,
): Promise<ExerciseValidationResult> {
  const plan = planProbes(exercise, scenario);
  assertPrepared(exercise, scenario, probeActions(plan));
  const evidence = await run(scenario);
  const queues = transcriptQueues(evidence.shellTranscripts);
  const takeTranscript = (
    host: string,
    command: string,
  ): ShellTranscriptLike | undefined =>
    queues.get(`${host}\u0000${command}`)?.shift();
  const ctx: EvaluationContext = { evidence, takeTranscript };
  const probes = new Map(plan.entries.map((entry) => [entry.check, entry]));
  const checks = exercise.checks.map((def, index) =>
    evaluateCheck(def, probes.get(index), ctx),
  );
  return {
    pass: checks.every((check) => check.pass),
    checks,
    run: {
      seed: evidence.seed,
      finalTime: evidence.finalTime,
      processed: evidence.processed,
    },
  };
}

/** One authored exercise plus the solution that passes it and a trap. */
export interface ExerciseExample {
  exercise: ExerciseJSON;
  solution: ScenarioLike;
  trap: ScenarioLike;
}

/**
 * F-112 example: the switch must learn h1's MAC on the port h1 is wired to.
 *
 * The reference solution cables h1 into `p1` and generates one frame; the trap
 * cables it into `p2`, which is configuration-identical and connectivity-clean
 * but learns the MAC on the wrong port.
 */
export const macLearningExample: ExerciseExample = {
  exercise: parseExerciseJson({
    version: 1,
    id: "l2-mac-learning",
    title: "MAC learning",
    kind: "construir",
    objective:
      "Cableá h1 al puerto p1 de sw1, enviá un frame y verificá que sw1 aprenda su MAC en ese puerto.",
    seed: 0,
    until: "1ms",
    base: {
      version: 1,
      seed: 0,
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
      links: [],
      actions: [],
    },
    hints: [
      {
        level: 1,
        text: "El puerto del switch es el extremo del cable, no la interfaz del host.",
        penalty: 5,
      },
      {
        level: 2,
        text: "Sin tráfico no hay aprendizaje: el frame de h1 es lo que llena la tabla.",
        penalty: 15,
      },
    ],
    checks: [
      {
        type: "macTable",
        name: "h1 MAC learned on the port it is plugged into",
        switch: "sw1",
        mac: "02:00:00:00:00:0a",
        port: "p1",
      },
    ],
  }),
  solution: {
    version: 1,
    seed: 0,
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
    actions: [
      {
        at: 0,
        host: "h1",
        iface: "eth0",
        destIp: "10.0.0.2",
        payload: "hola",
      },
    ],
  },
  trap: {
    version: 1,
    seed: 0,
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
        b: { node: "sw1", iface: "p2" },
        params: { latencyUs: 10 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "sw1", iface: "p1" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [
      {
        at: 0,
        host: "h1",
        iface: "eth0",
        destIp: "10.0.0.2",
        payload: "hola",
      },
    ],
  },
};

/**
 * F-112 example: end-to-end reachability across a router.
 *
 * The trap is the classic "IP without gateway" solution: h1 is addressed
 * correctly and its cable is fine, but with no default gateway it cannot reach
 * the other subnet, so the probe gets zero replies.
 */
export const pingGatewayExample: ExerciseExample = {
  exercise: parseExerciseJson({
    version: 1,
    id: "ip-gateway-ping",
    title: "Default gateway",
    kind: "configurar",
    objective:
      "Configurá h1 para que alcance 10.0.1.2 a través de r1 y verificalo con ping.",
    seed: 0,
    until: "6s",
    base: {
      version: 1,
      seed: 0,
      nodes: [
        {
          type: "host",
          id: "h1",
          interfaces: [
            {
              name: "eth0",
              mac: "02:00:00:00:00:11",
              ip: "10.0.0.2",
              mask: "255.255.255.0",
            },
          ],
        },
        {
          type: "router",
          id: "r1",
          interfaces: [
            { name: "p0", ip: "10.0.0.1", mask: "255.255.255.0" },
            { name: "p1", ip: "10.0.1.1", mask: "255.255.255.0" },
          ],
        },
        {
          type: "host",
          id: "h2",
          interfaces: [
            {
              name: "eth0",
              mac: "02:00:00:00:00:12",
              ip: "10.0.1.2",
              mask: "255.255.255.0",
              gateway: "10.0.1.1",
            },
          ],
        },
      ],
      links: [
        {
          id: "l1",
          a: { node: "h1", iface: "eth0" },
          b: { node: "r1", iface: "p0" },
          params: { latencyUs: 10 },
        },
        {
          id: "l2",
          a: { node: "h2", iface: "eth0" },
          b: { node: "r1", iface: "p1" },
          params: { latencyUs: 10 },
        },
      ],
      actions: [],
    },
    hints: [
      {
        level: 1,
        text: "10.0.1.2 no está en la subred de h1: necesitás un next hop.",
        penalty: 5,
      },
      {
        level: 2,
        text: "h1 tiene que apuntar al extremo de r1 en su subred.",
        penalty: 15,
      },
    ],
    checks: [
      {
        type: "ping",
        name: "h1 reaches h2 across r1",
        from: "h1",
        to: "h2",
        minReplies: 2,
      },
    ],
  }),
  solution: {
    version: 1,
    seed: 0,
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:11",
            ip: "10.0.0.2",
            mask: "255.255.255.0",
            gateway: "10.0.0.1",
          },
        ],
      },
      {
        type: "router",
        id: "r1",
        interfaces: [
          { name: "p0", ip: "10.0.0.1", mask: "255.255.255.0" },
          { name: "p1", ip: "10.0.1.1", mask: "255.255.255.0" },
        ],
      },
      {
        type: "host",
        id: "h2",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:12",
            ip: "10.0.1.2",
            mask: "255.255.255.0",
            gateway: "10.0.1.1",
          },
        ],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "r1", iface: "p0" },
        params: { latencyUs: 10 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "r1", iface: "p1" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [],
  },
  trap: {
    version: 1,
    seed: 0,
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:11",
            ip: "10.0.0.2",
            mask: "255.255.255.0",
          },
        ],
      },
      {
        type: "router",
        id: "r1",
        interfaces: [
          { name: "p0", ip: "10.0.0.1", mask: "255.255.255.0" },
          { name: "p1", ip: "10.0.1.1", mask: "255.255.255.0" },
        ],
      },
      {
        type: "host",
        id: "h2",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:12",
            ip: "10.0.1.2",
            mask: "255.255.255.0",
            gateway: "10.0.1.1",
          },
        ],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "r1", iface: "p0" },
        params: { latencyUs: 10 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "r1", iface: "p1" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [],
  },
};

/**
 * F-112 example: a clean path *and* the route that makes it work.
 *
 * The base links drop everything in one direction; the reference cures the
 * link. The trap leaves the lossy link in place: the route check passes, the
 * drop check does not, so the attempt fails.
 */
export const routingExample: ExerciseExample = {
  exercise: parseExerciseJson({
    version: 1,
    id: "routing-clean-path",
    title: "Clean routed path",
    kind: "diagnosticar",
    objective:
      "Encontrá por qué el tráfico hacia 10.0.1.2 se pierde y dejá el camino limpio sin tocar el ruteo.",
    seed: 0,
    until: "3s",
    base: {
      version: 1,
      seed: 0,
      nodes: [
        {
          type: "host",
          id: "h1",
          interfaces: [
            {
              name: "eth0",
              mac: "02:00:00:00:00:21",
              ip: "10.0.0.2",
              mask: "255.255.255.0",
              gateway: "10.0.0.1",
            },
          ],
        },
        {
          type: "router",
          id: "r1",
          interfaces: [
            { name: "p0", ip: "10.0.0.1", mask: "255.255.255.0" },
            { name: "p1", ip: "10.0.1.1", mask: "255.255.255.0" },
          ],
        },
        {
          type: "host",
          id: "h2",
          interfaces: [
            {
              name: "eth0",
              mac: "02:00:00:00:00:22",
              ip: "10.0.1.2",
              mask: "255.255.255.0",
              gateway: "10.0.1.1",
            },
          ],
        },
      ],
      links: [
        {
          id: "l1",
          a: { node: "h1", iface: "eth0" },
          b: { node: "r1", iface: "p0" },
          params: { latencyUs: 10, lossRate: 1 },
        },
        {
          id: "l2",
          a: { node: "h2", iface: "eth0" },
          b: { node: "r1", iface: "p1" },
          params: { latencyUs: 10 },
        },
      ],
      actions: [
        {
          at: 0,
          host: "h1",
          destIp: "10.0.1.2",
          ping: { count: 2, size: 32, interval: "1ms" },
        },
      ],
    },
    hints: [
      {
        level: 1,
        text: "El ruteo está bien: mirá las trazas, no la tabla.",
        penalty: 5,
      },
      {
        level: 2,
        text: "Un enlace con pérdida del 100% explica todo.",
        penalty: 20,
      },
    ],
    checks: [
      {
        type: "trace",
        name: "no frames dropped",
        kind: "frame_drop",
        minCount: 0,
        maxCount: 0,
      },
      {
        type: "route",
        name: "r1 routes 10.0.1.0/24 directly out p1",
        router: "r1",
        destination: "10.0.1.0/24",
        iface: "p1",
      },
    ],
  }),
  solution: {
    version: 1,
    seed: 0,
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:21",
            ip: "10.0.0.2",
            mask: "255.255.255.0",
            gateway: "10.0.0.1",
          },
        ],
      },
      {
        type: "router",
        id: "r1",
        interfaces: [
          { name: "p0", ip: "10.0.0.1", mask: "255.255.255.0" },
          { name: "p1", ip: "10.0.1.1", mask: "255.255.255.0" },
        ],
      },
      {
        type: "host",
        id: "h2",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:22",
            ip: "10.0.1.2",
            mask: "255.255.255.0",
            gateway: "10.0.1.1",
          },
        ],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "r1", iface: "p0" },
        params: { latencyUs: 10 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "r1", iface: "p1" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [
      {
        at: 0,
        host: "h1",
        destIp: "10.0.1.2",
        ping: { count: 2, size: 32, interval: "1ms" },
      },
    ],
  },
  trap: {
    version: 1,
    seed: 0,
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:21",
            ip: "10.0.0.2",
            mask: "255.255.255.0",
            gateway: "10.0.0.1",
          },
        ],
      },
      {
        type: "router",
        id: "r1",
        interfaces: [
          { name: "p0", ip: "10.0.0.1", mask: "255.255.255.0" },
          { name: "p1", ip: "10.0.1.1", mask: "255.255.255.0" },
        ],
      },
      {
        type: "host",
        id: "h2",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:22",
            ip: "10.0.1.2",
            mask: "255.255.255.0",
            gateway: "10.0.1.1",
          },
        ],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "r1", iface: "p0" },
        params: { latencyUs: 10, lossRate: 1 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "r1", iface: "p1" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [
      {
        at: 0,
        host: "h1",
        destIp: "10.0.1.2",
        ping: { count: 2, size: 32, interval: "1ms" },
      },
    ],
  },
};

/** The three example exercises, in documentation order. */
export const exerciseExamples: ReadonlyArray<ExerciseExample> = [
  macLearningExample,
  pingGatewayExample,
  routingExample,
];
