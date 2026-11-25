/**
 * F-93 inspector filters plus the F-95 (UDP part) flow-graph mapping.
 *
 * `compileFilter()` is a total recursive-descent parser for a small
 * Wireshark-like language:
 *
 *   expr    := or
 *   or      := and ('||' and)*
 *   and     := unary ('&&' unary)*
 *   unary   := '!' unary | '(' expr ')' | comparison
 *   comparison := field op value
 *
 * Fields: `protocol`, `ip.src`, `ip.dst`, `udp.sport`, `udp.dport`,
 * `dns.name`, `dhcp.type`, `len`. Text fields accept `==`/`!=`; numeric
 * fields accept `==`, `!=`, `>`, `<`, `>=`, `<=`. `protocol` and `dns.name`
 * compare case-insensitively; the rest compare literally.
 *
 * It never throws: malformed input returns `{ ok: false, error }` with a
 * typed code, a Spanish message and the offset of the offending token. An
 * empty expression compiles to a match-all predicate, which is what an empty
 * filter box means in the UI.
 *
 * Evaluation reads the already-decoded `PacketRow`: IPv4 addresses come from
 * `DecodedFrame`, UDP ports from the L4 rows, `dns.name`/`dhcp.type` from the
 * L7 rows and `len` from the row. A field that does not apply to a packet
 * makes the comparison false, except `!=` which is true (the packet's value
 * is not that value because it has none).
 *
 * `flowLanes()`/`flowArrows()` map the virtual-time `Flight`s onto the
 * per-device lanes of the sequence panel. Both are pure geometry so the
 * workbench renders them without a second engine, and tests can pin the
 * `linkId + from` → origin/destination mapping.
 *
 * No DOM, no SvelteKit, no `Math.random`/`Date.now`: safe for `bun test`,
 * SSR-less routes and replay.
 */

import type { DecodedFrame, FrameProtocol, PacketRow } from "./decode";
import type { FlightOutcome } from "./flights";
import type { EndpointSide } from "./sim-protocol";

export type FilterErrorCode =
  | "unknown-field"
  | "unknown-operator"
  | "expected-field"
  | "expected-operator"
  | "expected-value"
  | "unexpected-token"
  | "unexpected-character"
  | "unclosed-paren"
  | "unclosed-quote"
  | "type-mismatch"
  | "invalid-number"
  | "too-deep";

export interface FilterError {
  code: FilterErrorCode;
  message: string;
  position: number;
}

export type Filter =
  | { ok: true; pred: (packet: PacketRow) => boolean }
  | { ok: false; error: FilterError };

type TextField = "protocol" | "ip.src" | "ip.dst" | "dns.name" | "dhcp.type";
type NumberField = "udp.sport" | "udp.dport" | "len";
type CompareOp = "eq" | "ne" | "gt" | "lt" | "ge" | "le";
type TextOp = "eq" | "ne";

const TEXT_FIELDS: ReadonlySet<string> = new Set<TextField>([
  "protocol",
  "ip.src",
  "ip.dst",
  "dns.name",
  "dhcp.type",
]);
const NUMBER_FIELDS: ReadonlySet<string> = new Set<NumberField>([
  "udp.sport",
  "udp.dport",
  "len",
]);
const FIELD_LIST =
  "protocol, ip.src, ip.dst, udp.sport, udp.dport, dns.name, dhcp.type, len";
const OP_TEXT: Record<CompareOp, string> = {
  eq: "==",
  ne: "!=",
  gt: ">",
  lt: "<",
  ge: ">=",
  le: "<=",
};
/** Recursion bound so adversarial nesting errors out instead of overflowing. */
const MAX_DEPTH = 64;

const WHITESPACE = /[ \t\r\n]/;
const WORD_CHAR = /[A-Za-z0-9_.:-]/;
const DIGITS = /^\d+$/;
const DNS_NAME_ROW = /^(?:pregunta|respuesta) \d+ nombre$/;
const DHCP_TYPE_VALUE = /^([A-Za-z]+) \(\d+\)$/;
const UDP_PORT_LABEL = {
  sport: "puerto origen",
  dport: "puerto destino",
} as const;

