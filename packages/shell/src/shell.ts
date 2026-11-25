/**
 * Minimal network shell over a live Host + Simulation (S7).
 *
 * Execution is synchronous with respect to virtual time: each command that
 * needs a reply calls `sim.runUntil()` with an absolute virtual deadline and
 * then reads the Host callbacks. Nothing waits on wall-clock time and no
 * promise is raced against the simulation clock; `exec()` merely resolves
 * after the synchronous work.
 *
 * Host callbacks (`onEchoReply` / `onIcmpError`) are chained: a handler
 * installed before the shell is constructed keeps working. Code that
 * replaces those properties after construction takes ownership back.
 *
 * Fase 5 adds the TCP surface on top of that: `nc` (TCP by default, UDP with
 * `-u`), `ss`, and a minimal HTTP/1.0 client/server. The HTTP slice is
 * deliberately narrow: one `GET` request per connection, a fixed page served
 * with `Content-Length` and `Connection: close`; no keep-alive, no pipelining,
 * no chunked transfer encoding and no redirects. `http-server` installs an
 * event-driven listener and returns, so the clock only moves when another
 * command (or a test) talks to it.
 *
 * Fase 6 adds the packet crafter (F-101): `send` transmits one hand-built
 * Ethernet frame through `Host.sendRaw()`. It is the CLI half of the feature;
 * the layered web form is a UI concern and lives outside this package.
 *
 * Fase 6 also adds the subnetting trainer session (F-117): `subnet new` draws a
 * drill with the simulation PRNG, keeps it pending and prints it, and
 * `subnet answer` grades it and explains the correction step by step. The
 * generator itself lives in `@netlab/exercises` and arrives through
 * `ShellOptions.subnet`: the shell owns the session, the trainer owns the
 * math, and the two packages stay siblings (ADR-001) instead of forming an
 * import cycle.
 */

import { Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  DEFAULT_DHCP_RETRIES,
  DEFAULT_DHCP_TIMEOUT_US,
  DEFAULT_DNS_PORT,
  DEFAULT_DNS_RETRIES,
  DEFAULT_DNS_TIMEOUT_US,
  DEFAULT_IPV4_MTU,
  DhcpClient,
  DnsResolver,
  type Host,
  type HostEchoReply,
  type HostIcmpError,
  type HostIpConfigInput,
  type Simulation,
  TcpSocket,
} from "@netlab/core";
import {
  ETHERNET_HEADER_LENGTH,
  ETHERNET_MIN_FRAME_LENGTH,
  ICMP_CODE_FRAG_NEEDED,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  IPV4_PROTOCOL_ICMP,
} from "@netlab/protocols";
import { ShellCommandError, shellError } from "./errors";
import {
  bytesToHex,
  formatAddressLines,
  formatArpLines,
  formatDhclientLines,
  formatDigLines,
  formatHttpGetLines,
  formatIpNeighLines,
  formatLinkLines,
  formatNcTcpLines,
  formatNcUdpLines,
  formatRouteLines,
  formatSendLines,
  formatSsLines,
  formatSubnetAnswerLines,
  formatSubnetProblemLines,
} from "./format";
import {
  hostNeighborEntries,
  type NeighborCandidate,
  type NeighborEntry,
  type NeighborProvider,
  sortNeighborEntries,
} from "./neighbors";
import {
  DEFAULT_HTTP_PORT,
  type DhclientCommand,
  type DigCommand,
  type HttpGetCommand,
  type HttpServerCommand,
  type NcTcpCommand,
  type NcUdpCommand,
  type PingCommand,
  parseCommandLine,
  type SendCommand,
  type ShellCommand,
  SUBNET_TOPICS,
  type SubnetAnswerCommand,
  type SubnetNewCommand,
  type SubnetTopic,
  type TracerouteCommand,
} from "./parse";

/** Virtual wait for one Echo Reply before the probe counts as lost. */
export const DEFAULT_PING_TIMEOUT_US = 1_000_000;
/** Virtual spacing between sequential ping requests. */
export const DEFAULT_PING_INTERVAL_US = 1_000_000;
/** Virtual wait per traceroute hop. */
export const DEFAULT_TRACEROUTE_TIMEOUT_US = 1_000_000;
/** TTL budgets tried by `traceroute` before giving up. */
export const DEFAULT_TRACEROUTE_MAX_HOPS = 30;
/** Virtual wait per `dig` attempt; mirrors the core resolver default. */
export const DEFAULT_DIG_TIMEOUT_US = DEFAULT_DNS_TIMEOUT_US;
/** Retransmissions per `dig`; mirrors the core resolver default. */
export const DEFAULT_DIG_RETRIES = DEFAULT_DNS_RETRIES;
/** Virtual wait per `dhclient` attempt; mirrors the core client default. */
export const DEFAULT_DHCLIENT_TIMEOUT_US = DEFAULT_DHCP_TIMEOUT_US;
/** Retransmissions per `dhclient`; mirrors the core client default. */
export const DEFAULT_DHCLIENT_RETRIES = DEFAULT_DHCP_RETRIES;
/** Virtual window `nc` keeps collecting replies and `curl` waits for the page. */
export const DEFAULT_NC_TIMEOUT_US = 1_000_000;

/** First port the shell binds for its own UDP sockets (dynamic range). */
const UDP_PORT_START = 49200;

/** Echo data size used by traceroute probes. */
const TRACEROUTE_SIZE = 32;

/**
 * Connections a shell HTTP server holds at once: the accept backlog of the
 * listener it installs. Beyond this a new SYN is dropped and the peer retries.
 */
const HTTP_BACKLOG = 4;

/** Empty payload shared by the hot paths that need zero bytes. */
const NO_BYTES = new Uint8Array(0);

/**
 * Fixed page served at `GET /`. Pure ASCII, so a character is a byte and
 * `Content-Length` is `HTTP_PAGE.length`.
 */
