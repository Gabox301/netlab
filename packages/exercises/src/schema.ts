/**
 * Exercise JSON (v1) for `netlab validate` (F-110, F-111).
 *
 * Hand-written validation in the same style as the CLI's
 * `parseScenarioJson`: no schema library, every error names the offending
 * path (`checks[0].minReplies`), and only the shell is allowed to fail at
 * runtime — a malformed exercise never reaches the simulator.
 *
 * This package sits *below* `@netlab/cli` (ADR-001: the CLI consumes
 * exercises, never the other way round), so the scenario schema is not
 * imported here. `ScenarioLike` is the structural view of a v1 scenario that
 * the CLI's own `Scenario` satisfies; the CLI parses both the base topology
 * and the student solution with its `parseScenarioJson`.
 */

import { MAX_PING_COUNT, parseCommandLine } from "@netlab/shell";

/** Wire format version owned by this slice. */
export const EXERCISE_VERSION = 1;

/** Default exercise horizon when neither the exercise nor the base sets one. */
export const DEFAULT_UNTIL_US = 5_000_000;

/** `until`/`at` as raw microseconds or a duration string (`10s`, `100ms`). */
export type DurationInput = number | string;

/**
 * Structural view of one scenario interface: only what an exercise validator
 * needs to resolve a probe target (the CLI's `ScenarioInterfaceDef` is
 * assignable to it).
 */
export interface ScenarioInterfaceLike {
  name?: string | undefined;
  mac?: string | undefined;
  ip?: string | undefined;
  mask?: string | undefined;
  gateway?: string | undefined;
}

/** Structural view of one scenario node. */
export interface ScenarioNodeLike {
  type?: string | undefined;
  id?: string | undefined;
  interfaces?: ReadonlyArray<ScenarioInterfaceLike> | undefined;
  ports?: ReadonlyArray<unknown> | undefined;
}

/** Shell action a validator appends as a probe. */
export interface ScenarioShellActionLike {
  at?: DurationInput | undefined;
  host: string;
  exec: string;
}

/**
 * Structural view of a v1 scenario (nodes plus the opaque links/actions the
 * validator only forwards to the runner).
 */
export interface ScenarioLike {
  version?: number | undefined;
  seed?: number | undefined;
  until?: DurationInput | undefined;
  nodes: ReadonlyArray<ScenarioNodeLike>;
  links?: ReadonlyArray<unknown> | undefined;
  actions?: ReadonlyArray<unknown> | undefined;
}

/** Exercise families (F-111). */
export type ExerciseKind =
  | "construir"
  | "configurar"
  | "diagnosticar"
  | "analizar"
  | "optimizar";

/** Every accepted {@link ExerciseKind}, in documentation order. */
export const EXERCISE_KINDS: ReadonlyArray<ExerciseKind> = [
  "construir",
  "configurar",
  "diagnosticar",
  "analizar",
  "optimizar",
];

/** One graded hint (F-113): the penalty is subtracted from the score. */
export interface ExerciseHint {
  level: number;
  text: string;
  penalty: number;
}

/** Trace kinds a `trace` check can watch. */
export type TraceKind =
  | "frame_tx"
  | "frame_rx"
  | "frame_drop"
  | "state"
  | "log";

/** Drop reasons a `trace` check can filter on. */
export type DropReason = "link_down" | "loss" | "queue_full" | "mtu_exceeded";

const TRACE_KINDS: ReadonlyArray<TraceKind> = [
  "frame_tx",
  "frame_rx",
  "frame_drop",
  "state",
  "log",
];

const DROP_REASONS: ReadonlyArray<DropReason> = [
  "link_down",
  "loss",
  "queue_full",
  "mtu_exceeded",
];

/** End-to-end reachability: probe `to` from `from` and count replies. */
export interface PingCheckDef {
  type: "ping";
  name?: string;
  /** Host the probe runs on. */
  from: string;
  /** Node whose first IPv4 address is probed. */
  to: string;
  minReplies: number;
  /** Echo requests to send. Defaults to `minReplies`. */
  count?: number;
}