type Token =
  | { kind: "word"; text: string; position: number }
  | { kind: "string"; text: string; position: number }
  | { kind: "op"; op: CompareOp; position: number }
  | { kind: "and"; position: number }
  | { kind: "or"; position: number }
  | { kind: "not"; position: number }
  | { kind: "lparen"; position: number }
  | { kind: "rparen"; position: number }
  | { kind: "eof"; position: number };

type Node =
  | { kind: "or"; left: Node; right: Node }
  | { kind: "and"; left: Node; right: Node }
  | { kind: "not"; operand: Node }
  | { kind: "text"; field: TextField; op: TextOp; value: string }
  | { kind: "number"; field: NumberField; op: CompareOp; value: number };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: FilterError };

function fail(
  code: FilterErrorCode,
  message: string,
  position: number,
): { ok: false; error: FilterError } {
  return { ok: false, error: { code, message, position } };
}

/** Split the source into tokens; the only stage that inspects characters. */
function lex(
  source: string,
): { ok: true; tokens: Token[] } | { ok: false; error: FilterError } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (WHITESPACE.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen", position: index });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen", position: index });
      index += 1;
      continue;
    }
    if (char === "&") {
      if (source[index + 1] !== "&") {
        return fail(
          "unknown-operator",
          'operador incompleto "&": usá "&&"',
          index,
        );
      }
      tokens.push({ kind: "and", position: index });
      index += 2;
      continue;
    }
    if (char === "|") {
      if (source[index + 1] !== "|") {
        return fail(
          "unknown-operator",
          'operador incompleto "|": usá "||"',
          index,
        );
      }
      tokens.push({ kind: "or", position: index });
      index += 2;
      continue;
    }
    if (char === "!") {
      if (source[index + 1] === "=") {
        tokens.push({ kind: "op", op: "ne", position: index });
        index += 2;
      } else {
        tokens.push({ kind: "not", position: index });
        index += 1;
      }
      continue;
    }
    if (char === "=") {
      if (source[index + 1] !== "=") {
        return fail(
          "unknown-operator",
          'operador inválido "=": usá "=="',
          index,
        );
      }
      tokens.push({ kind: "op", op: "eq", position: index });
      index += 2;
      continue;
    }
    if (char === ">" || char === "<") {
      const at = index;
      const orEqual = source[index + 1] === "=";
      const op: CompareOp =
        char === ">" ? (orEqual ? "ge" : "gt") : orEqual ? "le" : "lt";
      tokens.push({ kind: "op", op, position: at });
      index += orEqual ? 2 : 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index;
      index += 1;
      let text = "";
      while (index < source.length && source[index] !== char) {
        text += source[index] ?? "";
        index += 1;
      }
      if (index >= source.length) {
        return fail(
          "unclosed-quote",
          `comilla sin cerrar en la posición ${start}`,
          start,
        );
      }
      index += 1;
      tokens.push({ kind: "string", text, position: start });
      continue;
    }
    if (WORD_CHAR.test(char)) {
      const start = index;
      let text = "";
      while (index < source.length) {
        const next = source[index] ?? "";
        if (!WORD_CHAR.test(next)) {
          break;
        }
        text += next;
        index += 1;
      }
      tokens.push({ kind: "word", text, position: start });
      continue;
    }
    return fail("unexpected-character", `carácter inesperado "${char}"`, index);
  }
  tokens.push({ kind: "eof", position: source.length });
  return { ok: true, tokens };
}

interface ParserState {
  tokens: readonly Token[];
  index: number;
  depth: number;
}

function peek(state: ParserState): Token {
  return state.tokens[state.index] ?? { kind: "eof", position: 0 };
}

function parseOr(state: ParserState): Parsed<Node> {
  const left = parseAnd(state);
  if (!left.ok) {
    return left;
  }
  let node = left.value;
  while (peek(state).kind === "or") {
    state.index += 1;
    const right = parseAnd(state);
    if (!right.ok) {
      return right;
    }
    node = { kind: "or", left: node, right: right.value };
  }
  return { ok: true, value: node };
}

