/**
 * Total command-line parser for the minimal shell (S7, S9).
 *
 * Every branch returns a typed result. Malformed input — unknown commands,
 * unknown flags, missing values, bad addresses, unsupported mutations —
 * becomes a {@link ShellError}; nothing in this module throws for user
 * input.
 */

import { Ipv4Address, MacAddress } from "@netlab/bytes";
import { splitIpv4Prefix } from "@netlab/core";
import { type ShellError, shellError } from "./errors";

/** Requests per `ping` when `-c` is absent. */
export const DEFAULT_PING_COUNT = 4;
/** Echo data bytes per `ping` when `-s` is absent. */
export const DEFAULT_PING_SIZE = 56;
/** IPv4 TTL per `ping` when `-t` is absent. */
export const DEFAULT_PING_TTL = 64;
/** Largest ICMP echo payload the Host accepts. */
export const MAX_PING_SIZE = 65507;
/** Largest request count: sequences are 16-bit. */
export const MAX_PING_COUNT = 65535;
/** Largest payload `nc` accepts: the IPv4 datagram limit. */
export const MAX_NC_PAYLOAD_BYTES = 65507;
/** Port `http-server` and `curl` use when none is given. */
export const DEFAULT_HTTP_PORT = 80;

/** One DNS label: alphanumeric, internal hyphens, 1..63 characters. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface IpAddrShowCommand {
  readonly kind: "ip.addr.show";
  readonly iface?: string;
}

export interface IpAddrSetCommand {
  readonly kind: "ip.addr.set";
  readonly ip: string;
  readonly iface: string;
  readonly gateway?: string;
}

export interface IpLinkShowCommand {
  readonly kind: "ip.link.show";
  readonly iface?: string;
}

export interface IpLinkSetCommand {
  readonly kind: "ip.link.set";
  readonly iface: string;
  readonly up: boolean;
}

export interface IpRouteShowCommand {
  readonly kind: "ip.route.show";
}

export interface IpNeighShowCommand {
  readonly kind: "ip.neigh.show";
  readonly iface?: string;
}

export interface ArpCommand {
  readonly kind: "arp";
}

export interface PingCommand {
  readonly kind: "ping";
  readonly dst: string;
  readonly count: number;
  readonly size: number;
  readonly ttl: number;
}

export interface TracerouteCommand {
  readonly kind: "traceroute";
  readonly dst: string;
}

export interface DigCommand {
  readonly kind: "dig";
  /** Normalized query name, no trailing dot. */
  readonly name: string;
  /** `@SERVER` override; absent means the shell's default resolver. */
  readonly server?: string;
}

export interface DhclientCommand {
  readonly kind: "dhclient";
  /** Interface to configure; absent means the first unconfigured one. */
  readonly iface?: string;
}

export interface NcUdpCommand {
  readonly kind: "nc.udp";
  readonly host: string;
  readonly port: number;
  /** Lowercase hex payload; empty sends a zero-length datagram. */
  readonly payload: string;
}

export interface NcTcpCommand {
  readonly kind: "nc.tcp";
  readonly host: string;
  readonly port: number;
  /** Lowercase hex payload; empty sends no data after the handshake. */
  readonly payload: string;
}

/** `ss`: live TCP sockets of the host, no arguments. */
export interface SsCommand {
  readonly kind: "ss";
}

/**
 * `send IFACE DSTMAC ETHERTYPE HEX`: one hand-built Ethernet frame (F-101).
 *
 * The frame bypasses routing and ARP by construction: the caller writes the
 * destination MAC, the ethertype and the payload bytes, which is exactly what
 * an exercise about malformed or spoofed frames needs.
 */
export interface SendCommand {
  readonly kind: "send";
  readonly iface: string;
  /** Normalized lowercase `aa:bb:cc:dd:ee:ff`. */
  readonly dstMac: string;
  /** EtherType in 0..0xFFFF. */
  readonly etherType: number;
  /** Lowercase hex payload; its length is always even. */
  readonly payload: string;
}

