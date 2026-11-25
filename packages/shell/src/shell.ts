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
 */

import { Ipv4Address } from "@netlab/bytes";
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
} from "@netlab/core";
import {
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
  formatIpNeighLines,
  formatLinkLines,
  formatNcUdpLines,
  formatRouteLines,
} from "./format";
import {
  hostNeighborEntries,
  type NeighborCandidate,
  type NeighborEntry,
  type NeighborProvider,
  sortNeighborEntries,
} from "./neighbors";
import {
  type DhclientCommand,
  type DigCommand,
  type NcUdpCommand,
  type PingCommand,
  parseCommandLine,
  type ShellCommand,
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
/** Virtual window `nc -u` keeps listening for replies. */
export const DEFAULT_NC_TIMEOUT_US = 1_000_000;

/** First port the shell binds for its own UDP sockets (dynamic range). */
const UDP_PORT_START = 49200;

/** Echo data size used by traceroute probes. */
const TRACEROUTE_SIZE = 32;

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
  "nc -u HOST PORT [HEX] - send a UDP datagram and print replies",
  "help - this list",
];

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
  /** Virtual window `nc -u` keeps collecting replies. */
  ncTimeoutUs?: number;
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
  /** Candidate neighbors learned from successful sends, per interface. */
  private readonly peers = new Map<string, Set<string>>();
  /** One stub resolver per server, so its TTL cache survives the command. */
  private readonly resolvers = new Map<string, DnsResolver>();
  private activeProbe: ActiveProbe | undefined;
  private identifierSeed = 0x4e00;
  private udpPortSeed = UDP_PORT_START - 1;

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