function parseAnd(state: ParserState): Parsed<Node> {
  const left = parseUnary(state);
  if (!left.ok) {
    return left;
  }
  let node = left.value;
  while (peek(state).kind === "and") {
    state.index += 1;
    const right = parseUnary(state);
    if (!right.ok) {
      return right;
    }
    node = { kind: "and", left: node, right: right.value };
  }
  return { ok: true, value: node };
}

function parseUnary(state: ParserState): Parsed<Node> {
  const token = peek(state);
  if (token.kind === "not") {
    if (state.depth >= MAX_DEPTH) {
      return fail(
        "too-deep",
        `expresión anidada demasiado profunda (máx. ${MAX_DEPTH})`,
        token.position,
      );
    }
    state.index += 1;
    state.depth += 1;
    const operand = parseUnary(state);
    state.depth -= 1;
    if (!operand.ok) {
      return operand;
    }
    return { ok: true, value: { kind: "not", operand: operand.value } };
  }
  if (token.kind === "lparen") {
    if (state.depth >= MAX_DEPTH) {
      return fail(
        "too-deep",
        `expresión anidada demasiado profunda (máx. ${MAX_DEPTH})`,
        token.position,
      );
    }
    state.index += 1;
    state.depth += 1;
    const inner = parseOr(state);
    state.depth -= 1;
    if (!inner.ok) {
      return inner;
    }
    const close = peek(state);
    if (close.kind !== "rparen") {
      return fail(
        "unclosed-paren",
        `falta ")" del paréntesis abierto en la posición ${token.position}`,
        close.position,
      );
    }
    state.index += 1;
    return inner;
  }
  return parseComparison(state);
}

function parseComparison(state: ParserState): Parsed<Node> {
  const fieldToken = peek(state);
  if (fieldToken.kind !== "word") {
    return fail(
      "expected-field",
      `se esperaba un campo (${FIELD_LIST})`,
      fieldToken.position,
    );
  }
  const field = fieldToken.text.toLowerCase();
  const numeric = NUMBER_FIELDS.has(field);
  if (!numeric && !TEXT_FIELDS.has(field)) {
    return fail(
      "unknown-field",
      `campo desconocido "${fieldToken.text}" (${FIELD_LIST})`,
      fieldToken.position,
    );
  }
  state.index += 1;

  const opToken = peek(state);
  if (opToken.kind !== "op") {
    return fail(
      "expected-operator",
      `se esperaba un operador después de "${fieldToken.text}"`,
      opToken.position,
    );
  }
  state.index += 1;

  const valueToken = peek(state);
  if (valueToken.kind !== "word" && valueToken.kind !== "string") {
    return fail(
      "expected-value",
      `se esperaba un valor después de "${OP_TEXT[opToken.op]}"`,
      valueToken.position,
    );
  }
  state.index += 1;

  if (!numeric) {
    if (opToken.op !== "eq" && opToken.op !== "ne") {
      return fail(
        "type-mismatch",
        `el operador ${OP_TEXT[opToken.op]} no aplica al campo de texto "${field}"`,
        opToken.position,
      );
    }
    return {
      ok: true,
      value: {
        kind: "text",
        field: field as TextField,
        op: opToken.op,
        value: valueToken.text,
      },
    };
  }

  // A quoted value is text even when it looks numeric: `udp.dport == "53"`
  // stays rejected so the two value kinds never blend silently.
  const number =
    valueToken.kind === "word" && DIGITS.test(valueToken.text)
      ? Number(valueToken.text)
      : Number.NaN;
  if (!Number.isFinite(number)) {
    return fail(
      "invalid-number",
      `"${valueToken.text}" no es un número válido para "${field}"`,
      valueToken.position,
    );
  }
  return {
    ok: true,
    value: {
      kind: "number",
      field: field as NumberField,
      op: opToken.op,
      value: number,
    },
  };
}