/** `http-server [PORT]`: serve a fixed HTTP/1.0 page from the host. */
export interface HttpServerCommand {
  readonly kind: "http.server";
  /** Listening port; absent means {@link DEFAULT_HTTP_PORT}. */
  readonly port?: number;
}

/** `curl URL`: one HTTP/1.0 GET with the body printed. */
export interface HttpGetCommand {
  readonly kind: "http.get";
  readonly host: string;
  readonly port: number;
  /** Absolute request target, always starting with `/`. */
  readonly path: string;
}

export interface HelpCommand {
  readonly kind: "help";
}

/** Commands accepted by {@link parseCommandLine}. */
export type ShellCommand =
  | IpAddrShowCommand
  | IpAddrSetCommand
  | IpLinkShowCommand
  | IpLinkSetCommand
  | IpRouteShowCommand
  | IpNeighShowCommand
  | ArpCommand
  | PingCommand
  | TracerouteCommand
  | DigCommand
  | DhclientCommand
  | NcUdpCommand
  | NcTcpCommand
  | SsCommand
  | SendCommand
  | HttpServerCommand
  | HttpGetCommand
  | HelpCommand;

/** Parse outcome; failures are data, not exceptions. */
export type ShellParseResult =
  | { readonly ok: true; readonly value: ShellCommand }
  | { readonly ok: false; readonly error: ShellError };

function ok(value: ShellCommand): ShellParseResult {
  return { ok: true, value };
}

function fail(
  code: ShellError["code"],
  command: string,
  message: string,
): ShellParseResult {
  return { ok: false, error: shellError(code, command, message) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIpv4(text: string): boolean {
  try {
    Ipv4Address.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isIpv4Prefix(text: string): boolean {
  try {
    splitIpv4Prefix(text);
    return true;
  } catch {
    return false;
  }
}

function parseInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^[0-9]+$/.test(text)) {
    return undefined;
  }
  return Number.parseInt(text, 10);
}

/**
 * Accept the names `dig` can actually send: dotted labels, at most 253
 * characters, no empty label. A trailing dot is allowed and ignored.
 */
function isDnsName(text: string): boolean {
  const trimmed = text.endsWith(".") ? text.slice(0, -1) : text;
  if (trimmed.length === 0 || trimmed.length > 253) {
    return false;
  }
  return trimmed
    .split(".")
    .every(
      (label) => label.length <= 63 && DNS_LABEL.test(label.toLowerCase()),
    );
}

/** Optional `[dev] <iface>` filter shared by the show commands. */
function parseIfaceFilter(
  command: string,
  tokens: ReadonlyArray<string>,
  start: number,
):
  | { readonly ok: true; readonly iface?: string }
  | { readonly ok: false; readonly error: ShellError } {
  let iface: string | undefined;
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "dev") {
      const value = tokens[index + 1];
      if (value === undefined) {
        return {
          ok: false,
          error: shellError(
            "missing_argument",
            command,
            "dev needs an interface name",
          ),
        };
      }
      iface = value;
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      return {
        ok: false,
        error: shellError("unknown_flag", command, `unknown flag: ${token}`),
      };
    }
    if (iface !== undefined) {
      return {
        ok: false,
        error: shellError(
          "unexpected_argument",
          command,
          `unexpected argument: ${token}`,
        ),
      };
    }
    iface = token;
    index += 1;
  }
  return iface === undefined ? { ok: true } : { ok: true, iface };
}