const HTTP_PAGE = [
  "<!doctype html>",
  "<html>",
  "<head><title>netlab</title></head>",
  "<body>",
  "<h1>netlab</h1>",
  "<p>Servidor HTTP/1.0 de ejemplo.</p>",
  "</body>",
  "</html>",
  "",
].join("\n");
const HTTP_NOT_FOUND = "<h1>404 Not Found</h1>\n";
const HTTP_BAD_REQUEST = "<h1>400 Bad Request</h1>\n";
const HTTP_METHOD_NOT_ALLOWED = "<h1>405 Method Not Allowed</h1>\n";

/** Static listing for the `help` command (no state, no clock). */
const HELP_LINES: ReadonlyArray<string> = [
  "ip addr [show] [dev IFACE] - show addresses",
  "ip link [show] - show link state",
  "ip route show - show routes",
  "ip neigh show - show neighbor cache",
  "arp - show ARP cache",
  "ping [-c COUNT] [-s SIZE] [-t TTL] DST - echo requests",
  "traceroute DST - trace hops",
  "dig [@SERVER] NAME [A] - resolve a name over DNS",
  "dhclient [IFACE] - obtain an address over DHCP",
  "nc [-u] HOST PORT [HEX] - send a TCP payload (UDP with -u) and print replies",
  "ss - list TCP sockets with state, addresses and cwnd/ssthresh",
  "send IFACE DSTMAC ETHERTYPE HEX - transmit a hand-built Ethernet frame",
  "http-server [PORT] - serve a fixed HTTP/1.0 page (default 80)",
  "curl http://HOST[:PORT][/PATH] - one HTTP/1.0 GET, print the body",
  `subnet new [${SUBNET_TOPICS.join("|")}] - start a subnetting drill`,
  "subnet answer VALUE... - grade the pending drill, step by step",
  "help - this list",
];

/** One graded answer, as the injected subnetting trainer reports it (F-117). */
export interface SubnetCheckLike {
  /** True when every field matched. */
  readonly pass: boolean;
  /** Canonical answer, one `field=value` pair per asked field. */
  readonly expected: string;
  /** The correction, explained step by step. */
  readonly steps: ReadonlyArray<string>;
}

/**
 * One drill, as the injected subnetting trainer reports it (F-117).
 *
 * The shell reads `topic`, `prompt`, `fields` and `check`; the rest of the
 * drill travels with it so a UI can render the statements it already has.
 * `generateSubnetProblem` from `@netlab/exercises` fits as is.
 */
export interface SubnetProblemLike {
  readonly topic: SubnetTopic;
  readonly title: string;
  readonly prompt: string;
  readonly fields: ReadonlyArray<string>;
  readonly expected: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
  check(answer: string): SubnetCheckLike;
}

/**
 * Injected subnetting trainer: `(topic, rand) => drill`.
 *
 * `rand` is the simulation PRNG (`sim.random.next`), so a replayed lab draws
 * the same drill. `generateSubnetProblem` from `@netlab/exercises` satisfies
 * this shape as is.
 */
export type SubnetTrainer = (
  topic: SubnetTopic,
  rand: () => number,
) => SubnetProblemLike;

/** Accepted by the {@link Shell} constructor. */
export interface ShellOptions {
  /** Host the commands operate on. */
  host: Host;
  /** Simulation whose virtual clock the commands advance. */
  sim: Simulation;
  /**
   * MTU displayed by `ip addr` / `ip link`. Host interfaces do not model an
   * MTU yet, so this is presentation-only and defaults to 1500.
   */
  mtu?: number;
  /** Custom neighbor snapshot; default resolves gateways/seens via ARP. */
  neighbors?: NeighborProvider;
  /** Virtual wait per ping request. */
  pingTimeoutUs?: number;
  /** Virtual spacing between ping requests. */
  pingIntervalUs?: number;
  /** Virtual wait per traceroute hop. */
  tracerouteTimeoutUs?: number;
  /** Maximum TTL tried by traceroute (1..255). */
  tracerouteMaxHops?: number;
  /**
   * Resolver `dig` uses when the command has no `@SERVER`. Defaults to the
   * gateway of the first configured interface, matching the DNS server a
   * host learns over DHCP.
   */
  dnsServer?: string;
  /** Resolver port for `dig`; default {@link DEFAULT_DNS_PORT}. */
  dnsPort?: number;
  /** Virtual wait per `dig` attempt. */
  digTimeoutUs?: number;
  /** Retransmissions per `dig` (total attempts = retries + 1). */
  digRetries?: number;
  /** Virtual wait per `dhclient` attempt. */
  dhcpTimeoutUs?: number;
  /** Retransmissions per `dhclient` (total attempts = retries + 1). */
  dhcpRetries?: number;
  /** Virtual window `nc` keeps collecting replies. */
  ncTimeoutUs?: number;
  /**
   * Subnetting trainer used by `subnet new` (F-117). Without it the command
   * is an explicit `unsupported` error; the CLI and the UI pass
   * `generateSubnetProblem` from `@netlab/exercises`.
   */
  subnet?: SubnetTrainer;
}

interface ProbeOutcome {
  reply: HostEchoReply | undefined;
  replyAt: number | undefined;
  error: HostIcmpError | undefined;
  errorAt: number | undefined;
  /** Absolute virtual deadline; late callbacks are ignored. */
  deadline: number;
}

interface ActiveProbe {
  readonly key: string;
  readonly dst: string;
  readonly outcome: ProbeOutcome;
}

interface ProbeInput {
  dst: string;
  identifier: number;
  sequence: number;
  ttl: number;
  size: number;
  timeoutUs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite value >= 0: ${value}`);
  }
  return value;
}

function checkMtu(value: number): number {
  if (!Number.isInteger(value) || value < 68) {
    throw new RangeError(`mtu must be an integer >= 68: ${value}`);
  }
  return value;
}

function checkMaxHops(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xff) {
    throw new RangeError(
      `tracerouteMaxHops must be an integer 1..255: ${value}`,
    );
  }
  return value;
}

function checkPort(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be an integer 0..65535: ${value}`);
  }
  return value;
}