/** Compile an expression; never throws, always returns a typed result. */
export function compileFilter(source: string): Filter {
  if (source.trim() === "") {
    return { ok: true, pred: () => true };
  }
  const lexed = lex(source);
  if (!lexed.ok) {
    return lexed;
  }
  const state: ParserState = { tokens: lexed.tokens, index: 0, depth: 0 };
  const parsed = parseOr(state);
  if (!parsed.ok) {
    return parsed;
  }
  const trailing = peek(state);
  if (trailing.kind !== "eof") {
    return fail(
      "unexpected-token",
      `token inesperado en la posición ${trailing.position}`,
      trailing.position,
    );
  }
  const node = parsed.value;
  return { ok: true, pred: (packet) => evaluate(node, packet) };
}

function evaluate(node: Node, packet: PacketRow): boolean {
  switch (node.kind) {
    case "or":
      return evaluate(node.left, packet) || evaluate(node.right, packet);
    case "and":
      return evaluate(node.left, packet) && evaluate(node.right, packet);
    case "not":
      return !evaluate(node.operand, packet);
    case "text": {
      const actual = readTextField(packet.decoded, node.field);
      if (actual === null) {
        return node.op === "ne";
      }
      const caseInsensitive =
        node.field === "protocol" || node.field === "dns.name";
      const left = caseInsensitive ? actual.toLowerCase() : actual;
      const right = caseInsensitive ? node.value.toLowerCase() : node.value;
      return node.op === "eq" ? left === right : left !== right;
    }
    case "number": {
      const actual = readNumberField(packet, node.field);
      if (actual === null) {
        return node.op === "ne";
      }
      switch (node.op) {
        case "eq":
          return actual === node.value;
        case "ne":
          return actual !== node.value;
        case "gt":
          return actual > node.value;
        case "lt":
          return actual < node.value;
        case "ge":
          return actual >= node.value;
        case "le":
          return actual <= node.value;
      }
    }
  }
}

function readTextField(decoded: DecodedFrame, field: TextField): string | null {
  switch (field) {
    case "protocol":
      return decoded.protocol;
    case "ip.src":
      return decoded.srcIp;
    case "ip.dst":
      return decoded.dstIp;
    case "dns.name":
      return dnsName(decoded);
    case "dhcp.type":
      return dhcpType(decoded);
  }
}

/** Question name of a DNS message, or its first answer when QDCOUNT is 0. */
function dnsName(decoded: DecodedFrame): string | null {
  if (decoded.protocol !== "DNS") {
    return null;
  }
  const layer = decoded.layers.find((candidate) => candidate.id === "l7");
  const row = layer?.rows.find((candidate) =>
    DNS_NAME_ROW.test(candidate.label),
  );
  return row?.value ?? null;
}

/** DHCP message type (`DISCOVER`, `OFFER`, …) read from option 53. */
function dhcpType(decoded: DecodedFrame): string | null {
  if (decoded.protocol !== "DHCP") {
    return null;
  }
  const layer = decoded.layers.find((candidate) => candidate.id === "l7");
  const row = layer?.rows.find(
    (candidate) => candidate.label === "opción 53 (message type)",
  );
  if (row === undefined) {
    return null;
  }
  const match = DHCP_TYPE_VALUE.exec(row.value);
  return match?.[1] ?? null;
}

function readNumberField(packet: PacketRow, field: NumberField): number | null {
  switch (field) {
    case "len":
      return packet.length;
    case "udp.sport":
      return udpPort(packet, UDP_PORT_LABEL.sport);
    case "udp.dport":
      return udpPort(packet, UDP_PORT_LABEL.dport);
  }
}

/** UDP header row of the decoded L4 layer; ICMP/DNS-only frames have none. */
function udpPort(packet: PacketRow, label: string): number | null {
  const layer = packet.decoded.layers.find(
    (candidate) => candidate.id === "l4" && candidate.title.startsWith("UDP"),
  );
  const row = layer?.rows.find((candidate) => candidate.label === label);
  if (row === undefined || !DIGITS.test(row.value)) {
    return null;
  }
  const port = Number(row.value);
  return Number.isFinite(port) ? port : null;
}

export interface FlowLane {
  device: string;
  /** Horizontal center of the lane inside the panel viewBox. */
  x: number;
}