function parseIpAddr(tokens: ReadonlyArray<string>): ShellParseResult {
  const verb = tokens[2];
  if (verb === "add" || verb === "set") {
    let ip: string | undefined;
    let iface: string | undefined;
    let gateway: string | undefined;
    let index = 3;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      if (token === "dev" || token === "gateway") {
        const value = tokens[index + 1];
        if (value === undefined) {
          return fail("missing_argument", "ip", `${token} needs a value`);
        }
        if (token === "dev") {
          iface = value;
        } else {
          gateway = value;
        }
        index += 2;
        continue;
      }
      if (token.startsWith("-")) {
        return fail("unknown_flag", "ip", `unknown flag: ${token}`);
      }
      if (ip !== undefined) {
        return fail(
          "unexpected_argument",
          "ip",
          `unexpected argument: ${token}`,
        );
      }
      ip = token;
      index += 1;
    }
    if (ip === undefined) {
      return fail("missing_argument", "ip", "ip addr set needs an address");
    }
    if (iface === undefined) {
      return fail("missing_argument", "ip", "ip addr set needs dev <iface>");
    }
    if (!isIpv4(ip) && !isIpv4Prefix(ip)) {
      return fail("invalid_argument", "ip", `invalid IPv4 address: ${ip}`);
    }
    if (gateway !== undefined && !isIpv4(gateway)) {
      return fail(
        "invalid_argument",
        "ip",
        `invalid gateway address: ${gateway}`,
      );
    }
    return gateway === undefined
      ? ok({ kind: "ip.addr.set", ip, iface })
      : ok({ kind: "ip.addr.set", ip, iface, gateway });
  }

  if (verb === undefined) {
    return ok({ kind: "ip.addr.show" });
  }
  if (verb === "show") {
    const filter = parseIfaceFilter("ip", tokens, 3);
    if (!filter.ok) {
      return { ok: false, error: filter.error };
    }
    return filter.iface === undefined
      ? ok({ kind: "ip.addr.show" })
      : ok({ kind: "ip.addr.show", iface: filter.iface });
  }
  return fail(
    "unknown_subcommand",
    "ip",
    `unknown ip addr subcommand: ${verb}`,
  );
}

function parseIpLink(tokens: ReadonlyArray<string>): ShellParseResult {
  const verb = tokens[2];
  if (verb === "set") {
    const iface = tokens[3];
    const state = tokens[4];
    if (iface === undefined || state === undefined) {
      return fail(
        "missing_argument",
        "ip",
        "usage: ip link set <iface> up|down",
      );
    }
    if (tokens.length > 5) {
      return fail(
        "unexpected_argument",
        "ip",
        `unexpected argument: ${tokens[5] ?? ""}`,
      );
    }
    if (state !== "up" && state !== "down") {
      return fail(
        "invalid_argument",
        "ip",
        `link state must be up or down: ${state}`,
      );
    }
    return ok({ kind: "ip.link.set", iface, up: state === "up" });
  }

  if (verb === undefined) {
    return ok({ kind: "ip.link.show" });
  }
  const filter = parseIfaceFilter("ip", tokens, verb === "show" ? 3 : 2);
  if (!filter.ok) {
    return { ok: false, error: filter.error };
  }
  return filter.iface === undefined
    ? ok({ kind: "ip.link.show" })
    : ok({ kind: "ip.link.show", iface: filter.iface });
}

function parseIpRoute(tokens: ReadonlyArray<string>): ShellParseResult {
  const verb = tokens[2];
  if (verb === undefined || verb === "show" || verb === "list") {
    if (tokens.length > 3) {
      return fail(
        "unexpected_argument",
        "ip",
        `unexpected argument: ${tokens[3] ?? ""}`,
      );
    }
    return ok({ kind: "ip.route.show" });
  }
  if (
    verb === "add" ||
    verb === "del" ||
    verb === "delete" ||
    verb === "replace"
  ) {
    return fail(
      "unsupported",
      "ip",
      `ip route ${verb} is not supported: the host table is derived from ` +
        "its interface configuration",
    );
  }
  return fail(
    "unknown_subcommand",
    "ip",
    `unknown ip route subcommand: ${verb}`,
  );
}

function parseIpNeigh(tokens: ReadonlyArray<string>): ShellParseResult {
  const verb = tokens[2];
  const start = verb === "show" ? 3 : 2;
  const filter = parseIfaceFilter("ip", tokens, start);
  if (!filter.ok) {
    return { ok: false, error: filter.error };
  }
  return filter.iface === undefined
    ? ok({ kind: "ip.neigh.show" })
    : ok({ kind: "ip.neigh.show", iface: filter.iface });
}