function checkRetries(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer: ${value}`);
  }
  return value;
}

function checkAddress(name: string, value: string): string {
  try {
    return Ipv4Address.parse(value).toString();
  } catch {
    throw new RangeError(`${name} must be an IPv4 address: ${value}`);
  }
}

/** Decode the already-validated lowercase hex payload of `nc -u`. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function byteAt(data: Uint8Array, index: number): number {
  return data[index] ?? 0;
}

/**
 * Recover `<identifier>:<sequence>` from the ICMP Echo Request embedded in
 * an ICMP error (RFC 792 embeds the IPv4 header plus the first 8 payload
 * bytes). Returns undefined for anything that is not an echo request.
 */
function embeddedEchoKey(embedded: Uint8Array): string | undefined {
  if (embedded.length < 28) {
    return undefined;
  }
  if (byteAt(embedded, 0) >>> 4 !== 4) {
    return undefined;
  }
  const ihl = (byteAt(embedded, 0) & 0x0f) * 4;
  if (ihl < 20 || embedded.length < ihl + 8) {
    return undefined;
  }
  if (byteAt(embedded, 9) !== IPV4_PROTOCOL_ICMP) {
    return undefined;
  }
  if (byteAt(embedded, ihl) !== ICMP_TYPE_ECHO_REQUEST) {
    return undefined;
  }
  const identifier =
    (byteAt(embedded, ihl + 4) << 8) | byteAt(embedded, ihl + 5);
  const sequence = (byteAt(embedded, ihl + 6) << 8) | byteAt(embedded, ihl + 7);
  return `${identifier}:${sequence}`;
}

/** Human-readable ICMP error summary shared by ping and traceroute. */
function describeIcmpError(error: HostIcmpError): string {
  if (error.type === ICMP_TYPE_TIME_EXCEEDED) {
    return "Time to live exceeded";
  }
  if (error.type === ICMP_TYPE_DEST_UNREACHABLE) {
    if (error.code === ICMP_CODE_FRAG_NEEDED) {
      return error.mtu === undefined
        ? "Fragmentation needed"
        : `Fragmentation needed (mtu ${error.mtu})`;
    }
    const names: Record<number, string> = {
      0: "Network unreachable",
      1: "Host unreachable",
      2: "Protocol unreachable",
      3: "Port unreachable",
    };
    return names[error.code] ?? `Destination unreachable (code ${error.code})`;
  }
  return `ICMP type ${error.type} code ${error.code}`;
}

/** `--` never reached: keeps the command switch exhaustive at compile time. */
function assertNever(value: never): never {
  throw new Error(`unhandled shell command: ${JSON.stringify(value)}`);
}

/** Concatenate byte arrays into one fresh buffer. */
function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * ASCII encode without `TextEncoder`: HTTP headers and the fixed page are pure
 * ASCII by construction, so a character is a byte.
 */
function asciiToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index) & 0x7f;
  }
  return bytes;
}

/** Decode bytes as ASCII; used only on HTTP traffic this stack produced. */
function asciiFromBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

/** Index just past the blank line that ends the HTTP headers, or -1. */
function httpHeadEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index++) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index + 4;
    }
  }
  return -1;
}

/**
 * One HTTP/1.0 GET request: request line, `Host`, a fixed user agent and
 * `Accept`, then the blank line that closes the header block (F-75).
 */
function httpRequestBytes(command: HttpGetCommand): Uint8Array {
  const host =
    command.port === DEFAULT_HTTP_PORT
      ? command.host
      : `${command.host}:${command.port}`;
  return asciiToBytes(
    `GET ${command.path} HTTP/1.0\r\n` +
      `Host: ${host}\r\n` +
      "User-Agent: netlab-curl\r\n" +
      "Accept: */*\r\n" +
      "\r\n",
  );
}

/** Serialize a minimal HTTP/1.0 response with `Content-Length` and close. */
function httpReply(status: number, reason: string, body: string): Uint8Array {
  const head =
    `HTTP/1.0 ${status} ${reason}\r\n` +
    "Content-Type: text/html; charset=utf-8\r\n" +
    `Content-Length: ${body.length}\r\n` +
    "Connection: close\r\n" +
    "\r\n";
  return asciiToBytes(head + body);
}

/**
 * Route one request line to the fixed page, a 404 or the method error.
 *
 * The server models exactly one route (`GET /`) and one payload: any other
 * target is a 404 and any other method a 405, both with a short HTML body.
 */
function httpReplyFor(requestLine: string): Uint8Array {
  const [method = "", target = ""] = requestLine.split(" ");
  if (method.length === 0 || target.length === 0) {
    return httpReply(400, "Bad Request", HTTP_BAD_REQUEST);
  }
  if (method !== "GET") {
    return httpReply(405, "Method Not Allowed", HTTP_METHOD_NOT_ALLOWED);
  }
  if (target !== "/") {
    return httpReply(404, "Not Found", HTTP_NOT_FOUND);
  }
  return httpReply(200, "OK", HTTP_PAGE);
}

/** Status line and body of one HTTP response, as `curl` reports them. */
interface HttpResponse {
  readonly statusCode: number;
  readonly reason: string;
  readonly body: string;
}

/**
 * Parse an HTTP/1.0 response: status line, headers up to the blank line and a
 * body trimmed to `Content-Length` when the header is present.
 *
 * Chunked transfer encoding is out of scope by design: this stack only speaks
 * `Content-Length` bodies and one response per connection. A response whose
 * headers never end or whose status line does not match is `undefined`, which
 * the caller turns into a typed execution error.
 */
function parseHttpResponse(bytes: Uint8Array): HttpResponse | undefined {
  const end = httpHeadEnd(bytes);
  if (end === -1) {
    return undefined;
  }
  const lines = asciiFromBytes(bytes.subarray(0, end - 4)).split("\r\n");
  const statusLine = lines[0] ?? "";
  const matched = /^HTTP\/1\.[01] ([0-9]{3})(?: (.*))?$/.exec(statusLine);
  if (matched === null) {
    return undefined;
  }
  const statusCode = Number.parseInt(matched[1] ?? "0", 10);
  const reason = matched[2] ?? "";
  let contentLength: number | undefined;
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") {
      continue;
    }
    const parsed = Number.parseInt(line.slice(colon + 1).trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      contentLength = parsed;
    }
  }
  const body = bytes.subarray(end);
  const length =
    contentLength === undefined
      ? body.length
      : Math.min(contentLength, body.length);
  return {
    statusCode,
    reason,
    body: asciiFromBytes(body.subarray(0, length)),
  };
}

export class Shell {
  private readonly host: Host;
  private readonly sim: Simulation;
  private readonly mtu: number;
  private readonly pingTimeoutUs: number;
  private readonly pingIntervalUs: number;
  private readonly tracerouteTimeoutUs: number;
  private readonly tracerouteMaxHops: number;
  private readonly dnsServer: string | undefined;
  private readonly dnsPort: number;
  private readonly digTimeoutUs: number;
  private readonly digRetries: number;
  private readonly dhcpTimeoutUs: number;
  private readonly dhcpRetries: number;
  private readonly ncTimeoutUs: number;
  private readonly neighbors: NeighborProvider;
  /** Injected subnetting trainer; absent means `subnet new` is unsupported. */
  private readonly subnet: SubnetTrainer | undefined;
  /** Candidate neighbors learned from successful sends, per interface. */
  private readonly peers = new Map<string, Set<string>>();
  /** One stub resolver per server, so its TTL cache survives the command. */
  private readonly resolvers = new Map<string, DnsResolver>();
  private activeProbe: ActiveProbe | undefined;
  private identifierSeed = 0x4e00;
  private udpPortSeed = UDP_PORT_START - 1;
  /** HTTP servers installed by `http-server`, keyed by listening port. */
  private readonly httpServers = new Map<number, TcpSocket>();
  /** Request bytes accumulated per accepted HTTP connection. */
  private readonly httpRequests = new Map<TcpSocket, Uint8Array>();
  /** Drill waiting for `subnet answer`, replaced by the next `subnet new`. */
  private pendingSubnet: SubnetProblemLike | undefined;

  constructor(options: ShellOptions) {
    this.host = options.host;
    this.sim = options.sim;
    this.mtu = checkMtu(options.mtu ?? DEFAULT_IPV4_MTU);
    this.pingTimeoutUs = checkDuration(
      "pingTimeoutUs",
      options.pingTimeoutUs ?? DEFAULT_PING_TIMEOUT_US,
    );
    this.pingIntervalUs = checkDuration(
      "pingIntervalUs",
      options.pingIntervalUs ?? DEFAULT_PING_INTERVAL_US,
    );
    this.tracerouteTimeoutUs = checkDuration(
      "tracerouteTimeoutUs",
      options.tracerouteTimeoutUs ?? DEFAULT_TRACEROUTE_TIMEOUT_US,
    );
    this.tracerouteMaxHops = checkMaxHops(
      options.tracerouteMaxHops ?? DEFAULT_TRACEROUTE_MAX_HOPS,
    );
    this.dnsServer =
      options.dnsServer === undefined
        ? undefined
        : checkAddress("dnsServer", options.dnsServer);
    this.dnsPort = checkPort("dnsPort", options.dnsPort ?? DEFAULT_DNS_PORT);
    this.digTimeoutUs = checkDuration(
      "digTimeoutUs",
      options.digTimeoutUs ?? DEFAULT_DIG_TIMEOUT_US,
    );
    this.digRetries = checkRetries(
      "digRetries",
      options.digRetries ?? DEFAULT_DIG_RETRIES,
    );
    this.dhcpTimeoutUs = checkDuration(
      "dhcpTimeoutUs",
      options.dhcpTimeoutUs ?? DEFAULT_DHCLIENT_TIMEOUT_US,
    );
    this.dhcpRetries = checkRetries(
      "dhcpRetries",
      options.dhcpRetries ?? DEFAULT_DHCLIENT_RETRIES,
    );
    this.ncTimeoutUs = checkDuration(
      "ncTimeoutUs",
      options.ncTimeoutUs ?? DEFAULT_NC_TIMEOUT_US,
    );
    this.neighbors =
      options.neighbors ??
      ((host) => hostNeighborEntries(host, this.neighborCandidates()));
    this.subnet = options.subnet;

    const previousReply = this.host.onEchoReply;
    const previousError = this.host.onIcmpError;
    this.host.onEchoReply = (reply) => {
      this.captureReply(reply);
      previousReply?.(reply);
    };
    this.host.onIcmpError = (error) => {
      this.captureError(error);
      previousError?.(error);
    };
  }

  /**
   * Execute one command line. Resolves to the output lines (empty when the
   * command only mutates state); rejects with {@link ShellCommandError} for
   * parse or execution failures. Virtual time advances synchronously.
   */
  exec(line: string): Promise<Array<string>> {
    const parsed = parseCommandLine(line);
    if (!parsed.ok) {
      return Promise.reject(new ShellCommandError(parsed.error));
    }
    try {
      return Promise.resolve(this.run(parsed.value));
    } catch (error) {
      return Promise.reject(
        error instanceof ShellCommandError
          ? error
          : new ShellCommandError(
              shellError(
                "execution_failed",
                parsed.value.kind.split(".")[0] ?? "shell",
                errorMessage(error),
              ),
            ),
      );
    }
  }

  /** Same as {@link exec} with the lines joined by a newline. */
  async execText(line: string): Promise<string> {
    return (await this.exec(line)).join("\n");
  }

  private run(command: ShellCommand): Array<string> {
    switch (command.kind) {
      case "ip.addr.show":
        this.requireInterface(command.iface, "ip");
        return formatAddressLines(this.host, this.mtu, command.iface);
      case "ip.addr.set":
        return this.setAddress(command.iface, command.ip, command.gateway);
      case "ip.link.show":
        this.requireInterface(command.iface, "ip");
        return formatLinkLines(this.host, this.mtu, command.iface);
      case "ip.link.set":
        this.requireInterface(command.iface, "ip");
        this.host.getInterface(command.iface).up = command.up;
        return [];
      case "ip.route.show":
        return formatRouteLines(this.host);
      case "ip.neigh.show":
        this.requireInterface(command.iface, "ip");
        return formatIpNeighLines(this.neighborEntries(command.iface));
      case "arp":
        return formatArpLines(this.neighborEntries());
      case "ping":
        return this.ping(command);
      case "traceroute":
        return this.traceroute(command);
      case "dig":
        return this.dig(command);
      case "dhclient":
        return this.dhclient(command);
      case "nc.udp":
        return this.ncUdp(command);
      case "nc.tcp":
        return this.ncTcp(command);
      case "ss":
        return this.ss();
      case "send":
        return this.send(command);
      case "http.server":
        return this.httpServer(command);
      case "http.get":
        return this.httpGet(command);
      case "subnet.new":
        return this.subnetNew(command);
      case "subnet.answer":
        return this.subnetAnswer(command);
      case "help":
        return [...HELP_LINES];
      default:
        return assertNever(command);
    }
  }

  private setAddress(
    iface: string,
    ip: string,
    gateway: string | undefined,
  ): Array<string> {
    this.requireInterface(iface, "ip");
    const config: HostIpConfigInput =
      gateway === undefined ? { ip } : { ip, gateway };
    this.host.setIpConfig(iface, config);
    return [];
  }

  private requireInterface(name: string | undefined, command: string): void {
    if (name === undefined) {
      return;
    }
    const found = this.host.interfaces.some((iface) => iface.name === name);
    if (!found) {
      throw new ShellCommandError(
        shellError(
          "invalid_argument",
          command,
          `no interface named ${JSON.stringify(name)}`,
        ),
      );
    }
  }

  private ping(command: PingCommand): Array<string> {
    const identifier = this.nextIdentifier();
    const lines = [
      `PING ${command.dst} (${command.dst}): ${command.size} data bytes`,
    ];
    const rtts: Array<number> = [];
    for (let sequence = 1; sequence <= command.count; sequence++) {
      const start = this.sim.now;
      const outcome = this.runProbe({
        dst: command.dst,
        identifier,
        sequence,
        ttl: command.ttl,
        size: command.size,
        timeoutUs: this.pingTimeoutUs,
      });
      if (outcome.reply !== undefined) {
        const reply = outcome.reply;
        const rtt = reply.rttUs ?? (outcome.replyAt ?? this.sim.now) - start;
        rtts.push(rtt);
        lines.push(
          `${reply.data.length + 8} bytes from ${reply.srcIp}: ` +
            `icmp_seq=${sequence} ttl=${reply.ttl} time=${rtt} us`,
        );
      } else if (outcome.error !== undefined) {
        lines.push(
          `From ${outcome.error.from} icmp_seq=${sequence} ` +
            describeIcmpError(outcome.error),
        );
      }
      const nextAt = start + this.pingIntervalUs;
      if (nextAt > this.sim.now) {
        this.sim.runUntil(nextAt);
      }
    }

    const received = rtts.length;
    const lost = command.count - received;
    lines.push(`--- ${command.dst} ping statistics ---`);
    lines.push(
      `${command.count} packets transmitted, ${received} received, ` +
        `${((lost / command.count) * 100).toFixed(1)}% packet loss`,
    );
    if (rtts.length > 0) {
      const min = Math.min(...rtts);
      const max = Math.max(...rtts);
      const avg = Math.round(
        rtts.reduce((total, value) => total + value, 0) / rtts.length,
      );
      lines.push(`rtt min/avg/max = ${min}/${avg}/${max} us`);
    }
    return lines;
  }

  private traceroute(command: TracerouteCommand): Array<string> {
    const identifier = this.nextIdentifier();
    const lines = [
      `traceroute to ${command.dst} (${command.dst}), ` +
        `${this.tracerouteMaxHops} hops max`,
    ];
    for (let ttl = 1; ttl <= this.tracerouteMaxHops; ttl++) {
      const start = this.sim.now;
      const outcome = this.runProbe({
        dst: command.dst,
        identifier,
        sequence: ttl,
        ttl,
        size: TRACEROUTE_SIZE,
        timeoutUs: this.tracerouteTimeoutUs,
      });
      const prefix = ttl.toString();
      if (outcome.reply !== undefined) {
        const rtt =
          outcome.reply.rttUs ?? (outcome.replyAt ?? this.sim.now) - start;
        lines.push(`${prefix}  ${outcome.reply.srcIp}  ${rtt} us`);
        break;
      }
      if (outcome.error !== undefined) {
        const at = outcome.errorAt ?? this.sim.now;
        lines.push(`${prefix}  ${outcome.error.from}  ${at - start} us`);
        if (outcome.error.type === ICMP_TYPE_DEST_UNREACHABLE) {
          lines.push(`  ${describeIcmpError(outcome.error)}`);
          break;
        }
        continue;
      }
      lines.push(`${prefix}  *`);
    }
    return lines;
  }

  /**
   * Resolve one A record with the shared {@link DnsResolver} for `server`.
   * The resolver is kept per server so its TTL cache survives the command,
   * exactly like a host stub resolver.
   */
  private dig(command: DigCommand): Array<string> {
    const server = command.server ?? this.defaultDnsServer();
    const resolution = this.resolverFor(server).resolve(command.name);
    return formatDigLines({
      name: resolution.name,
      server,
      port: this.dnsPort,
      status: resolution.status,
      address: resolution.address,
      rcode: resolution.rcode,
      ttlSeconds: resolution.ttlSeconds,
      fromCache: resolution.fromCache,
      attempts: resolution.attempts,
      timeoutUs: this.digTimeoutUs,
      retries: this.digRetries,
    });
  }

  /**
   * Run DORA on one interface and report the lease.
   *
   * The virtual clock advances event by event (never on wall-clock time)
   * until the client is bound, failed, or the retry budget is exhausted: a
   * single `runUntil()` would pin the clock to the whole budget even when
   * the Ack arrives immediately.
   */
  private dhclient(command: DhclientCommand): Array<string> {
    const iface = this.dhcpInterface(command.iface);
    const client = new DhcpClient({
      host: this.host,
      sim: this.sim,
      iface,
      timeoutUs: this.dhcpTimeoutUs,
      retries: this.dhcpRetries,
    });
    const deadline = this.sim.now + this.dhcpTimeoutUs * (this.dhcpRetries + 1);
    let state = client.state;
    let lease = client.lease;
    let attempts = client.stats.discovers;
    try {
      client.start();
      while (
        client.state !== "bound" &&
        client.state !== "failed" &&
        this.sim.now <= deadline
      ) {
        if (!this.sim.step() || this.sim.now > deadline) {
          break;
        }
      }
      state = client.state;
      lease = client.lease;
      attempts = client.stats.discovers;
    } finally {
      client.close();
    }
    return formatDhclientLines({ iface, state, lease, attempts });
  }

  /**
   * Send one UDP datagram from an ephemeral socket and collect the replies
   * that arrive before the virtual timeout, mirroring {@link runProbe}.
   */
  private ncUdp(command: NcUdpCommand): Array<string> {
    const deadline = this.sim.now + this.ncTimeoutUs;
    const replies: Array<{
      srcIp: string;
      srcPort: number;
      payload: Uint8Array;
    }> = [];
    const srcPort = this.nextUdpPort();
    const socket = this.host.bindUdp(srcPort, (datagram) => {
      if (this.sim.now > deadline) {
        return;
      }
      replies.push({
        srcIp: datagram.srcIp,
        srcPort: datagram.srcPort,
        payload: datagram.payload,
      });
    });
    try {
      this.host.sendUdp(
        command.host,
        command.port,
        hexToBytes(command.payload),
        { srcPort },
      );
      this.sim.runUntil(deadline);
    } finally {
      socket.close();
    }
    return formatNcUdpLines({
      host: command.host,
      port: command.port,
      payload: command.payload,
      replies: replies.map((reply) => ({
        srcIp: reply.srcIp,
        srcPort: reply.srcPort,
        payload: bytesToHex(reply.payload),
      })),
    });
  }

  /**
   * `nc` in TCP mode: connect, send the hex payload once the handshake is
   * complete, collect everything the peer sends until the virtual deadline and
   * report the connection state. Mirrors {@link ncUdp}: the clock is driven by
   * `runUntil()` only, and the socket is closed before returning.
   */
  private ncTcp(command: NcTcpCommand): Array<string> {
    const deadline = this.sim.now + this.ncTimeoutUs;
    const chunks: Array<Uint8Array> = [];
    let connected = false;
    const socket = new TcpSocket({
      host: this.host,
      sim: this.sim,
      onData: (data) => {
        if (this.sim.now <= deadline) {
          chunks.push(data);
        }
      },
      onStateChange: (state) => {
        if (state !== "ESTABLISHED") {
          return;
        }
        connected = true;
        socket.send(hexToBytes(command.payload));
      },
    });
    socket.connect(command.host, command.port);
    this.sim.runUntil(deadline);
    const state = socket.state;
    socket.close();
    return formatNcTcpLines({
      host: command.host,
      port: command.port,
      payload: command.payload,
      received: bytesToHex(concatBytes(chunks)),
      connected,
      state,
    });
  }

  /**
   * `ss`: the host's live TCP sockets with state, endpoints and congestion
   * numbers. Rows come from `host.tcpSockets`, so a listener, every connection
   * it forked and outgoing connections all show up, whichever command — or
   * test — created them.
   */
  private ss(): Array<string> {
    const rows = this.host.tcpSockets.map((socket) => ({
      state: socket.state,
      local: `${socket.localIp ?? "0.0.0.0"}:${socket.localPort ?? 0}`,
      peer:
        socket.remoteIp === undefined || socket.remotePort === undefined
          ? "0.0.0.0:*"
          : `${socket.remoteIp}:${socket.remotePort}`,
      cwnd: Math.round(socket.cwnd),
      ssthresh: Math.round(socket.ssthresh),
    }));
    return formatSsLines(rows);
  }

  /**
   * `send IFACE DSTMAC ETHERTYPE HEX`: transmit a hand-built Ethernet frame
   * (F-101).
   *
   * The frame goes through `Host.sendRaw()`, so no route is consulted and no
   * ARP request is sent: the destination MAC, ethertype and payload are the
   * ones the caller wrote. The payload is padded by the serializer when the
   * frame is shorter than the Ethernet minimum, and the reported size says so.
   * An unknown interface or a down/unattached one is a typed execution error.
   */
  private send(command: SendCommand): Array<string> {
    this.requireInterface(command.iface, "send");
    const iface = this.host.getInterface(command.iface);
    const payload = hexToBytes(command.payload);
    this.host.sendRaw(
      command.iface,
      MacAddress.parse(command.dstMac),
      command.etherType,
      payload,
    );
    return formatSendLines({
      iface: command.iface,
      srcMac: iface.mac.toString(),
      dstMac: command.dstMac,
      etherType: command.etherType,
      payloadBytes: payload.length,
      wireBytes: Math.max(
        ETHERNET_HEADER_LENGTH + payload.length,
        ETHERNET_MIN_FRAME_LENGTH,
      ),
    });
  }

  /**
   * `http-server [PORT]`: install an event-driven HTTP/1.0 server and return.
   *
   * The command does not block the virtual clock: the listener stays in LISTEN
   * with a small accept backlog, and every accepted connection is served from
   * `onAccept` as the simulation runs for whoever is talking to it. A second
   * `http-server` on the same port reports the existing one instead of binding
   * twice.
   */
  private httpServer(command: HttpServerCommand): Array<string> {
    const port = command.port ?? DEFAULT_HTTP_PORT;
    if (this.httpServers.has(port)) {
      return [`http-server: already listening on 0.0.0.0:${port}`];
    }
    const server = new TcpSocket({
      host: this.host,
      sim: this.sim,
      backlog: HTTP_BACKLOG,
      onAccept: (socket) => this.serveHttp(socket),
    });
    server.listen(port);
    this.httpServers.set(port, server);
    return [
      `HTTP/1.0 server listening on 0.0.0.0:${port}`,
      `GET / serves a fixed ${HTTP_PAGE.length}-byte page`,
    ];
  }

  /**
   * Attach the request handler to one accepted connection.
   *
   * `read()` drains anything that arrived with the handshake before `onData`
   * is installed, so those bytes cannot be handled twice. Buffers of
   * connections that died mid-request are dropped here.
   */
  private serveHttp(socket: TcpSocket): void {
    for (const [pending] of this.httpRequests) {
      if (pending.state === "CLOSED") {
        this.httpRequests.delete(pending);
      }
    }
    const early = socket.read();
    socket.onData = (data) => this.handleHttpData(socket, data);
    if (early.length > 0) {
      this.handleHttpData(socket, early);
    }
  }

  /**
   * Accumulate bytes until the request headers are complete, answer once and
   * close. HTTP/1.0 with `Connection: close`: no keep-alive, no pipelining.
   */
  private handleHttpData(socket: TcpSocket, data: Uint8Array): void {
    const buffer = concatBytes([
      this.httpRequests.get(socket) ?? NO_BYTES,
      data,
    ]);
    if (httpHeadEnd(buffer) === -1) {
      this.httpRequests.set(socket, buffer);
      return;
    }
    this.httpRequests.delete(socket);
    const requestLine = asciiFromBytes(buffer).split("\r\n")[0] ?? "";
    socket.send(httpReplyFor(requestLine));
    socket.close();
  }

  /**
   * `curl URL`: one HTTP/1.0 GET over a connected TcpSocket.
   *
   * The request is sent when the handshake completes and the response is
   * collected until the virtual deadline, exactly like `nc`. A refused or
   * silent connection and a malformed response are typed execution errors; a
   * non-200 status is still printed with its body.
   */
  private httpGet(command: HttpGetCommand): Array<string> {
    const deadline = this.sim.now + this.ncTimeoutUs;
    const chunks: Array<Uint8Array> = [];
    let connected = false;
    const request = httpRequestBytes(command);
    const socket = new TcpSocket({
      host: this.host,
      sim: this.sim,
      onData: (data) => {
        if (this.sim.now <= deadline) {
          chunks.push(data);
        }
      },
      onStateChange: (state) => {
        if (state !== "ESTABLISHED") {
          return;
        }
        connected = true;
        socket.send(request);
      },
    });
    socket.connect(command.host, command.port);
    this.sim.runUntil(deadline);
    const state = socket.state;
    socket.close();
    if (!connected) {
      throw new ShellCommandError(
        shellError(
          "execution_failed",
          "curl",
          state === "CLOSED"
            ? `connection refused: ${command.host}:${command.port}`
            : `no answer from ${command.host}:${command.port}`,
        ),
      );
    }
    const response = parseHttpResponse(concatBytes(chunks));
    if (response === undefined) {
      throw new ShellCommandError(
        shellError(
          "execution_failed",
          "curl",
          `malformed HTTP response from ${command.host}:${command.port}`,
        ),
      );
    }
    return formatHttpGetLines(response);
  }

  /**
   * `subnet new [THEME]`: draw one drill, remember it and print it (F-117).
   *
   * The theme, when omitted, comes from the simulation PRNG too, so a replay
   * of the same lab always starts the same drill. The trainer receives
   * `sim.random.next`, never `Math.random`.
   */
  private subnetNew(command: SubnetNewCommand): Array<string> {
    const trainer = this.subnet;
    if (trainer === undefined) {
      throw new ShellCommandError(
        shellError(
          "unsupported",
          "subnet",
          "no subnetting trainer installed: pass `subnet` in ShellOptions",
        ),
      );
    }
    const topic = command.topic ?? this.randomSubnetTopic();
    const drill = trainer(topic, this.sim.random.next.bind(this.sim.random));
    this.pendingSubnet = drill;
    return formatSubnetProblemLines(drill);
  }

  /**
   * `subnet answer VALUE...`: grade the pending drill against its own
   * correction. The drill stays pending, so a wrong answer can be retried
   * without losing the statement.
   */
  private subnetAnswer(command: SubnetAnswerCommand): Array<string> {
    const drill = this.pendingSubnet;
    if (drill === undefined) {
      throw new ShellCommandError(
        shellError(
          "execution_failed",
          "subnet",
          "no pending drill: start one with subnet new",
        ),
      );
    }
    return formatSubnetAnswerLines(drill.check(command.values.join(" ")));
  }

  /** One theme from the simulation PRNG; `subnet new` without an argument. */
  private randomSubnetTopic(): SubnetTopic {
    const index = Math.floor(this.sim.random.next() * SUBNET_TOPICS.length);
    return SUBNET_TOPICS[index] ?? SUBNET_TOPICS[0];
  }

  /** `@server`, then the configured resolver, then the gateway on port 53. */
  private defaultDnsServer(): string {
    if (this.dnsServer !== undefined) {
      return this.dnsServer;
    }
    for (const iface of this.host.interfaces) {
      const config = this.host.getIpConfig(iface.name);
      if (config?.gateway !== undefined) {
        return config.gateway.toString();
      }
    }
    throw new ShellCommandError(
      shellError(
        "invalid_argument",
        "dig",
        "dig needs a DNS server: use dig @SERVER, set the dnsServer " +
          "option or configure a gateway",
      ),
    );
  }

  private resolverFor(server: string): DnsResolver {
    const existing = this.resolvers.get(server);
    if (existing !== undefined) {
      return existing;
    }
    const resolver = new DnsResolver({
      host: this.host,
      sim: this.sim,
      serverIp: server,
      port: this.dnsPort,
      timeoutUs: this.digTimeoutUs,
      retries: this.digRetries,
      srcPort: this.nextUdpPort(),
    });
    this.resolvers.set(server, resolver);
    return resolver;
  }

  /**
   * Explicit interface, else the first one without an address (the case
   * `dhclient` exists for), else the first interface at all.
   */
  private dhcpInterface(name: string | undefined): string {
    if (name !== undefined) {
      this.requireInterface(name, "dhclient");
      return name;
    }
    const unconfigured = this.host.interfaces.find(
      (iface) => this.host.getIpConfig(iface.name) === undefined,
    );
    const chosen = unconfigured ?? this.host.interfaces[0];
    if (chosen === undefined) {
      throw new ShellCommandError(
        shellError(
          "invalid_argument",
          "dhclient",
          "dhclient needs at least one interface",
        ),
      );
    }
    return chosen.name;
  }

  /** Deterministic source port for the shell's own UDP sockets. */
  private nextUdpPort(): number {
    this.udpPortSeed =
      this.udpPortSeed >= 0xffff ? UDP_PORT_START : this.udpPortSeed + 1;
    return this.udpPortSeed;
  }

  /**
   * Send one Echo Request and advance the virtual clock to its deadline.
   * Replies/errors are matched by ICMP identifier+sequence, so unrelated
   * traffic and late answers cannot be attributed to this probe.
   */
  private runProbe(input: ProbeInput): ProbeOutcome {
    const start = this.sim.now;
    const deadline = start + input.timeoutUs;
    const outcome: ProbeOutcome = {
      reply: undefined,
      replyAt: undefined,
      error: undefined,
      errorAt: undefined,
      deadline,
    };
    const handle = this.host.sendPing(input.dst, {
      identifier: input.identifier,
      sequence: input.sequence,
      size: input.size,
      ttl: input.ttl,
    });
    this.rememberPeer(handle.iface, input.dst);
    const probe: ActiveProbe = {
      key: `${input.identifier}:${input.sequence}`,
      dst: input.dst,
      outcome,
    };
    this.activeProbe = probe;
    try {
      this.sim.runUntil(deadline);
    } finally {
      this.activeProbe = undefined;
    }
    return outcome;
  }

  private captureReply(reply: HostEchoReply): void {
    const probe = this.activeProbe;
    if (probe === undefined) {
      return;
    }
    const at = this.sim.now;
    if (at > probe.outcome.deadline) {
      return;
    }
    if (
      probe.outcome.reply !== undefined ||
      probe.outcome.error !== undefined
    ) {
      return;
    }
    if (`${reply.identifier}:${reply.sequence}` !== probe.key) {
      return;
    }
    probe.outcome.reply = reply;
    probe.outcome.replyAt = at;
  }

  private captureError(error: HostIcmpError): void {
    const probe = this.activeProbe;
    if (probe === undefined) {
      return;
    }
    const at = this.sim.now;
    if (at > probe.outcome.deadline) {
      return;
    }
    if (
      probe.outcome.reply !== undefined ||
      probe.outcome.error !== undefined
    ) {
      return;
    }
    const key = embeddedEchoKey(error.embedded);
    if (key !== undefined) {
      if (key !== probe.key) {
        return;
      }
    } else if (error.originalDst !== probe.dst) {
      return;
    }
    probe.outcome.error = error;
    probe.outcome.errorAt = at;
  }

  private rememberPeer(iface: string, ip: string): void {
    const existing = this.peers.get(iface);
    if (existing === undefined) {
      this.peers.set(iface, new Set([ip]));
      return;
    }
    existing.add(ip);
  }

  /** Addresses the default neighbor provider may ask the Host cache about. */
  private neighborCandidates(): Array<NeighborCandidate> {
    const candidates: Array<NeighborCandidate> = [];
    for (const iface of this.host.interfaces) {
      const config = this.host.getIpConfig(iface.name);
      if (config?.gateway !== undefined) {
        candidates.push({ iface: iface.name, ip: config.gateway.toString() });
      }
      for (const ip of this.peers.get(iface.name) ?? []) {
        candidates.push({ iface: iface.name, ip });
      }
    }
    return candidates;
  }

  private neighborEntries(iface?: string): Array<NeighborEntry> {
    const snapshot = this.neighbors(this.host);
    const filtered =
      iface === undefined
        ? [...snapshot]
        : snapshot.filter((entry) => entry.iface === iface);
    return sortNeighborEntries(this.host, filtered);
  }

  private nextIdentifier(): number {
    this.identifierSeed = (this.identifierSeed % 0xffff) + 1;
    return this.identifierSeed;
  }
}

/** Convenience factory mirroring the constructor option object. */
export function createShell(options: ShellOptions): Shell {
  return new Shell(options);
}