export interface FlowWindow {
  fromUs: number;
  toUs: number;
}

/** Subset of `Flight` the flow mapping needs (keeps tests engine-free). */
export interface FlowFlight {
  linkId: string;
  from: EndpointSide;
  startUs: number;
  endUs: number;
  protocol: FrameProtocol;
  outcome: FlightOutcome;
}

export interface FlowArrow {
  /** Stable `#each` key derived from the flight and its index. */
  key: string;
  linkId: string;
  fromDevice: string;
  toDevice: string;
  protocol: FrameProtocol;
  outcome: FlightOutcome;
  startUs: number;
  endUs: number;
  x1: number;
  x2: number;
  y: number;
}

export const FLOW_WIDTH = 300;
export const FLOW_HEIGHT = 180;
export const FLOW_TOP = 26;
export const FLOW_BOTTOM = 162;
const FLOW_MARGIN = 40;

/**
 * Link endpoints as wired by `scenario.ts` (`connect(link, a, b)`): side `a`
 * of `l-h1-r1` is h1, side `a` of `l-r1-h2` is r1. Kept next to the flow
 * math because the workbench only renders this fixed lab.
 */
export const WORKBENCH_LINKS: Readonly<
  Record<string, { readonly a: string; readonly b: string }>
> = {
  "l-h1-r1": { a: "h1", b: "r1" },
  "l-r1-h2": { a: "r1", b: "h2" },
};

/** One lane per device, spread left→right in the given order. */
export function flowLanes(devices: readonly string[]): FlowLane[] {
  const first = devices[0];
  if (first === undefined) {
    return [];
  }
  if (devices.length === 1) {
    return [{ device: first, x: FLOW_WIDTH / 2 }];
  }
  const span = FLOW_WIDTH - FLOW_MARGIN * 2;
  return devices.map((device, index) => ({
    device,
    x: FLOW_MARGIN + (span * index) / (devices.length - 1),
  }));
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Turn flights into sequence arrows: origin/destination come from
 * `WORKBENCH_LINKS[linkId]` and the flight side, time maps top→bottom inside
 * `window`. Flights outside the window, on unknown links or whose devices
 * have no lane are skipped instead of drawing an invented arrow.
 */
export function flowArrows(
  flights: readonly FlowFlight[],
  lanes: readonly FlowLane[],
  window: FlowWindow,
): FlowArrow[] {
  const laneX = new Map(lanes.map((lane) => [lane.device, lane.x]));
  const fromUs = Math.min(window.fromUs, window.toUs);
  const toUs = Math.max(window.fromUs, window.toUs);
  const span = toUs - fromUs;
  const ordered = flights
    .map((flight, index) => ({ flight, index }))
    .sort(
      (left, right) =>
        left.flight.startUs - right.flight.startUs || left.index - right.index,
    );
  const arrows: FlowArrow[] = [];
  for (const { flight, index } of ordered) {
    if (flight.endUs < fromUs || flight.startUs > toUs) {
      continue;
    }
    const endpoints = WORKBENCH_LINKS[flight.linkId];
    if (endpoints === undefined) {
      continue;
    }
    const fromDevice = flight.from === "a" ? endpoints.a : endpoints.b;
    const toDevice = flight.from === "a" ? endpoints.b : endpoints.a;
    const x1 = laneX.get(fromDevice);
    const x2 = laneX.get(toDevice);
    if (x1 === undefined || x2 === undefined) {
      continue;
    }
    // A zero-width window (scrub at t=0) pins its flights to the top edge.
    const progress = span <= 0 ? 0 : clamp01((flight.startUs - fromUs) / span);
    arrows.push({
      key: `${flight.linkId}:${flight.from}:${flight.startUs}:${flight.endUs}:${index}`,
      linkId: flight.linkId,
      fromDevice,
      toDevice,
      protocol: flight.protocol,
      outcome: flight.outcome,
      startUs: flight.startUs,
      endUs: flight.endUs,
      x1,
      x2,
      y: FLOW_TOP + (FLOW_BOTTOM - FLOW_TOP) * progress,
    });
  }
  return arrows;
}