function parseIp(tokens: ReadonlyArray<string>): ShellParseResult {
  const subcommand = tokens[1];
  if (subcommand === undefined) {
    return fail(
      "missing_argument",
      "ip",
      "ip needs one of: addr, link, route, neigh",
    );
  }
  switch (subcommand) {
    case "addr":
      return parseIpAddr(tokens);
    case "link":
      return parseIpLink(tokens);
    case "route":
      return parseIpRoute(tokens);
    case "neigh":
      return parseIpNeigh(tokens);
    default:
      return fail(
        "unknown_subcommand",
        "ip",
        `unknown ip subcommand: ${subcommand}`,
      );
  }
}

function parseArp(tokens: ReadonlyArray<string>): ShellParseResult {
  if (tokens.length === 1) {
    return ok({ kind: "arp" });
  }
  if (tokens.length === 2 && tokens[1] === "-a") {
    return ok({ kind: "arp" });
  }
  const extra = tokens[1] ?? "";
  if (extra.startsWith("-")) {
    return fail("unknown_flag", "arp", `unknown flag: ${extra}`);
  }
  return fail("unexpected_argument", "arp", `unexpected argument: ${extra}`);
}

function parsePing(tokens: ReadonlyArray<string>): ShellParseResult {
  let count = DEFAULT_PING_COUNT;
  let size = DEFAULT_PING_SIZE;
  let ttl = DEFAULT_PING_TTL;
  let dst: string | undefined;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    index += 1;
    if (!token.startsWith("-")) {
      if (dst !== undefined) {
        return fail(
          "unexpected_argument",
          "ping",
          `unexpected argument: ${token}`,
        );
      }
      dst = token;
      continue;
    }
    const flag = token.slice(0, 2);
    if (flag !== "-c" && flag !== "-s" && flag !== "-t") {
      return fail("unknown_flag", "ping", `unknown flag: ${token}`);
    }
    let value = token.length > 2 ? token.slice(2) : undefined;
    if (value === undefined) {
      value = tokens[index];
      index += 1;
    }
    if (value === undefined) {
      return fail("missing_argument", "ping", `${flag} needs a value`);
    }
    const parsed = parseInteger(value);
    if (parsed === undefined) {
      return fail(
        "invalid_argument",
        "ping",
        `${flag} needs an integer: ${value}`,
      );
    }
    if (flag === "-c") {
      if (parsed < 1 || parsed > MAX_PING_COUNT) {
        return fail(
          "invalid_argument",
          "ping",
          `-c must be 1..${MAX_PING_COUNT}: ${parsed}`,
        );
      }
      count = parsed;
    } else if (flag === "-s") {
      if (parsed > MAX_PING_SIZE) {
        return fail(
          "invalid_argument",
          "ping",
          `-s must be at most ${MAX_PING_SIZE}: ${parsed}`,
        );
      }
      size = parsed;
    } else {
      if (parsed < 1 || parsed > 0xff) {
        return fail("invalid_argument", "ping", `-t must be 1..255: ${parsed}`);
      }
      ttl = parsed;
    }
  }
  if (dst === undefined) {
    return fail(
      "missing_argument",
      "ping",
      "usage: ping [-c n] [-s size] [-t ttl] dst",
    );
  }
  if (!isIpv4(dst)) {
    return fail("invalid_argument", "ping", `invalid IPv4 address: ${dst}`);
  }
  return ok({ kind: "ping", dst, count, size, ttl });
}

function parseTraceroute(tokens: ReadonlyArray<string>): ShellParseResult {
  const dst = tokens[1];
  if (dst === undefined) {
    return fail("missing_argument", "traceroute", "usage: traceroute dst");
  }
  if (dst.startsWith("-")) {
    return fail("unknown_flag", "traceroute", `unknown flag: ${dst}`);
  }
  if (tokens.length > 2) {
    return fail(
      "unexpected_argument",
      "traceroute",
      `unexpected argument: ${tokens[2] ?? ""}`,
    );
  }
  if (!isIpv4(dst)) {
    return fail(
      "invalid_argument",
      "traceroute",
      `invalid IPv4 address: ${dst}`,
    );
  }
  return ok({ kind: "traceroute", dst });
}