/** What a shell command must print or return. */
export interface ExecExpectation {
  /** `true` (default): the command must exit 0; `false`: it must fail. */
  exitOk?: boolean;
  /** Regular expression the joined stdout must match. */
  stdoutMatches?: string;
}

/** Run one shell command on a host and inspect its transcript. */
export interface ExecCheckDef {
  type: "exec";
  name?: string;
  host: string;
  command: string;
  expect: ExecExpectation;
}

/** Count matching traces. */
export interface TraceCheckDef {
  type: "trace";
  name?: string;
  kind: TraceKind;
  /** `frame_drop` only: drop location. */
  where?: string;
  /** `frame_drop` only: drop reason. */
  reason?: DropReason;
  /** Default 0. */
  minCount?: number;
  /** Default unlimited. */
  maxCount?: number;
}

/** A MAC must be learned on one specific switch port. */
export interface MacTableCheckDef {
  type: "macTable";
  name?: string;
  switch: string;
  mac: string;
  port: string;
}

/** A route must be present in a router table. */
export interface RouteCheckDef {
  type: "route";
  name?: string;
  router: string;
  /** CIDR as printed by the routing table, e.g. `10.0.1.0/24`. */
  destination: string;
  gateway?: string;
  iface?: string;
}

/** An ARP entry must resolve `ip` to `mac` on `host`. */
export interface ArpCheckDef {
  type: "arp";
  name?: string;
  host: string;
  ip: string;
  mac: string;
}

/** Declarative check: the validator turns it into evidence, never config. */
export type CheckDef =
  | PingCheckDef
  | ExecCheckDef
  | TraceCheckDef
  | MacTableCheckDef
  | RouteCheckDef
  | ArpCheckDef;

/**
 * One exercise, as authored (F-110). `base` is the starting topology (with its
 * preinstalled faults); the student solution is a full v1 scenario parsed by
 * the consumer, not by this schema.
 */
export interface ExerciseJSON {
  version: typeof EXERCISE_VERSION;
  id: string;
  title: string;
  kind: ExerciseKind;
  objective: string;
  /** Run seed; the exercise owns determinism. Default 0. */
  seed: number;
  /** Run horizon; defaults to the base scenario's `until` or 5 s. */
  until?: DurationInput;
  base: ScenarioLike;
  hints: Array<ExerciseHint>;
  checks: Array<CheckDef>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, why: string): Error {
  return new Error(
    path === "" ? `exercise: ${why}` : `exercise ${path}: ${why}`,
  );
}

function reqRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw fail(path, "must be an object");
  }
  return value;
}

function reqString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw fail(path, `"${key}" must be a non-empty string`);
  }
  return value;
}

function optString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw fail(path, `"${key}" must be a non-empty string`);
  }
  return value;
}

function reqArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Array<unknown> {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw fail(path, `"${key}" must be an array`);
  }
  return value;
}

function reqInteger(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
): number {
  const value = reqNumber(obj, key, path);
  if (!Number.isInteger(value) || value < min) {
    throw fail(path, `"${key}" must be an integer >= ${min}: ${value}`);
  }
  return value;
}

function optInteger(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
): number | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  return reqInteger(obj, key, path, min);
}

function reqNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw fail(path, `"${key}" must be a finite number`);
  }
  return value;
}

function optBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw fail(path, `"${key}" must be a boolean`);
  }
  return value;
}

/**
 * Virtual-time duration to microseconds, same contract as the CLI's parser.
 *
 * - number: raw microseconds (finite, >= 0).
 * - string: `<amount><unit>` with unit `us|µs|ms|s|m` (default `us`).
 */
export function parseDurationToUs(
  value: DurationInput | undefined,
  defaultUs: number,
  path = "until",
): number {
  if (value === undefined) {
    return defaultUs;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw fail(path, `duration must be >= 0, got ${value}`);
    }
    return Math.floor(value);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(us|µs|μs|ms|s|m)?\s*$/i.exec(value);
  if (match === null) {
    throw fail(
      path,
      `cannot parse duration ${JSON.stringify(value)} (try "10s", "100ms", "500us" or microseconds as a number)`,
    );
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "us").toLowerCase();
  const factor =
    unit === "us" || unit === "µs" || unit === "μs"
      ? 1
      : unit === "ms"
        ? 1_000
        : unit === "s"
          ? 1_000_000
          : 60_000_000;
  return Math.floor(amount * factor);
}

