/**
 * Recordings, replay and breakpoints (F-98, F-99).
 *
 * A recording is a run, saved: the scenario, the seed, the horizon and the
 * whole `RunResult` the trace bus produced — frames as lowercase hex,
 * MAC/routing tables and shell transcripts. The engine is deterministic, so
 * `netlab replay` never simulates: it loads the recording and scrubs it.
 * `--until T` cuts the recorded traces at T; the tables and the transcripts
 * stay the recording's end state, because the engine does not rewind them
 * either. A recording whose scenario no longer runs still replays, which is
 * the honest proof that nothing is computed twice.
 *
 * `--break-on-packet` is a mini matcher over the decoded frames: `<field>
 * <op> <value>` clauses joined with `&&`, all of them required to match.
 * Fields come from `@netlab/protocols` (Ethernet → IPv4 → TCP/UDP), so the
 * filter reads like a dissector display filter: `protocol == tcp && port.dst
 * == 80`. A clause on a field the trace does not carry (a port on an ARP
 * frame) never matches, whatever the operator.
 *
 * `--break-on-tcp` stops when the wire proves a TCP state. The engine itself
 * does not trace socket state transitions — `TcpSocket` only publishes
 * congestion samples (`state` traces whose detail is `open cwnd=…`) and only
 * when a bus is wired, which the CLI never does — so the states are observed
 * on the frames instead: SYN ⇒ SYN_SENT, SYN+ACK ⇒ SYN_RECEIVED, the third
 * ACK ⇒ ESTABLISHED, FIN ⇒ FIN_WAIT_1/CLOSE_WAIT and so on. A state the wire
 * cannot prove (LISTEN leaves no packet) never matches.
 *
 * Usage: netlab replay <recording.json> [--until 10s] [--format human|json]
 *                      [--break-on-packet "<field> <op> <value> [&& ...]"]
 *                      [--break-on-tcp <STATE,...>]
 * Exit codes: 0 replayed (also when a breakpoint stops it) · 1 read failure ·
 * 2 usage or recording parse error.
 */

import { readFile } from "node:fs/promises";
import { MacAddress } from "@netlab/bytes";
import type { Trace } from "@netlab/core";
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  IPV4_PROTOCOL_ICMP,
  IPV4_PROTOCOL_TCP,
  IPV4_PROTOCOL_UDP,
  parseEthernet,
  parseIpv4,
  parseTcp,
  parseUdp,
} from "@netlab/protocols";
import {
  formatHuman,
  formatJsonLines,
  formatSummaryJson,
  formatTraceHuman,
  traceToJson,
} from "./format";
import type { RouterTableRow, RunResult, ShellTranscript } from "./run";
import { parseDurationToUs, type Scenario } from "./scenario";

/** Wire format version owned by this slice. */
export const RECORDING_VERSION = 1;

export const REPLAY_USAGE =
  "Usage: netlab replay <recording.json> [--until 10s] [--format human|json]\n" +
  '                     [--break-on-packet "<field> <op> <value> [&& ...]"]\n' +
  "                     [--break-on-tcp <STATE,...>]\n" +
  "  load a `netlab run --snapshot-out` recording and scrub it; nothing is simulated\n" +
  "  --until T cuts the recorded traces at T (the tables keep the recording's end state)\n" +
  "  --break-on-packet stops at the first frame matching every clause; repeatable\n" +
  "    fields: protocol, ip.src, ip.dst, port.src, port.dst, tcp.flags.syn,\n" +
  "            tcp.flags.ack, tcp.flags.fin, tcp.flags.rst, link, kind\n" +
  "    operators: == and != (a field the frame does not carry never matches)\n" +
  "  --break-on-tcp stops when the wire proves one of the states (comma-separated)\n" +
  "  exit 0 when the recording is replayed (also on a breakpoint), 1 on a read\n" +
  "  failure, 2 on usage or recording parse errors\n";

/** One MAC table row as the recording stores it (the `--format json` shape). */
export interface RecordingMacRow {
  mac: string;
  port: string;
  vlan: number;
  expiresAt: number;
}