/**
 * `dig [@SERVER] NAME [A]`: one A query against an explicit or default
 * resolver. Every other record type is rejected as unsupported.
 */
function parseDig(tokens: ReadonlyArray<string>): ShellParseResult {
  const usage = "usage: dig [@SERVER] NAME [A]";
  let server: string | undefined;
  let name: string | undefined;
  let type: string | undefined;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    index += 1;
    if (token.startsWith("@")) {
      if (server !== undefined) {
        return fail(
          "unexpected_argument",
          "dig",
          `unexpected argument: ${token}`,
        );
      }
      const value = token.slice(1);
      if (value.length === 0) {
        return fail("missing_argument", "dig", "@ needs a server address");
      }
      server = value;
      continue;
    }
    if (token.startsWith("-")) {
      return fail("unknown_flag", "dig", `unknown flag: ${token}`);
    }
    if (name === undefined) {
      name = token;
      continue;
    }
    if (type === undefined) {
      type = token;
      continue;
    }
    return fail("unexpected_argument", "dig", `unexpected argument: ${token}`);
  }
  if (name === undefined) {
    return fail("missing_argument", "dig", usage);
  }
  if (server !== undefined && !isIpv4(server)) {
    return fail(
      "invalid_argument",
      "dig",
      `invalid DNS server address: ${server}`,
    );
  }
  if (!isDnsName(name)) {
    return fail("invalid_argument", "dig", `invalid name: ${name}`);
  }
  if (type !== undefined && type.toLowerCase() !== "a") {
    return fail("unsupported", "dig", `only A records are supported: ${type}`);
  }
  const normalized = name.endsWith(".") ? name.slice(0, -1) : name;
  return server === undefined
    ? ok({ kind: "dig", name: normalized })
    : ok({ kind: "dig", name: normalized, server });
}

/** `dhclient [IFACE]`: DORA on one interface, no flags to interpret. */
function parseDhclient(tokens: ReadonlyArray<string>): ShellParseResult {
  const iface = tokens[1];
  if (iface === undefined) {
    return ok({ kind: "dhclient" });
  }
  if (iface.startsWith("-")) {
    return fail("unknown_flag", "dhclient", `unknown flag: ${iface}`);
  }
  if (tokens.length > 2) {
    return fail(
      "unexpected_argument",
      "dhclient",
      `unexpected argument: ${tokens[2] ?? ""}`,
    );
  }
  return ok({ kind: "dhclient", iface });
}

/**
 * `nc [-u] HOST PORT [HEX]`: TCP by default, UDP with `-u`.
 *
 * Only the transport flag is modelled: listen mode (`-l`) and every other
 * flag stay typed `unknown_flag`, and the payload is still lowercase hex so
 * the printed output is stable.
 */
function parseNc(tokens: ReadonlyArray<string>): ShellParseResult {
  const usage = "usage: nc [-u] HOST PORT [HEX]";
  const first = tokens[1];
  if (first === undefined) {
    return fail("missing_argument", "nc", usage);
  }
  let udp = false;
  let hostIndex = 1;
  if (first === "-u") {
    udp = true;
    hostIndex = 2;
  } else if (first.startsWith("-")) {
    return fail("unknown_flag", "nc", `unknown flag: ${first}`);
  }
  const host = tokens[hostIndex];
  const portText = tokens[hostIndex + 1];
  if (host === undefined || portText === undefined) {
    return fail("missing_argument", "nc", usage);
  }
  const payloadIndex = hostIndex + 2;
  const extra = tokens[payloadIndex + 1];
  if (extra !== undefined) {
    return fail("unexpected_argument", "nc", `unexpected argument: ${extra}`);
  }
  if (host.startsWith("-")) {
    return fail("unknown_flag", "nc", `unknown flag: ${host}`);
  }
  if (!isIpv4(host)) {
    return fail("invalid_argument", "nc", `invalid host: ${host}`);
  }
  const port = parseInteger(portText);
  if (port === undefined || port < 1 || port > 0xffff) {
    return fail("invalid_argument", "nc", `port must be 1..65535: ${portText}`);
  }
  const payload = tokens[payloadIndex] ?? "";
  if (!/^[0-9a-fA-F]*$/.test(payload)) {
    return fail("invalid_argument", "nc", `payload must be hex: ${payload}`);
  }
  if (payload.length % 2 !== 0) {
    return fail(
      "invalid_argument",
      "nc",
      `payload needs an even number of hex digits: ${payload}`,
    );
  }
  if (payload.length / 2 > MAX_NC_PAYLOAD_BYTES) {
    return fail(
      "invalid_argument",
      "nc",
      `payload must be at most ${MAX_NC_PAYLOAD_BYTES} bytes`,
    );
  }
  const command = { host, port, payload: payload.toLowerCase() };
  return ok(
    udp ? { kind: "nc.udp", ...command } : { kind: "nc.tcp", ...command },
  );
}