const IPV4_OCTET = /^\d{1,3}$/;
const CIDR = /^((?:\d{1,3}\.){3}\d{1,3})\/(\d{1,2})$/;
const MAC_GROUP = /^[0-9a-f]{1,2}$/i;

/** Dotted-quad with four octets in 0..255. */
export function isIpv4(text: string): boolean {
  const parts = text.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => IPV4_OCTET.test(part) && Number(part) <= 255)
  );
}

/** `a.b.c.d/len` with a valid address and prefix 0..32. */
export function isCidr(text: string): boolean {
  const match = CIDR.exec(text);
  if (match === null) {
    return false;
  }
  const address = match[1] as string;
  const length = Number(match[2]);
  return isIpv4(address) && Number.isInteger(length) && length <= 32;
}

/** Six hex groups joined consistently by `:` or `-` (1-2 digits each). */
export function isMac(text: string): boolean {
  if (text.includes(":") && text.includes("-")) {
    return false;
  }
  const separator = text.includes(":") ? ":" : "-";
  const parts = text.split(separator);
  return parts.length === 6 && parts.every((part) => MAC_GROUP.test(part));
}

function reqIpv4(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = reqString(obj, key, path);
  if (!isIpv4(value)) {
    throw fail(
      path,
      `"${key}" must be an IPv4 address: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function reqMac(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = reqString(obj, key, path);
  if (!isMac(value)) {
    throw fail(
      path,
      `"${key}" must be a MAC address like 02:00:00:00:00:0a, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseInterfaceLike(
  value: unknown,
  path: string,
): ScenarioInterfaceLike {
  const obj = reqRecord(value, path);
  const iface: ScenarioInterfaceLike = {};
  const name = optString(obj, "name", path);
  if (name !== undefined) {
    iface.name = name;
  }
  for (const key of ["mac", "ip", "mask", "gateway"] as const) {
    const text = optString(obj, key, path);
    if (text !== undefined) {
      iface[key] = text;
    }
  }
  return iface;
}

function parseNodeLike(value: unknown, path: string): ScenarioNodeLike {
  const obj = reqRecord(value, path);
  const type = reqString(obj, "type", path);
  const id = reqString(obj, "id", path);
  const node: ScenarioNodeLike = { type, id };
  if (obj.interfaces !== undefined) {
    node.interfaces = reqArray(obj, "interfaces", path).map((entry, index) =>
      parseInterfaceLike(entry, `${path}.interfaces[${index}]`),
    );
  }
  if (obj.ports !== undefined) {
    node.ports = reqArray(obj, "ports", path).map((entry, index) => {
      const port = reqRecord(entry, `${path}.ports[${index}]`);
      const name = optString(port, "name", `${path}.ports[${index}]`);
      return name === undefined ? {} : { name };
    });
  }
  return node;
}

/**
 * Validate the structural v1 scenario the exercise starts from.
 *
 * Links and actions are forwarded untouched: this package has no opinion on
 * their internals, and the consumer re-parses them with its own schema.
 */
function parseScenarioLike(value: unknown, path: string): ScenarioLike {
  const obj = reqRecord(value, path);
  if (obj.version !== 1) {
    throw fail(path, `"version" must be 1, got ${JSON.stringify(obj.version)}`);
  }
  const nodes = reqArray(obj, "nodes", path).map((entry, index) =>
    parseNodeLike(entry, `${path}.nodes[${index}]`),
  );
  const ids = new Set<string>();
  for (const node of nodes) {
    const id = node.id as string;
    if (ids.has(id)) {
      throw fail(path, `duplicate node id ${JSON.stringify(id)}`);
    }
    ids.add(id);
  }
  const scenario: ScenarioLike = { version: 1, nodes };
  if (obj.links !== undefined) {
    scenario.links = reqArray(obj, "links", path);
  }
  if (obj.actions !== undefined) {
    scenario.actions = reqArray(obj, "actions", path);
  }
  if (obj.seed !== undefined) {
    const seed = obj.seed;
    if (typeof seed !== "number" || !Number.isInteger(seed)) {
      throw fail(path, `"seed" must be an integer`);
    }
    scenario.seed = seed;
  }
  if (obj.until !== undefined) {
    const until = obj.until;
    if (typeof until !== "number" && typeof until !== "string") {
      throw fail(path, `"until" must be a duration string or number`);
    }
    parseDurationToUs(until, DEFAULT_UNTIL_US, `${path}.until`);
    scenario.until = until;
  }
  return scenario;
}

function parseHint(value: unknown, path: string): ExerciseHint {
  const obj = reqRecord(value, path);
  const level = reqInteger(obj, "level", path, 1);
  const text = reqString(obj, "text", path);
  const penalty = reqNumber(obj, "penalty", path);
  if (penalty < 0) {
    throw fail(path, `"penalty" cannot be negative: ${penalty}`);
  }
  return { level, text, penalty };
}

function nameProp(
  obj: Record<string, unknown>,
  path: string,
): { name?: string } {
  const name = optString(obj, "name", path);
  return name === undefined ? {} : { name };
}

/** Reject a command the shell would refuse, before a run ever starts. */
function assertShellCommand(command: string, path: string): void {
  const parsed = parseCommandLine(command);
  if (!parsed.ok) {
    throw fail(
      path,
      `the shell cannot run this command: ${parsed.error.message}`,
    );
  }
}

function parseCheck(
  value: unknown,
  path: string,
  names: Set<string>,
): CheckDef {
  const obj = reqRecord(value, path);
  const type = reqString(obj, "type", path);
  const name = nameProp(obj, path);
  if (name.name !== undefined) {
    if (names.has(name.name)) {
      throw fail(path, `duplicate check name ${JSON.stringify(name.name)}`);
    }
    names.add(name.name);
  }
  if (type === "ping") {
    const from = reqString(obj, "from", path);
    const to = reqString(obj, "to", path);
    const minReplies = reqInteger(obj, "minReplies", path, 1);
    const count = optInteger(obj, "count", path, 1) ?? minReplies;
    if (count > MAX_PING_COUNT) {
      throw fail(path, `"count" must be at most ${MAX_PING_COUNT}: ${count}`);
    }
    if (minReplies > count) {
      throw fail(
        path,
        `"minReplies" (${minReplies}) cannot exceed "count" (${count})`,
      );
    }
    return { type, from, to, minReplies, count, ...name };
  }
  if (type === "exec") {
    const host = reqString(obj, "host", path);
    const command = reqString(obj, "command", path);
    assertShellCommand(command, `${path}.command`);
    const rawExpect = reqRecord(obj.expect, `${path}.expect`);
    const exitOk = optBoolean(rawExpect, "exitOk", `${path}.expect`);
    const stdoutMatches = optString(
      rawExpect,
      "stdoutMatches",
      `${path}.expect`,
    );
    if (stdoutMatches !== undefined) {
      try {
        new RegExp(stdoutMatches);
      } catch (error) {
        throw fail(
          `${path}.expect.stdoutMatches`,
          `invalid regular expression: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const expect: ExecExpectation = {};
    if (exitOk !== undefined) {
      expect.exitOk = exitOk;
    }
    if (stdoutMatches !== undefined) {
      expect.stdoutMatches = stdoutMatches;
    }
    return { type, host, command, expect, ...name };
  }
  if (type === "trace") {
    const kind = reqString(obj, "kind", path);
    if (!TRACE_KINDS.includes(kind as TraceKind)) {
      throw fail(
        path,
        `"kind" must be ${TRACE_KINDS.join(" | ")}, got ${JSON.stringify(kind)}`,
      );
    }
    const where = optString(obj, "where", path);
    const reason = optString(obj, "reason", path);
    if (
      (where !== undefined || reason !== undefined) &&
      kind !== "frame_drop"
    ) {
      throw fail(path, `"where"/"reason" only apply to "frame_drop" checks`);
    }
    if (reason !== undefined && !DROP_REASONS.includes(reason as DropReason)) {
      throw fail(
        path,
        `"reason" must be ${DROP_REASONS.join(" | ")}, got ${JSON.stringify(reason)}`,
      );
    }
    const minCount = optInteger(obj, "minCount", path, 0);
    const maxCount = optInteger(obj, "maxCount", path, 0);
    if (
      minCount !== undefined &&
      maxCount !== undefined &&
      minCount > maxCount
    ) {
      throw fail(
        path,
        `"minCount" (${minCount}) cannot exceed "maxCount" (${maxCount})`,
      );
    }
    const def: TraceCheckDef = { type, kind: kind as TraceKind, ...name };
    if (where !== undefined) {
      def.where = where;
    }
    if (reason !== undefined) {
      def.reason = reason as DropReason;
    }
    if (minCount !== undefined) {
      def.minCount = minCount;
    }
    if (maxCount !== undefined) {
      def.maxCount = maxCount;
    }
    return def;
  }
  if (type === "macTable") {
    return {
      type,
      switch: reqString(obj, "switch", path),
      mac: reqMac(obj, "mac", path),
      port: reqString(obj, "port", path),
      ...name,
    };
  }
  if (type === "route") {
    const destination = reqString(obj, "destination", path);
    if (!isCidr(destination)) {
      throw fail(
        path,
        `"destination" must be a CIDR like 10.0.1.0/24, got ${JSON.stringify(destination)}`,
      );
    }
    const def: RouteCheckDef = {
      type,
      router: reqString(obj, "router", path),
      destination,
      ...name,
    };
    if (obj.gateway !== undefined) {
      def.gateway = reqIpv4(obj, "gateway", path);
    }
    if (obj.iface !== undefined) {
      def.iface = reqString(obj, "iface", path);
    }
    return def;
  }
  if (type === "arp") {
    return {
      type,
      host: reqString(obj, "host", path),
      ip: reqIpv4(obj, "ip", path),
      mac: reqMac(obj, "mac", path),
      ...name,
    };
  }
  throw fail(
    path,
    `"type" must be ping | exec | trace | macTable | route | arp, got ${JSON.stringify(type)}`,
  );
}

/** Validate an already-parsed JSON value into an `ExerciseJSON`. */
export function parseExerciseJson(value: unknown): ExerciseJSON {
  const obj = reqRecord(value, "");
  if (obj.version !== EXERCISE_VERSION) {
    throw fail(
      "",
      `"version" must be ${EXERCISE_VERSION}, got ${JSON.stringify(obj.version)}`,
    );
  }
  const id = reqString(obj, "id", "");
  const title = reqString(obj, "title", "");
  const kind = reqString(obj, "kind", "");
  if (!EXERCISE_KINDS.includes(kind as ExerciseKind)) {
    throw fail(
      "",
      `"kind" must be ${EXERCISE_KINDS.join(" | ")}, got ${JSON.stringify(kind)}`,
    );
  }
  const objective = reqString(obj, "objective", "");
  const seed = optInteger(obj, "seed", "", 0) ?? 0;
  const hintList = reqArray(obj, "hints", "").map((entry, index) =>
    parseHint(entry, `hints[${index}]`),
  );
  const names = new Set<string>();
  const checkList = reqArray(obj, "checks", "").map((entry, index) =>
    parseCheck(entry, `checks[${index}]`, names),
  );
  if (checkList.length === 0) {
    throw fail("", `"checks" needs at least one check`);
  }
  const exercise: ExerciseJSON = {
    version: EXERCISE_VERSION,
    id,
    title,
    kind: kind as ExerciseKind,
    objective,
    seed,
    base: parseScenarioLike(obj.base, "base"),
    hints: hintList,
    checks: checkList,
  };
  if (obj.until !== undefined) {
    const until = obj.until;
    if (typeof until !== "number" && typeof until !== "string") {
      throw fail("", `"until" must be a duration string or number`);
    }
    parseDurationToUs(until, DEFAULT_UNTIL_US, "until");
    exercise.until = until;
  }
  return exercise;
}

/** Parse exercise text (JSON) with the same error style as `parseScenarioText`. */
export function parseExerciseText(
  text: string,
  _filename: string,
): ExerciseJSON {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse exercise: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseExerciseJson(value);
}