/** The run's end state, in the shape `formatSummaryJson` already owns. */
export interface RecordingSummary {
  macTables: Record<string, Array<RecordingMacRow>>;
  routes: Record<string, Array<RouterTableRow>>;
  shell: Array<ShellTranscript>;
}

/** A deterministic run, saved. */
export interface Recording {
  version: typeof RECORDING_VERSION;
  /**
   * The scenario that produced the run. Provenance only: replay never feeds
   * it back to the engine, so it is not re-validated on load.
   */
  scenario: Scenario;
  seed: number;
  /** Horizon the recorded run used. */
  untilUs: number;
  /** Simulation time the recorded run reached. */
  finalTime: number;
  /** Events the recorded run processed. */
  processed: number;
  /** The recorded traces, frames decoded back to bytes. */
  traces: Array<Trace>;
  /** Tables and transcripts at the end of the recorded run. */
  summary: RecordingSummary;
}

// --------------------------------------------------------------------------
// Recording
// --------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Path-prefixed recording failure, mirroring `scenario.ts`. */
function fail(path: string, why: string): Error {
  return new Error(
    path === "" ? `recording: ${why}` : `recording ${path}: ${why}`,
  );
}

function reqRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw fail(path, "must be an object");
  }
  return value;
}

function reqArray(value: unknown, path: string): Array<unknown> {
  if (!Array.isArray(value)) {
    throw fail(path, "must be an array");
  }
  return value;
}

function reqString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw fail(path, `"${key}" must be a string`);
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
  if (typeof value !== "string") {
    throw fail(path, `"${key}" must be a string`);
  }
  return value;
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

function reqInteger(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = reqNumber(obj, key, path);
  if (!Number.isInteger(value)) {
    throw fail(path, `"${key}" must be an integer`);
  }
  return value;
}