/** `ss`: no flags and no filters yet, so any argument is a typed rejection. */
function parseSs(tokens: ReadonlyArray<string>): ShellParseResult {
  const argument = tokens[1];
  if (argument === undefined) {
    return ok({ kind: "ss" });
  }
  if (argument.startsWith("-")) {
    return fail("unknown_flag", "ss", `unknown flag: ${argument}`);
  }
  return fail("unexpected_argument", "ss", `unexpected argument: ${argument}`);
}

/** `0x0800` / `2048` / `0x86dd` → an EtherType, or undefined when invalid. */
function parseEtherTypeValue(text: string): number | undefined {
  const value = /^0x[0-9a-f]+$/i.test(text)
    ? Number.parseInt(text.slice(2), 16)
    : /^[0-9]+$/.test(text)
      ? Number.parseInt(text, 10)
      : Number.NaN;
  return Number.isInteger(value) && value >= 0 && value <= 0xffff
    ? value
    : undefined;
}

function isMac(text: string): boolean {
  try {
    MacAddress.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * `send IFACE DSTMAC ETHERTYPE HEX`: build one Ethernet frame by hand (F-101).
 *
 * Everything is explicit — the destination MAC is never resolved, the
 * ethertype accepts both `0x0806` and `2054`, and the payload is lowercase
 * hex like `nc`. Short frames are padded by the serializer to the Ethernet
 * minimum; that is a wire detail the command result reports, not a parser
 * concern.
 */
function parseSend(tokens: ReadonlyArray<string>): ShellParseResult {
  const usage = "usage: send IFACE DSTMAC ETHERTYPE HEX";
  const iface = tokens[1];
  if (iface === undefined) {
    return fail("missing_argument", "send", usage);
  }
  if (iface.startsWith("-")) {
    return fail("unknown_flag", "send", `unknown flag: ${iface}`);
  }
  const dstMac = tokens[2];
  const etherTypeText = tokens[3];
  const hex = tokens[4];
  if (
    dstMac === undefined ||
    etherTypeText === undefined ||
    hex === undefined
  ) {
    return fail("missing_argument", "send", usage);
  }
  const extra = tokens[5];
  if (extra !== undefined) {
    return fail("unexpected_argument", "send", `unexpected argument: ${extra}`);
  }
  if (!isMac(dstMac)) {
    return fail("invalid_argument", "send", `invalid MAC address: ${dstMac}`);
  }
  const etherType = parseEtherTypeValue(etherTypeText);
  if (etherType === undefined) {
    return fail(
      "invalid_argument",
      "send",
      `ethertype must be 0..0xFFFF: ${etherTypeText}`,
    );
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    return fail("invalid_argument", "send", `payload must be hex: ${hex}`);
  }
  if (hex.length % 2 !== 0) {
    return fail(
      "invalid_argument",
      "send",
      `payload needs an even number of hex digits: ${hex}`,
    );
  }
  return ok({
    kind: "send",
    iface,
    dstMac: MacAddress.parse(dstMac).toString(),
    etherType,
    payload: hex.toLowerCase(),
  });
}

/** `http-server [PORT]`: one optional listening port, nothing else. */
function parseHttpServer(tokens: ReadonlyArray<string>): ShellParseResult {
  const portText = tokens[1];
  if (portText === undefined) {
    return ok({ kind: "http.server" });
  }
  if (portText.startsWith("-")) {
    return fail("unknown_flag", "http-server", `unknown flag: ${portText}`);
  }
  const extra = tokens[2];
  if (extra !== undefined) {
    return fail(
      "unexpected_argument",
      "http-server",
      `unexpected argument: ${extra}`,
    );
  }
  const port = parseInteger(portText);
  if (port === undefined || port < 1 || port > 0xffff) {
    return fail(
      "invalid_argument",
      "http-server",
      `port must be 1..65535: ${portText}`,
    );
  }
  return ok({ kind: "http.server", port });
}

/**
 * `curl http://HOST[:PORT][/PATH]`, with the scheme optional.
 *
 * The lab shell has no name service in the parser, so the host must be an
 * IPv4 literal; `https://` is an explicit `unsupported` (there is no TLS on
 * this stack), and the path defaults to `/`. The URL is one token: everything
 * after the authority is the request target.
 */
function parseCurl(tokens: ReadonlyArray<string>): ShellParseResult {
  const usage = "usage: curl http://HOST[:PORT][/PATH]";
  const url = tokens[1];
  if (url === undefined) {
    return fail("missing_argument", "curl", usage);
  }
  if (url.startsWith("-")) {
    return fail("unknown_flag", "curl", `unknown flag: ${url}`);
  }
  const extra = tokens[2];
  if (extra !== undefined) {
    return fail("unexpected_argument", "curl", `unexpected argument: ${extra}`);
  }
  let rest = url;
  if (rest.startsWith("http://")) {
    rest = rest.slice("http://".length);
  } else if (rest.includes("://")) {
    return fail("unsupported", "curl", `only http:// is supported: ${url}`);
  }
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  if (authority.length === 0) {
    return fail("missing_argument", "curl", `URL has no host: ${url}`);
  }
  if (path.length === 0) {
    return fail("invalid_argument", "curl", `invalid request target: ${url}`);
  }
  const colon = authority.indexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  const portText = colon === -1 ? undefined : authority.slice(colon + 1);
  if (!isIpv4(host)) {
    return fail("invalid_argument", "curl", `invalid host: ${host}`);
  }
  let port = DEFAULT_HTTP_PORT;
  if (portText !== undefined) {
    const parsed = parseInteger(portText);
    if (parsed === undefined || parsed < 1 || parsed > 0xffff) {
      return fail(
        "invalid_argument",
        "curl",
        `port must be 1..65535: ${portText}`,
      );
    }
    port = parsed;
  }
  return ok({ kind: "http.get", host, port, path });
}

function parse(line: string): ShellParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return fail("empty_command", "", "empty command line");
  }
  const tokens = trimmed.split(/\s+/);
  const command = tokens[0] ?? "";
  switch (command) {
    case "ip":
      return parseIp(tokens);
    case "ping":
      return parsePing(tokens);
    case "traceroute":
      return parseTraceroute(tokens);
    case "dig":
      return parseDig(tokens);
    case "dhclient":
      return parseDhclient(tokens);
    case "nc":
      return parseNc(tokens);
    case "ss":
      return parseSs(tokens);
    case "send":
      return parseSend(tokens);
    case "http-server":
      return parseHttpServer(tokens);
    case "curl":
      return parseCurl(tokens);
    case "arp":
      return parseArp(tokens);
    case "help":
      if (tokens.length > 1) {
        return fail(
          "unexpected_argument",
          "help",
          `unexpected argument: ${tokens[1] ?? ""}`,
        );
      }
      return ok({ kind: "help" });
    default:
      return fail("unknown_command", command, `unknown command: ${command}`);
  }
}

/**
 * Parse one shell line. Never throws: malformed input returns `ok: false`
 * with a typed {@link ShellError} (S9).
 */
export function parseCommandLine(line: string): ShellParseResult {
  try {
    return parse(line);
  } catch (error) {
    // Defence in depth: a future helper that throws must not break S9.
    return fail(
      "invalid_argument",
      "",
      `invalid command line: ${message(error)}`,
    );
  }
}