function reqHex(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Uint8Array {
  const text = reqString(obj, key, path);
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    throw fail(`${path}.${key}`, "must be an even-length hex string");
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function reqEndpoint(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): "a" | "b" {
  const value = obj[key];
  if (value !== "a" && value !== "b") {
    throw fail(path, `"${key}" must be "a" or "b"`);
  }
  return value;
}

const DROP_REASONS: ReadonlyArray<string> = [
  "link_down",
  "loss",
  "queue_full",
  "mtu_exceeded",
];

function reqDropReason(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): "link_down" | "loss" | "queue_full" | "mtu_exceeded" {
  const value = reqString(obj, key, path);
  if (!DROP_REASONS.includes(value)) {
    throw fail(
      `${path}.${key}`,
      `must be one of ${DROP_REASONS.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as "link_down" | "loss" | "queue_full" | "mtu_exceeded";
}

/** One serialized trace back to a `Trace`. Throws with the failing path. */
export function traceFromJson(value: unknown, path: string): Trace {
  const obj = reqRecord(value, path);
  const t = reqNumber(obj, "t", path);
  const kind = reqString(obj, "kind", path);
  if (kind === "frame_tx" || kind === "frame_rx" || kind === "frame_drop") {
    const link = reqString(obj, "link", path);
    const length = reqNumber(obj, "length", path);
    const frame = reqHex(obj, "frame", path);
    if (kind === "frame_tx") {
      return {
        t,
        kind,
        link,
        from: reqEndpoint(obj, "from", path),
        length,
        frame,
      };
    }
    if (kind === "frame_rx") {
      return { t, kind, link, to: reqEndpoint(obj, "to", path), length, frame };
    }
    return {
      t,
      kind,
      link,
      where: reqString(obj, "where", path),
      reason: reqDropReason(obj, "reason", path),
      length,
      frame,
    };
  }
  if (kind === "state") {
    return {
      t,
      kind,
      scope: reqString(obj, "scope", path),
      detail: reqString(obj, "detail", path),
    };
  }
  if (kind === "log") {
    return {
      t,
      kind,
      scope: reqString(obj, "scope", path),
      level: reqString(obj, "level", path),
      message: reqString(obj, "message", path),
    };
  }
  throw fail(path, `unknown "kind" ${JSON.stringify(kind)}`);
}

function parseSummary(value: unknown, path: string): RecordingSummary {
  const obj = reqRecord(value, path);

  const macTablesRaw = reqRecord(obj["macTables"], `${path}.macTables`);
  const macTables: RecordingSummary["macTables"] = {};
  for (const [id, rowsRaw] of Object.entries(macTablesRaw)) {
    const rowsPath = `${path}.macTables.${id}`;
    macTables[id] = reqArray(rowsRaw, rowsPath).map((rowRaw, i) => {
      const rowPath = `${rowsPath}[${i}]`;
      const row = reqRecord(rowRaw, rowPath);
      const mac = reqString(row, "mac", rowPath);
      try {
        MacAddress.parse(mac);
      } catch (error) {
        throw fail(`${rowPath}.mac`, messageOf(error));
      }
      return {
        mac,
        port: reqString(row, "port", rowPath),
        vlan: reqInteger(row, "vlan", rowPath),
        expiresAt: reqNumber(row, "expiresAt", rowPath),
      };
    });
  }

  const routesRaw = reqRecord(obj["routes"], `${path}.routes`);
  const routes: RecordingSummary["routes"] = {};
  for (const [id, rowsRaw] of Object.entries(routesRaw)) {
    const rowsPath = `${path}.routes.${id}`;
    routes[id] = reqArray(rowsRaw, rowsPath).map((rowRaw, i) => {
      const rowPath = `${rowsPath}[${i}]`;
      const row = reqRecord(rowRaw, rowPath);
      const entry: RouterTableRow = {
        destination: reqString(row, "destination", rowPath),
        gateway: optString(row, "gateway", rowPath),
        iface: reqString(row, "iface", rowPath),
        metric: reqNumber(row, "metric", rowPath),
        kind: reqString(row, "kind", rowPath),
      };
      return entry;
    });
  }

  const shell = reqArray(obj["shell"], `${path}.shell`).map((entryRaw, i) => {
    const entryPath = `${path}.shell[${i}]`;
    const entry = reqRecord(entryRaw, entryPath);
    const transcript: ShellTranscript = {
      host: reqString(entry, "host", entryPath),
      command: reqString(entry, "command", entryPath),
    };
    if (entry["lines"] !== undefined) {
      transcript.lines = reqArray(entry["lines"], `${entryPath}.lines`).map(
        (line, j) => {
          if (typeof line !== "string") {
            throw fail(`${entryPath}.lines[${j}]`, "must be a string");
          }
          return line;
        },
      );
    }
    const error = optString(entry, "error", entryPath);
    if (error !== undefined) {
      transcript.error = error;
    }
    return transcript;
  });

  return { macTables, routes, shell };
}

/** Validate an already-parsed JSON value into a `Recording`. */
export function parseRecordingJson(value: unknown): Recording {
  const obj = reqRecord(value, "");
  const version = reqInteger(obj, "version", "");
  if (version !== RECORDING_VERSION) {
    throw fail(
      "",
      `"version" must be ${RECORDING_VERSION}, got ${JSON.stringify(obj["version"])}`,
    );
  }
  const traces = reqArray(obj["traces"], "traces").map((entry, i) =>
    traceFromJson(entry, `traces[${i}]`),
  );
  const processed = reqNumber(obj, "processed", "");
  const finalTime = reqNumber(obj, "finalTime", "");
  const untilUs = reqNumber(obj, "untilUs", "");
  const seed = reqInteger(obj, "seed", "");
  return {
    version: RECORDING_VERSION,
    scenario: reqRecord(obj["scenario"], "scenario") as unknown as Scenario,
    seed,
    untilUs,
    finalTime,
    processed,
    traces,
    summary: parseSummary(obj["summary"], "summary"),
  };
}

/** Parse recording text (JSON) with a path-prefixed failure on bad input. */
export function parseRecordingText(text: string): Recording {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`recording: cannot parse JSON: ${messageOf(error)}`);
  }
  return parseRecordingJson(value);
}

/** Save a finished run as a recording. */
export function recordRun(scenario: Scenario, result: RunResult): Recording {
  // `formatSummaryJson` owns the JSON shape of the tables and transcripts;
  // parsing it back keeps a recording and a `--format json` summary identical.
  const summary = JSON.parse(formatSummaryJson(result)) as RecordingSummary;
  return {
    version: RECORDING_VERSION,
    scenario,
    seed: result.seed,
    untilUs: result.untilUs,
    finalTime: result.finalTime,
    processed: result.processed,
    traces: result.traces,
    summary,
  };
}

/** The recording as the JSON file `--snapshot-out` writes. */
export function formatRecording(recording: Recording): string {
  return `${JSON.stringify({
    version: recording.version,
    scenario: recording.scenario,
    seed: recording.seed,
    untilUs: recording.untilUs,
    finalTime: recording.finalTime,
    processed: recording.processed,
    traces: recording.traces.map(traceToJson),
    summary: recording.summary,
  })}\n`;
}

/**
 * The recorded run as a `RunResult`, cut at `untilUs` when given.
 *
 * Only the traces are cut: the tables and transcripts are the recording's
 * end state, so they are reported as recorded. `processed` is the recorded
 * run's event count (nothing is replayed through the engine) and `finalTime`
 * never claims more than the cut or the recording allow.
 */
export function replayResult(
  recording: Recording,
  untilUs?: number,
): RunResult {
  const requested = untilUs ?? recording.untilUs;
  const traces =
    requested >= recording.untilUs
      ? [...recording.traces]
      : recording.traces.filter((trace) => trace.t <= requested);
  const macTables: RunResult["macTables"] = {};
  for (const [id, rows] of Object.entries(recording.summary.macTables)) {
    macTables[id] = rows.map((row) => ({
      mac: MacAddress.parse(row.mac),
      port: row.port,
      vlan: row.vlan,
      expiresAt: row.expiresAt,
    }));
  }
  return {
    traces,
    macTables,
    routes: recording.summary.routes,
    shellTranscripts: recording.summary.shell,
    processed: recording.processed,
    finalTime: Math.min(recording.finalTime, requested),
    seed: recording.seed,
    untilUs: requested,
  };
}

// --------------------------------------------------------------------------
// Breakpoints (F-99)
// --------------------------------------------------------------------------

/** Fields `--break-on-packet` understands, in the order the usage lists them. */
export const PACKET_FIELDS: ReadonlyArray<string> = [
  "protocol",
  "ip.src",
  "ip.dst",
  "port.src",
  "port.dst",
  "tcp.flags.syn",
  "tcp.flags.ack",
  "tcp.flags.fin",
  "tcp.flags.rst",
  "link",
  "kind",
];

const PACKET_FIELD_SET: ReadonlySet<string> = new Set(PACKET_FIELDS);

/** One `<field> <op> <value>` clause of a packet breakpoint. */
export interface PacketClause {
  field: string;
  operator: "==" | "!=";
  value: string;
}

function usageError(why: string): Error {
  return new Error(`${why}\n${REPLAY_USAGE}`);
}

/**
 * Parse `--break-on-packet`: `<field> <op> <value>`, clauses joined by `&&`.
 *
 * The whole filter is validated up front so a typo fails before the file is
 * read, with the offending clause named.
 */
export function parsePacketFilter(expression: string): Array<PacketClause> {
  if (expression.trim().length === 0) {
    throw usageError(
      '--break-on-packet needs a condition (e.g. "protocol == tcp")',
    );
  }
  return expression.split("&&").map((raw, index) => {
    const text = raw.trim();
    const match = /^(\S+)\s*(==|!=)\s*(\S+)$/.exec(text);
    if (match === null) {
      throw usageError(
        `--break-on-packet clause ${index + 1}: cannot parse ` +
          `${JSON.stringify(text)} (expected "<field> <op> <value>")`,
      );
    }
    const field = match[1] as string;
    const operator = match[2] as "==" | "!=";
    const value = match[3] as string;
    if (!PACKET_FIELD_SET.has(field)) {
      throw usageError(
        `--break-on-packet clause ${index + 1}: unknown field ` +
          `${JSON.stringify(field)} (expected ${PACKET_FIELDS.join(", ")})`,
      );
    }
    return { field, operator, value };
  });
}

/** A field value as the filter sees it: strings, numbers, booleans. */
export type TraceFieldValue = string | number | boolean;

function etherTypeName(etherType: number): string {
  switch (etherType) {
    case ETHERTYPE_ARP:
      return "arp";
    case 0x86dd:
      return "ipv6";
    default:
      return `0x${etherType.toString(16).padStart(4, "0")}`;
  }
}

/**
 * The dissected fields of one trace, as `--break-on-packet` compares them.
 *
 * Frames are decoded with `@netlab/protocols`; a frame the parsers reject
 * (802.1Q tagged frames are unsupported there) keeps `kind` and `link` only,
 * so a clause on a missing field never matches. Only frames carry link-layer
 * fields; `state` and `log` records answer `kind` alone.
 */
export function decodeTraceFields(
  trace: Trace,
): Record<string, TraceFieldValue> {
  const fields: Record<string, TraceFieldValue> = { kind: trace.kind };
  if (trace.kind === "state" || trace.kind === "log") {
    return fields;
  }
  fields.link = trace.link;
  const ethernet = parseEthernet(trace.frame);
  if (!ethernet.ok) {
    return fields;
  }
  const header = ethernet.value;
  if (header.etherType !== ETHERTYPE_IPV4) {
    fields.protocol = etherTypeName(header.etherType);
    return fields;
  }
  const ipv4 = parseIpv4(header.payload);
  if (!ipv4.ok) {
    fields.protocol = "ipv4";
    return fields;
  }
  const ip = ipv4.value.header;
  fields["ip.src"] = ip.src.toString();
  fields["ip.dst"] = ip.dst.toString();
  if (ip.protocol === IPV4_PROTOCOL_TCP) {
    fields.protocol = "tcp";
    const tcp = parseTcp(ipv4.value.payload);
    if (tcp.ok) {
      fields["port.src"] = tcp.value.srcPort;
      fields["port.dst"] = tcp.value.dstPort;
      fields["tcp.flags.syn"] = tcp.value.flags.syn;
      fields["tcp.flags.ack"] = tcp.value.flags.ack;
      fields["tcp.flags.fin"] = tcp.value.flags.fin;
      fields["tcp.flags.rst"] = tcp.value.flags.rst;
    }
    return fields;
  }
  if (ip.protocol === IPV4_PROTOCOL_UDP) {
    fields.protocol = "udp";
    const udp = parseUdp(ipv4.value.payload);
    if (udp.ok) {
      fields["port.src"] = udp.value.srcPort;
      fields["port.dst"] = udp.value.dstPort;
    }
    return fields;
  }
  fields.protocol =
    ip.protocol === IPV4_PROTOCOL_ICMP ? "icmp" : `ip/${ip.protocol}`;
  return fields;
}

/** True when every clause matches the trace (missing fields never match). */
export function matchesPacket(
  clauses: ReadonlyArray<PacketClause>,
  trace: Trace,
): boolean {
  const fields = decodeTraceFields(trace);
  return clauses.every((clause) => {
    const value = fields[clause.field];
    if (value === undefined) {
      return false;
    }
    const actual = String(value).toLowerCase();
    const wanted = clause.value.toLowerCase();
    return clause.operator === "==" ? actual === wanted : actual !== wanted;
  });
}

/** TCP states the wire can prove, in RFC 793 order. */
export const TCP_STATES: ReadonlyArray<string> = [
  "CLOSED",
  "SYN_SENT",
  "SYN_RECEIVED",
  "ESTABLISHED",
  "CLOSE_WAIT",
  "LAST_ACK",
  "FIN_WAIT_1",
  "FIN_WAIT_2",
  "CLOSING",
  "TIME_WAIT",
];

export type TcpWireState =
  | "CLOSED"
  | "SYN_SENT"
  | "SYN_RECEIVED"
  | "ESTABLISHED"
  | "CLOSE_WAIT"
  | "LAST_ACK"
  | "FIN_WAIT_1"
  | "FIN_WAIT_2"
  | "CLOSING"
  | "TIME_WAIT";

/** Parse `--break-on-tcp ESTABLISHED,CLOSE_WAIT` (case-insensitive). */
export function parseTcpStates(raw: string): Array<TcpWireState> {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw usageError(
      `--break-on-tcp needs at least one state (${TCP_STATES.join(", ")})`,
    );
  }
  return parts.map((part) => {
    const state = part.toUpperCase();
    if (!TCP_STATES.includes(state)) {
      throw usageError(
        `--break-on-tcp: unknown state ${JSON.stringify(part)} ` +
          `(expected ${TCP_STATES.join(", ")})`,
      );
    }
    return state as TcpWireState;
  });
}

/** One decoded TCP segment the observer can place on a connection. */
interface TcpSegment {
  src: string;
  dst: string;
  seq: number;
  ack: number;
  flags: { syn: boolean; ack: boolean; fin: boolean; rst: boolean };
}

function tcpSegmentOf(trace: Trace): TcpSegment | undefined {
  // `frame_tx` is one record per transmission; frame_rx repeats it at the
  // far end and would count every segment twice.
  if (trace.kind !== "frame_tx") {
    return undefined;
  }
  const ethernet = parseEthernet(trace.frame);
  if (!ethernet.ok || ethernet.value.etherType !== ETHERTYPE_IPV4) {
    return undefined;
  }
  const ipv4 = parseIpv4(ethernet.value.payload);
  if (!ipv4.ok || ipv4.value.header.protocol !== IPV4_PROTOCOL_TCP) {
    return undefined;
  }
  const tcp = parseTcp(ipv4.value.payload);
  if (!tcp.ok) {
    return undefined;
  }
  const ip = ipv4.value.header;
  return {
    src: `${ip.src.toString()}:${tcp.value.srcPort}`,
    dst: `${ip.dst.toString()}:${tcp.value.dstPort}`,
    seq: tcp.value.seq,
    ack: tcp.value.ack,
    flags: tcp.value.flags,
  };
}

interface TcpConnection {
  /** State per endpoint (`ip:port`). */
  states: Map<string, TcpWireState>;
  /** Endpoints that answered a SYN with SYN+ACK. */
  answeredSyn: Set<string>;
  /** Sequence number of the FIN each endpoint sent. */
  finSeq: Map<string, number>;
}

/** A state the wire just proved, with the connection it belongs to. */
export interface TcpTransition {
  state: TcpWireState;
  connection: string;
}

/**
 * Follows every TCP connection from the frames it sees and reports the
 * states the wire proves. RFC 793 is approximated: only what a packet makes
 * certain is reported, and a segment the observer cannot place leaves the
 * state untouched (a repeated SYN after ESTABLISHED is ignored, not a
 * regression).
 */
class TcpObserver {
  private readonly connections = new Map<string, TcpConnection>();

  /** Feed one trace; return the first newly proven wanted state, if any. */
  observe(
    trace: Trace,
    wanted: ReadonlySet<TcpWireState>,
  ): TcpTransition | undefined {
    const segment = tcpSegmentOf(trace);
    if (segment === undefined) {
      return undefined;
    }
    const { src, dst } = segment;
    const key = [src, dst].sort().join(" <> ");
    let connection = this.connections.get(key);
    if (connection === undefined) {
      connection = {
        states: new Map(),
        answeredSyn: new Set(),
        finSeq: new Map(),
      };
      this.connections.set(key, connection);
    }
    const stateOf = (endpoint: string): TcpWireState =>
      connection.states.get(endpoint) ?? "CLOSED";
    const transitions: Array<{ state: TcpWireState; endpoint: string }> = [];
    const set = (endpoint: string, state: TcpWireState): void => {
      if (stateOf(endpoint) === state) {
        return;
      }
      connection.states.set(endpoint, state);
      transitions.push({ state, endpoint });
    };

    const from = stateOf(src);
    if (segment.flags.rst) {
      set(dst, "CLOSED");
      set(src, "CLOSED");
    } else if (segment.flags.syn && segment.flags.ack) {
      connection.answeredSyn.add(src);
      if (from !== "ESTABLISHED") {
        set(src, "SYN_RECEIVED");
      }
    } else if (segment.flags.syn) {
      if (from === "CLOSED") {
        set(src, "SYN_SENT");
      }
    } else if (segment.flags.ack) {
      if (
        connection.answeredSyn.has(dst) &&
        (from === "SYN_SENT" || from === "SYN_RECEIVED")
      ) {
        set(src, "ESTABLISHED");
        set(dst, "ESTABLISHED");
      } else {
        const peerFin = connection.finSeq.get(dst);
        if (peerFin !== undefined && segment.ack === (peerFin + 1) >>> 0) {
          if (stateOf(dst) === "LAST_ACK") {
            set(dst, "CLOSED");
          }
          if (stateOf(src) === "FIN_WAIT_1") {
            set(src, "FIN_WAIT_2");
          }
        }
      }
    }
    if (segment.flags.fin) {
      connection.finSeq.set(src, segment.seq);
      if (stateOf(src) === "ESTABLISHED") {
        set(src, "FIN_WAIT_1");
      } else if (stateOf(src) === "CLOSE_WAIT") {
        set(src, "LAST_ACK");
      }
      const peer = stateOf(dst);
      if (peer === "ESTABLISHED") {
        set(dst, "CLOSE_WAIT");
      } else if (peer === "FIN_WAIT_2") {
        set(dst, "TIME_WAIT");
      } else if (peer === "FIN_WAIT_1") {
        set(dst, "CLOSING");
      }
    }

    for (const transition of transitions) {
      if (wanted.has(transition.state)) {
        return {
          state: transition.state,
          connection: `${src} -> ${dst}`,
        };
      }
    }
    return undefined;
  }
}

/** What `--break-on-packet` and `--break-on-tcp` were asked to stop on. */
export interface BreakOptions {
  packet?: { clauses: Array<PacketClause>; expression: string };
  tcp?: Array<TcpWireState>;
}

/** A breakpoint that fired: the time, the evidence, and what matched. */
export interface BreakHit {
  on: "packet" | "tcp";
  t: number;
  /** The filter text, or the TCP state that was proven. */
  match: string;
  /** The trace at the stop. */
  trace: Trace;
  /** TCP endpoints, when a state was the trigger. */
  connection?: string;
}

/**
 * Scan the traces in order and return the first breakpoint hit.
 *
 * Packet filters run before the TCP observer on the same trace: when both
 * would stop, the explicit filter wins. With no trace matching, the caller
 * runs the recording to its end.
 */
export function findBreak(
  traces: ReadonlyArray<Trace>,
  options: BreakOptions,
): BreakHit | undefined {
  const wanted = options.tcp === undefined ? undefined : new Set(options.tcp);
  const observer = wanted === undefined ? undefined : new TcpObserver();
  for (const trace of traces) {
    if (
      options.packet !== undefined &&
      matchesPacket(options.packet.clauses, trace)
    ) {
      return {
        on: "packet",
        t: trace.t,
        match: options.packet.expression,
        trace,
      };
    }
    if (observer !== undefined && wanted !== undefined) {
      const transition = observer.observe(trace, wanted);
      if (transition !== undefined) {
        return {
          on: "tcp",
          t: trace.t,
          match: transition.state,
          trace,
          connection: transition.connection,
        };
      }
    }
  }
  return undefined;
}

/** The stop as the console prints it: time, what matched, the evidence. */
export function formatBreakHuman(hit: BreakHit): string {
  const where =
    hit.on === "packet"
      ? `break on packet at t=${hit.t}us: ${hit.match}`
      : `break on tcp at t=${hit.t}us: ${hit.match}${
          hit.connection === undefined ? "" : ` (${hit.connection})`
        }`;
  return `${where}\n${formatTraceHuman(hit.trace)}\n`;
}

/** The stop as one JSON line (trace as hex, like `--format json` traces). */
export function formatBreakJson(hit: BreakHit): string {
  return `${JSON.stringify({
    event: "break",
    on: hit.on,
    t: hit.t,
    match: hit.match,
    ...(hit.connection === undefined ? {} : { connection: hit.connection }),
    trace: traceToJson(hit.trace),
  })}\n`;
}

// --------------------------------------------------------------------------
// Command
// --------------------------------------------------------------------------

interface ReplayArgs {
  file: string;
  untilUs: number | undefined;
  format: "human" | "json";
  breakpoints: BreakOptions;
}

function parseReplayArgs(argv: Array<string>): ReplayArgs {
  if (argv[0] === "-h" || argv[0] === "--help") {
    throw Object.assign(usageError("netlab replay needs a recording file."), {
      code: "HELP",
    });
  }
  let file: string | undefined;
  let untilUs: number | undefined;
  let format: "human" | "json" = "human";
  const clauses: Array<PacketClause> = [];
  const expressions: Array<string> = [];
  const states: Array<TcpWireState> = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--until") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw usageError("--until needs a duration (e.g. 10s)");
      }
      untilUs = parseDurationToUs(raw, 0, "--until");
    } else if (arg === "--format") {
      const raw = argv[++i];
      if (raw !== "human" && raw !== "json") {
        throw usageError(
          `--format must be "human" or "json", got ${JSON.stringify(raw)}`,
        );
      }
      format = raw;
    } else if (arg === "--break-on-packet") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw usageError(
          '--break-on-packet needs a condition (e.g. "protocol == tcp")',
        );
      }
      clauses.push(...parsePacketFilter(raw));
      expressions.push(raw.trim());
    } else if (arg === "--break-on-tcp") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw usageError(
          `--break-on-tcp needs one or more states (${TCP_STATES.join(", ")})`,
        );
      }
      for (const state of parseTcpStates(raw)) {
        if (!states.includes(state)) {
          states.push(state);
        }
      }
    } else if (arg.startsWith("-")) {
      throw usageError(`unknown flag ${JSON.stringify(arg)}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw usageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  if (file === undefined) {
    throw usageError("missing <recording.json>");
  }
  const breakpoints: BreakOptions = {};
  if (clauses.length > 0) {
    breakpoints.packet = {
      clauses,
      expression: expressions.join(" && "),
    };
  }
  if (states.length > 0) {
    breakpoints.tcp = states;
  }
  return { file, untilUs, format, breakpoints };
}

/**
 * Print a run exactly as `netlab run` does: traces on stdout, the summary on
 * stderr in JSON mode. Replay reuses it so the two commands stay identical.
 */
export function printResult(result: RunResult, format: "human" | "json"): void {
  if (format === "json") {
    process.stdout.write(formatJsonLines(result.traces));
    process.stderr.write(`${formatSummaryJson(result)}\n`);
    return;
  }
  process.stdout.write(formatHuman(result));
}

/** Run `netlab replay` and return the process exit code. */
export async function runReplay(argv: Array<string>): Promise<number> {
  let args: ReplayArgs;
  try {
    args = parseReplayArgs(argv);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "HELP") {
      process.stdout.write(REPLAY_USAGE);
      return 0;
    }
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  let text: string;
  try {
    text = await readFile(args.file, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read ${args.file}: ${messageOf(error)}\n`);
    return 1;
  }

  let recording: Recording;
  try {
    recording = parseRecordingText(text);
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return 2;
  }

  const result = replayResult(recording, args.untilUs);
  const hit = findBreak(result.traces, args.breakpoints);
  if (hit !== undefined) {
    process.stdout.write(
      args.format === "json" ? formatBreakJson(hit) : formatBreakHuman(hit),
    );
    return 0;
  }
  printResult(result, args.format);
  return 0;
}
