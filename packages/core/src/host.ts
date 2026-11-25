/**
 * End host: Ethernet interfaces, an ARP cache with a pending queue
 * (F-12, F-13, F-19, F-20, F-21) and IPv4 delivery (F-30 to F-39).
 *
 * ARP here is deliberately synchronous (decision S13): `sendTo()` consults
 * the cache and either transmits immediately or queues the frame and sends
 * one request; the reply arrives later through the normal event queue.
 * Nothing awaits a promise, so tests advance virtual time with
 * `sim.runAll()` / `runUntil()` only.
 *
 * IPv4 integration is additive. `sendTo()` still takes an explicit L3
 * payload; with a mask configured it resolves the next hop (on-link
 * destination or gateway) before ARP. `sendIpv4()` / `sendPing()` build the
 * datagram themselves and route by configured interface. Inbound datagrams
 * are reassembled when fragmented (S3), and ICMP Echo Requests to a local
 * address are answered automatically; replies and errors surface through
 * `onEchoReply` / `onIcmpError` for the shell. The original `onPayload` hook
 * still receives every accepted non-ARP payload, IPv4 included.
 *
 * UDP sockets (F-51/52) are a thin port layer on top of IPv4: `bindUdp()`
 * registers a listener per port (`onUdp` is the fallback for sockets bound
 * without one), `sendUdp()` builds the datagram and follows the normal route
 * and ARP path, and a datagram for an unbound port is answered with ICMP
 * Destination Unreachable / Port Unreachable. Ephemeral source ports come
 * from `sim.random`, never `Math.random()`.
 *
 * Cache discipline: every ARP packet refreshes `senderIp -> senderMac`, which
 * covers gratuitous announcements and lets a request resolve a pending entry
 * for the sender. A pending entry owns one retry timer: retries + 1 requests,
 * then the queued frames are dropped as `host unreachable`.
 */

import { Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  type ArpPacket,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_CODE_FRAG_NEEDED,
  ICMP_CODE_PORT_UNREACHABLE,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  type IcmpMessage,
  IPV4_PROTOCOL_ICMP,
  IPV4_PROTOCOL_UDP,
  IPV4_VERSION,
  type Ipv4Packet,
  parseArp,
  parseEthernet,
  parseIcmp,
  parseIpv4,
  parseUdp,
  serializeArp,
  serializeEthernet,
  serializeIcmp,
  serializeIpv4,
  serializeUdp,
  shouldAccept,
} from "@netlab/protocols";
import {
  Device,
  type InterfaceOptions,
  type NetworkInterface,
} from "./devices";
import {
  isFragmented,
  Reassembler,
  type ReassemblyOptions,
} from "./reassembly";
import {
  DEFAULT_IPV4_TTL,
  prefixToMask,
  resolveOptionalPrefix,
  sameSubnet,
  splitIpv4Prefix,
} from "./route";
import type { Simulation, TimerHandle } from "./sim";
import type { TraceBus } from "./trace";

/** How long a resolved entry stays reachable. Default 300 s. */
const DEFAULT_ARP_TTL_US = 300_000_000;
/** Delay before retransmitting an unanswered request. Default 1 s. */
const DEFAULT_ARP_TIMEOUT_US = 1_000_000;
/** Retransmissions after the first request. Default 2 (three requests). */
const DEFAULT_ARP_RETRIES = 2;
/** Frames held per unresolved address. Default 32. */
const DEFAULT_ARP_QUEUE_LIMIT = 32;

/** RFC 826: the target hardware address of a request is all zeros. */
const UNSPECIFIED_MAC = MacAddress.parse("00:00:00:00:00:00");

/** Called for accepted non-ARP payloads. */
export type HostPayloadHandler = (
  iface: NetworkInterface,
  etherType: number,
  payload: Uint8Array,
) => void;

/** Narrowed ICMP variants used by the receive path. */
type IcmpEcho = Extract<IcmpMessage, { kind: "echo" }>;
type IcmpError = Extract<IcmpMessage, { kind: "error" }>;

/** Per-interface configuration for `Host.addInterface()`. */
export interface HostInterfaceOptions extends InterfaceOptions {
  /** IPv4 identity used as the ARP sender address; `ip/prefix` accepted. */
  ip?: string;
  /** Dotted subnet mask (`255.255.255.0`), alternative to prefixLength. */
  mask?: string;
  /** Subnet prefix length (0..32), alternative to mask. */
  prefixLength?: number;
  /** Default next hop for destinations outside the local subnet. */
  gateway?: string;
}

/** Mutable IPv4 configuration accepted by `Host.setIpConfig()`. */
export interface HostIpConfigInput {
  ip: string;
  /** Omitted means "keep the current prefix". */
  mask?: string;
  /** Omitted means "keep the current prefix". */
  prefixLength?: number;
  /** `null` clears the gateway; omitted keeps it. */
  gateway?: string | null;
}

/** Snapshot of one interface's IPv4 configuration. */
export interface HostIpConfig {
  iface: string;
  ip: Ipv4Address;
  prefixLength: number | undefined;
  mask: Ipv4Address | undefined;
  gateway: Ipv4Address | undefined;
}

/** Options for `Host.sendIpv4()`. */
export interface HostIpv4SendOptions {
  /** IPv4 TTL; default 64, minimum 1. */
  ttl?: number;
  /** Set DF on the generated datagram. Default false. */
  dontFragment?: boolean;
  /** IP identification; default a per-host counter. */
  identification?: number;
  /** Egress interface; default the configured route/gateway. */
  iface?: string;
}

/** Options for `Host.sendPing()`. */
export interface HostPingOptions extends HostIpv4SendOptions {
  identifier?: number;
  sequence?: number;
  /** ICMP echo data length; default 56. Ignored when `data` is set. */
  size?: number;
  /** Explicit echo data (overrides `size`). */
  data?: Uint8Array;
}

/** A UDP datagram delivered to a listener, as reported by `bindUdp`/`onUdp`. */
export interface HostUdpDatagram {
  iface: string;
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  /** Datagram payload (a copy: mutating it cannot corrupt the frame). */
  payload: Uint8Array;
}

/** Listener for one bound UDP port (or the `onUdp` fallback). */
export type HostUdpHandler = (datagram: HostUdpDatagram) => void;

/** A bound UDP port. */
export interface HostUdpSocket {
  readonly port: number;
  /** Stop delivering datagrams to this socket. Idempotent. */
  close(): void;
}

/** Options for `Host.sendUdp()`. */
export interface HostUdpSendOptions {
  /** Source port; default an ephemeral port from the dynamic range. */
  srcPort?: number;
  /** Egress interface; default the configured route/gateway. */
  iface?: string;
}

/** Result of queueing one UDP datagram. */
export interface HostUdpSendHandle {
  iface: string;
  srcPort: number;
}

/** Result of queueing one Echo Request. */
export interface HostPingHandle {
  iface: string;
  destIp: string;
  identifier: number;
  sequence: number;
  /** Echo data bytes carried by the request. */
  size: number;
  ttl: number;
  dontFragment: boolean;
  /** Virtual time the request was handed to IPv4. */
  sentAt: number;
}

/** Delivered Echo Reply, as reported by `Host.onEchoReply`. */
export interface HostEchoReply {
  iface: string;
  srcIp: string;
  dstIp: string;
  identifier: number;
  sequence: number;
  data: Uint8Array;
  ttl: number;
  /** Round-trip time for a request this host sent, else undefined. */
  rttUs: number | undefined;
}

/** Delivered ICMP error, as reported by `Host.onIcmpError`. */
export interface HostIcmpError {
  iface: string;
  /** Source of the ICMP error (usually the router that failed us). */
  from: string;
  type: number;
  code: number;
  /** Next-hop MTU for type 3 code 4; undefined otherwise. */
  mtu: number | undefined;
  /** Start of the offending datagram (header + 8 payload bytes). */
  embedded: Uint8Array;
  /** Destination of the offending datagram, when its header parses. */
  originalDst: string | undefined;
  ttl: number;
}

/** Host tunables, all overridable per instance. */
export interface HostOptions {
  /** Lifetime of a resolved ARP entry in microseconds. */
  arpTtlUs?: number;
  /** Wait before retransmitting an unanswered request. */
  arpTimeoutUs?: number;
  /** Retransmissions after the first request (total = retries + 1). */
  arpRetries?: number;
  /** Frames buffered per unresolved address. */
  arpQueueLimit?: number;
  /** Initial payload hook. */
  onPayload?: HostPayloadHandler;
  /** Initial Echo Reply hook (ping). */
  onEchoReply?: (reply: HostEchoReply) => void;
  /** Initial ICMP error hook (traceroute, PMTU discovery). */
  onIcmpError?: (error: HostIcmpError) => void;
  /** Initial fallback listener for UDP sockets bound without a handler. */
  onUdp?: HostUdpHandler;
  /** How long partial inbound datagrams stay buffered. */
  reassemblyTimeoutUs?: number;
  /** Fragment-payload memory budget for inbound reassembly. */
  reassemblyMaxBytes?: number;
}

/** A frame waiting for the address resolution of its next hop. */
interface PendingFrame {
  etherType: number;
  payload: Uint8Array;
}

/** One address in the cache: incomplete while `mac` is undefined. */
interface ArpEntry {
  ip: Ipv4Address;
  mac: MacAddress | undefined;
  expiresAt: number;
  /** Requests already transmitted for this resolution. */
  attempts: number;
  /** Retry timer while a resolution is in flight. */
  timer: TimerHandle | undefined;
  pending: Array<PendingFrame>;
}

/** A bound UDP port and its optional per-port listener. */
interface UdpSocketEntry {
  handler: HostUdpHandler | undefined;
}

/** Interface plus its addressing state. */
interface HostPort {
  iface: NetworkInterface;
  ip: Ipv4Address | undefined;
  prefixLength: number | undefined;
  gateway: Ipv4Address | undefined;
  arp: Map<string, ArpEntry>;
}

/** Default Echo Request payload: 56 data bytes (64-byte ICMP message). */
const DEFAULT_PING_SIZE = 56;

/** Identifier every `sendPing()` request uses unless overridden. */
const PING_IDENTIFIER = 0x4e4c;

/** Unanswered requests remembered for RTT calculation (oldest evicted). */
const MAX_PENDING_PINGS = 1024;

/** RFC 6335 dynamic port range used for ephemeral UDP source ports. */
const UDP_EPHEMERAL_MIN = 49152;
const UDP_EPHEMERAL_MAX = 65535;
const UDP_EPHEMERAL_PORTS = UDP_EPHEMERAL_MAX - UDP_EPHEMERAL_MIN + 1;

/** Bytes of the offending datagram quoted in an ICMP error (RFC 792). */
const ICMP_QUOTED_BYTES = 8;

function checkByteField(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be a byte 0..255: ${value}`);
  }
}

function checkU16Field(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be 0..65535: ${value}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite value >= 0: ${value}`);
  }
  return value;
}

function checkCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer: ${value}`);
  }
  return value;
}

function checkLimit(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer: ${value}`);
  }
  return value;
}

export class Host extends Device {
  /** Called for every accepted non-ARP payload. */
  onPayload: HostPayloadHandler | undefined = undefined;
  /** Called for every ICMP Echo Reply addressed to this host. */
  onEchoReply: ((reply: HostEchoReply) => void) | undefined = undefined;
  /** Called for every ICMP error addressed to this host. */
  onIcmpError: ((error: HostIcmpError) => void) | undefined = undefined;
  /** Fallback listener for UDP sockets bound without their own handler. */
  onUdp: HostUdpHandler | undefined = undefined;

  private readonly arpTtlUs: number;
  private readonly arpTimeoutUs: number;
  private readonly arpRetries: number;
  private readonly arpQueueLimit: number;
  private readonly ports = new Map<string, HostPort>();
  private readonly reassembler: Reassembler;
  private readonly pendingPings = new Map<string, number>();
  private readonly udpSockets = new Map<number, UdpSocketEntry>();
  private ipId = 1;
  private pingSequence = 0;
  private udpEphemeralNext: number | undefined = undefined;

  constructor(
    sim: Simulation,
    id: string,
    bus: TraceBus,
    opts: HostOptions = {},
  ) {
    super(sim, id, bus);
    this.arpTtlUs = checkDuration(
      "arpTtlUs",
      opts.arpTtlUs ?? DEFAULT_ARP_TTL_US,
    );
    this.arpTimeoutUs = checkDuration(
      "arpTimeoutUs",
      opts.arpTimeoutUs ?? DEFAULT_ARP_TIMEOUT_US,
    );
    this.arpRetries = checkCount(
      "arpRetries",
      opts.arpRetries ?? DEFAULT_ARP_RETRIES,
    );
    this.arpQueueLimit = checkLimit(
      "arpQueueLimit",
      opts.arpQueueLimit ?? DEFAULT_ARP_QUEUE_LIMIT,
    );
    this.onPayload = opts.onPayload;
    this.onEchoReply = opts.onEchoReply;
    this.onIcmpError = opts.onIcmpError;
    this.onUdp = opts.onUdp;
    const reassembly: ReassemblyOptions = {
      onExpire: (expiry) =>
        this.log(
          this.id,
          "warn",
          `reassembly timeout for ${expiry.key.src} -> ${expiry.key.dst} ` +
            `id=${expiry.key.identification} (${expiry.bytes} bytes dropped)`,
        ),
    };
    if (opts.reassemblyTimeoutUs !== undefined) {
      reassembly.timeoutUs = opts.reassemblyTimeoutUs;
    }
    if (opts.reassemblyMaxBytes !== undefined) {
      reassembly.maxBytes = opts.reassemblyMaxBytes;
    }
    this.reassembler = new Reassembler(sim, reassembly);
  }

  /** Create an interface, optionally with a MAC and an IPv4 configuration. */
  override addInterface(
    name: string,
    opts: HostInterfaceOptions = {},
  ): NetworkInterface {
    const iface = super.addInterface(
      name,
      opts.mac === undefined ? {} : { mac: opts.mac },
    );
    const addressing = this.parseInterfaceAddress(opts);
    this.ports.set(name, {
      iface,
      ip: addressing.ip,
      prefixLength: addressing.prefixLength,
      gateway: addressing.gateway,
      arp: new Map(),
    });
    return iface;
  }

  /** Assign (or replace) the IPv4 identity of an existing interface. */
  setAddress(ifaceName: string, ip: string): void {
    this.portOf(ifaceName).ip = Ipv4Address.parse(ip);
  }

  /**
   * Set the full IPv4 configuration of an interface. Omitted `mask` /
   * `prefixLength` keep the current prefix, omitted `gateway` keeps the
   * current gateway and `gateway: null` removes it.
   */
  setIpConfig(ifaceName: string, config: HostIpConfigInput): void {
    const cfg = this.portOf(ifaceName);
    const split = splitIpv4Prefix(config.ip);
    let prefixLength = cfg.prefixLength;
    let ip: Ipv4Address;
    if (split !== undefined) {
      if (config.mask !== undefined || config.prefixLength !== undefined) {
        throw new Error(
          `ip ${JSON.stringify(config.ip)} already carries a prefix; ` +
            `remove mask/prefixLength`,
        );
      }
      ip = split.ip;
      prefixLength = split.prefixLength;
    } else {
      ip = Ipv4Address.parse(config.ip);
      const resolved = resolveOptionalPrefix(config.mask, config.prefixLength);
      if (resolved !== undefined) {
        prefixLength = resolved;
      }
    }
    cfg.ip = ip;
    cfg.prefixLength = prefixLength;
    if (config.gateway !== undefined) {
      cfg.gateway =
        config.gateway === null ? undefined : Ipv4Address.parse(config.gateway);
    }
  }

  /** Snapshot of an interface's IPv4 configuration; undefined without IP. */
  getIpConfig(ifaceName: string): HostIpConfig | undefined {
    const cfg = this.portOf(ifaceName);
    const ip = cfg.ip;
    if (ip === undefined) {
      return undefined;
    }
    return {
      iface: cfg.iface.name,
      ip,
      prefixLength: cfg.prefixLength,
      mask:
        cfg.prefixLength === undefined
          ? undefined
          : prefixToMask(cfg.prefixLength),
      gateway: cfg.gateway,
    };
  }

  /**
   * Send an L3 payload to `destIp` through `ifaceName`.
   *
   * Resolves the next hop from the interface mask/gateway (destination on
   * link, gateway otherwise), then from the ARP cache, or queues the frame
   * and starts a resolution. Throws when the interface has no source
   * address, or when the destination is off-subnet and no gateway is set.
   */
  sendTo(
    ifaceName: string,
    destIp: string,
    etherType: number,
    payload: Uint8Array,
  ): void {
    const cfg = this.portOf(ifaceName);
    if (cfg.ip === undefined) {
      throw new Error(
        `${this.id}:${ifaceName}: sendTo needs a source IPv4 address ` +
          `(call setAddress() first)`,
      );
    }
    if (!cfg.iface.up) {
      throw new Error(`${this.id}:${ifaceName}: interface is down`);
    }
    if (!cfg.iface.attached) {
      throw new Error(
        `${this.id}:${ifaceName}: interface is not attached to a link`,
      );
    }
    const nextHop = this.nextHopFor(cfg, Ipv4Address.parse(destIp));
    this.transmit(cfg, nextHop, etherType, payload);
  }

  /**
   * Send one IPv4 datagram of arbitrary protocol through the configured
   * route (or `opts.iface`). Throws synchronously on routing/ARP setup
   * errors, exactly like `sendTo()`.
   */
  sendIpv4(
    destIp: string,
    protocol: number,
    payload: Uint8Array,
    opts: HostIpv4SendOptions = {},
  ): void {
    const destination = Ipv4Address.parse(destIp);
    const path = this.interfaceFor(destination, opts.iface);
    this.emitIpv4(path.cfg, destination, protocol, payload, path.nextHop, opts);
  }

  /**
   * Build and send one ICMP Echo Request. The reply is delivered through
   * `onEchoReply` (with `rttUs` when this host sent the request).
   */
  sendPing(destIp: string, opts: HostPingOptions = {}): HostPingHandle {
    const destination = Ipv4Address.parse(destIp);
    const identifier = opts.identifier ?? PING_IDENTIFIER;
    checkU16Field("identifier", identifier);
    const sequence = opts.sequence ?? this.nextPingSequence();
    checkU16Field("sequence", sequence);
    const size =
      opts.data === undefined
        ? (opts.size ?? DEFAULT_PING_SIZE)
        : opts.data.length;
    if (!Number.isInteger(size) || size < 0 || size > 65507) {
      throw new RangeError(
        `ping payload size must be an integer 0..65507: ${size}`,
      );
    }
    if (opts.size !== undefined && opts.size !== size) {
      throw new RangeError(
        `ping size ${opts.size} disagrees with data length ${size}`,
      );
    }
    const data =
      opts.data === undefined ? new Uint8Array(size) : opts.data.slice();
    const message = serializeIcmp({
      kind: "echo",
      type: ICMP_TYPE_ECHO_REQUEST,
      code: 0,
      identifier,
      sequence,
      data,
    });

    // Select the path before touching any state so a routing error is a
    // plain synchronous throw with nothing queued (same contract as sendTo).
    const path = this.interfaceFor(destination, opts.iface);
    this.emitIpv4(
      path.cfg,
      destination,
      IPV4_PROTOCOL_ICMP,
      message,
      path.nextHop,
      opts,
    );

    const sentAt = this.sim.now;
    this.pendingPings.set(`${identifier}:${sequence}`, sentAt);
    if (this.pendingPings.size > MAX_PENDING_PINGS) {
      const oldest = this.pendingPings.keys().next();
      if (oldest.done !== true) {
        this.pendingPings.delete(oldest.value);
      }
    }
    return {
      iface: path.cfg.iface.name,
      destIp: destIp,
      identifier,
      sequence,
      size,
      ttl: opts.ttl ?? DEFAULT_IPV4_TTL,
      dontFragment: opts.dontFragment ?? false,
      sentAt,
    };
  }

  /**
   * Listen for UDP datagrams addressed to `port`.
   *
   * Datagrams go to `handler`; a socket bound without one falls back to
   * `onUdp`. A second bind of the same port throws, and `close()` stops
   * delivery (idempotent).
   */
  bindUdp(port: number, handler?: HostUdpHandler): HostUdpSocket {
    checkU16Field("port", port);
    if (this.udpSockets.has(port)) {
      throw new Error(`${this.id}: UDP port ${port} is already bound`);
    }
    const entry: UdpSocketEntry = { handler };
    this.udpSockets.set(port, entry);
    return {
      port,
      close: (): void => {
        if (this.udpSockets.get(port) === entry) {
          this.udpSockets.delete(port);
        }
      },
    };
  }

  /**
   * Send one UDP datagram through the configured route (or `opts.iface`).
   *
   * The source port defaults to an ephemeral port in 49152..65535. Throws
   * synchronously on routing/ARP setup errors, exactly like `sendTo()`.
   */
  sendUdp(
    destIp: string,
    destPort: number,
    payload: Uint8Array,
    opts: HostUdpSendOptions = {},
  ): HostUdpSendHandle {
    checkU16Field("destPort", destPort);
    const destination = Ipv4Address.parse(destIp);
    // Select the path before touching any state so a routing error is a
    // plain synchronous throw with nothing queued (same contract as sendTo).
    const path = this.interfaceFor(destination, opts.iface);
    const ip = path.cfg.ip;
    if (ip === undefined) {
      throw new Error(
        `${this.id}:${path.cfg.iface.name}: no IPv4 address configured`,
      );
    }
    const srcPort = opts.srcPort ?? this.allocateUdpPort();
    checkU16Field("srcPort", srcPort);
    const datagram = serializeUdp(
      { srcPort, dstPort: destPort, payload },
      ip,
      destination,
    );
    this.emitIpv4(
      path.cfg,
      destination,
      IPV4_PROTOCOL_UDP,
      datagram,
      path.nextHop,
      {},
    );
    return { iface: path.cfg.iface.name, srcPort };
  }

  /** Transmit a frame with an explicit destination MAC, bypassing ARP. */
  sendRaw(
    ifaceName: string,
    dstMac: MacAddress,
    etherType: number,
    payload: Uint8Array,
  ): void {
    const iface = this.getInterface(ifaceName);
    iface.send(
      serializeEthernet({ dst: dstMac, src: iface.mac, etherType }, payload),
    );
  }

  /** Resolved MAC for `ip`, or undefined when unknown or past its TTL. */
  arpLookup(ifaceName: string, ip: string): MacAddress | undefined {
    return this.macFor(this.portOf(ifaceName), Ipv4Address.parse(ip));
  }

  onFrame(iface: NetworkInterface, frame: Uint8Array): void {
    const parsed = parseEthernet(frame);
    if (!parsed.ok) {
      iface.counters.rxErrors += 1;
      return;
    }
    const eth = parsed.value;
    if (!shouldAccept(iface.mac, eth, iface)) {
      iface.counters.rxDropped += 1;
      return;
    }
    if (eth.etherType === ETHERTYPE_ARP) {
      this.receiveArp(iface, eth.payload);
      return;
    }
    if (eth.etherType === ETHERTYPE_IPV4) {
      this.receiveIpv4(iface, eth.payload);
    }
    // Legacy hook: every accepted non-ARP payload still reaches it, even
    // when IPv4 above already handled the datagram.
    this.onPayload?.(iface, eth.etherType, eth.payload);
  }

  /** Configured IPv4 path: explicit iface, direct subnet, then gateway. */
  private interfaceFor(
    destination: Ipv4Address,
    ifaceName?: string,
  ): { cfg: HostPort; nextHop: Ipv4Address } {
    if (ifaceName !== undefined) {
      const cfg = this.portOf(ifaceName);
      return { cfg, nextHop: this.nextHopFor(cfg, destination) };
    }
    const ports = [...this.ports.values()];
    for (const cfg of ports) {
      if (
        cfg.ip !== undefined &&
        cfg.prefixLength !== undefined &&
        sameSubnet(cfg.ip, destination, cfg.prefixLength)
      ) {
        return { cfg, nextHop: destination };
      }
    }
    for (const cfg of ports) {
      if (cfg.ip !== undefined && cfg.gateway !== undefined) {
        return { cfg, nextHop: cfg.gateway };
      }
    }
    const addressed = ports.filter((cfg) => cfg.ip !== undefined);
    const only = addressed[0];
    if (addressed.length === 0) {
      throw new Error(`${this.id}: no IPv4 address configured`);
    }
    if (
      only !== undefined &&
      addressed.length === 1 &&
      only.prefixLength === undefined
    ) {
      // Legacy single-interface hosts without a mask keep ARPing the
      // destination directly, exactly as `sendTo()` always did.
      return { cfg: only, nextHop: destination };
    }
    throw new Error(
      `${this.id}: no route to ${destination}: no interface in its subnet ` +
        `and no gateway configured`,
    );
  }

  /** Next hop for one interface: on-link destination or configured gateway. */
  private nextHopFor(cfg: HostPort, destination: Ipv4Address): Ipv4Address {
    const ip = cfg.ip;
    if (ip === undefined) {
      throw new Error(
        `${this.id}:${cfg.iface.name}: no IPv4 address configured`,
      );
    }
    if (cfg.prefixLength !== undefined) {
      if (sameSubnet(ip, destination, cfg.prefixLength)) {
        return destination;
      }
      if (cfg.gateway !== undefined) {
        return cfg.gateway;
      }
      throw new Error(
        `${this.id}:${cfg.iface.name}: no route to ${destination}: ` +
          `outside ${ip.toString()}/${cfg.prefixLength} and no gateway`,
      );
    }
    if (cfg.gateway !== undefined) {
      return cfg.gateway;
    }
    return destination;
  }

  private macFor(cfg: HostPort, ip: Ipv4Address): MacAddress | undefined {
    const entry = cfg.arp.get(ip.toString());
    if (entry === undefined || entry.mac === undefined) {
      return undefined;
    }
    return entry.expiresAt > this.sim.now ? entry.mac : undefined;
  }

  /** Resolve `nextHop` through ARP and put the frame on the wire. */
  private transmit(
    cfg: HostPort,
    nextHop: Ipv4Address,
    etherType: number,
    payload: Uint8Array,
  ): void {
    const mac = this.macFor(cfg, nextHop);
    if (mac !== undefined) {
      this.sendRaw(cfg.iface.name, mac, etherType, payload);
      return;
    }
    const entry = this.entryFor(cfg, nextHop);
    if (entry.pending.length >= this.arpQueueLimit) {
      this.log(
        `${this.id}:${cfg.iface.name}`,
        "warn",
        `ARP queue full for ${nextHop}: dropped ${payload.length}-byte frame`,
      );
      return;
    }
    entry.pending.push({ etherType, payload });
    if (entry.timer === undefined) {
      this.startResolution(cfg, entry);
    }
  }

  /** Build and transmit one IPv4 datagram from `cfg` via `nextHop`. */
  private emitIpv4(
    cfg: HostPort,
    destination: Ipv4Address,
    protocol: number,
    payload: Uint8Array,
    nextHop: Ipv4Address,
    opts: HostIpv4SendOptions,
    source: Ipv4Address | undefined = undefined,
  ): void {
    const ip = cfg.ip;
    if (ip === undefined) {
      throw new Error(
        `${this.id}:${cfg.iface.name}: no IPv4 address configured`,
      );
    }
    if (!cfg.iface.up) {
      throw new Error(`${this.id}:${cfg.iface.name}: interface is down`);
    }
    if (!cfg.iface.attached) {
      throw new Error(
        `${this.id}:${cfg.iface.name}: interface is not attached to a link`,
      );
    }
    const ttl = opts.ttl ?? DEFAULT_IPV4_TTL;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 0xff) {
      throw new RangeError(`IPv4 TTL must be an integer 1..255: ${ttl}`);
    }
    checkByteField("protocol", protocol);
    const identification = opts.identification ?? this.nextIpId();
    checkU16Field("identification", identification);
    const datagram = serializeIpv4(
      {
        version: IPV4_VERSION,
        ihl: 5,
        dscp: 0,
        ecn: 0,
        totalLength: 0,
        identification,
        flags: {
          reserved: false,
          dontFragment: opts.dontFragment ?? false,
          moreFragments: false,
        },
        fragmentOffset: 0,
        ttl,
        protocol,
        checksum: 0,
        src: source ?? ip,
        dst: destination,
        options: new Uint8Array(0),
      },
      payload,
    );
    this.transmit(cfg, nextHop, ETHERTYPE_IPV4, datagram);
  }

  private nextIpId(): number {
    const id = this.ipId;
    this.ipId = (this.ipId + 1) & 0xffff;
    return id;
  }

  private nextPingSequence(): number {
    this.pingSequence = (this.pingSequence % 0xffff) + 1;
    return this.pingSequence;
  }

  private parseInterfaceAddress(opts: HostInterfaceOptions): {
    ip: Ipv4Address | undefined;
    prefixLength: number | undefined;
    gateway: Ipv4Address | undefined;
  } {
    const gateway =
      opts.gateway === undefined ? undefined : Ipv4Address.parse(opts.gateway);
    if (opts.ip === undefined) {
      if (
        gateway !== undefined ||
        opts.mask !== undefined ||
        opts.prefixLength !== undefined
      ) {
        throw new Error(`${this.id}: mask/prefixLength/gateway require an ip`);
      }
      return { ip: undefined, prefixLength: undefined, gateway: undefined };
    }
    const split = splitIpv4Prefix(opts.ip);
    if (split !== undefined) {
      if (opts.mask !== undefined || opts.prefixLength !== undefined) {
        throw new Error(
          `ip ${JSON.stringify(opts.ip)} already carries a prefix; ` +
            `remove mask/prefixLength`,
        );
      }
      return {
        ip: split.ip,
        prefixLength: split.prefixLength,
        gateway,
      };
    }
    return {
      ip: Ipv4Address.parse(opts.ip),
      prefixLength: resolveOptionalPrefix(opts.mask, opts.prefixLength),
      gateway,
    };
  }

  /** IPv4 delivery for this host: reassemble, then dispatch ICMP (S3). */
  private receiveIpv4(iface: NetworkInterface, payload: Uint8Array): void {
    const parsed = parseIpv4(payload);
    if (!parsed.ok) {
      // Not ours to interpret: the legacy `onPayload` hook still sees it.
      return;
    }
    const packet = parsed.value;
    if (!this.ownsAddress(packet.header.dst)) {
      return;
    }
    if (isFragmented(packet)) {
      const result = this.reassembler.add(packet);
      if (result.kind === "complete") {
        this.deliverIpv4(iface, result.packet);
      }
      return;
    }
    this.deliverIpv4(iface, packet);
  }

  private ownsAddress(ip: Ipv4Address): boolean {
    for (const cfg of this.ports.values()) {
      if (cfg.ip?.equals(ip) === true) {
        return true;
      }
    }
    return false;
  }

  private deliverIpv4(iface: NetworkInterface, packet: Ipv4Packet): void {
    if (packet.header.protocol === IPV4_PROTOCOL_UDP) {
      this.receiveUdp(iface, packet);
      return;
    }
    if (packet.header.protocol !== IPV4_PROTOCOL_ICMP) {
      return;
    }
    const parsed = parseIcmp(packet.payload);
    if (!parsed.ok) {
      return;
    }
    const message = parsed.value;
    if (message.kind === "echo") {
      if (message.type === ICMP_TYPE_ECHO_REQUEST) {
        this.replyToEcho(iface, packet.header.src, message);
      } else if (message.type === ICMP_TYPE_ECHO_REPLY) {
        this.notifyEchoReply(iface, packet, message);
      }
      return;
    }
    if (message.kind === "error") {
      this.notifyIcmpError(iface, packet, message);
    }
  }

  /** Answer an Echo Request addressed to this host, on the ingress link. */
  private replyToEcho(
    iface: NetworkInterface,
    source: Ipv4Address,
    request: IcmpEcho,
  ): void {
    const ingress = this.portOf(iface.name);
    if (ingress.ip === undefined) {
      return;
    }
    const reply = serializeIcmp({
      kind: "echo",
      type: ICMP_TYPE_ECHO_REPLY,
      code: 0,
      identifier: request.identifier,
      sequence: request.sequence,
      data: request.data.slice(),
    });
    try {
      // Replies follow the normal route: direct when the sender is on our
      // subnet, through the gateway otherwise.
      const path = this.interfaceFor(source);
      this.emitIpv4(
        path.cfg,
        source,
        IPV4_PROTOCOL_ICMP,
        reply,
        path.nextHop,
        {},
        ingress.ip,
      );
    } catch (err) {
      this.log(
        `${this.id}:${iface.name}`,
        "warn",
        `cannot answer echo from ${source}: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Demultiplex one UDP datagram by destination port (F-51).
   *
   * A bound socket takes the datagram (its own handler, else `onUdp`); a
   * datagram for no bound port is answered with ICMP Port Unreachable
   * (F-52), never delivered to the fallback hook.
   */
  private receiveUdp(iface: NetworkInterface, packet: Ipv4Packet): void {
    const header = packet.header;
    const parsed = parseUdp(packet.payload, {
      src: header.src,
      dst: header.dst,
    });
    if (!parsed.ok) {
      this.log(
        `${this.id}:${iface.name}`,
        "warn",
        `dropped UDP ${header.src} -> ${header.dst}: ${parsed.error.message}`,
      );
      return;
    }
    const datagram = parsed.value;
    const socket = this.udpSockets.get(datagram.dstPort);
    if (socket === undefined) {
      this.sendPortUnreachable(iface, packet, datagram.dstPort);
      return;
    }
    const handler = socket.handler ?? this.onUdp;
    if (handler === undefined) {
      this.log(
        `${this.id}:${iface.name}`,
        "warn",
        `UDP port ${datagram.dstPort} is bound without a handler: dropped ` +
          `${datagram.payload.length} bytes from ${header.src}:${datagram.srcPort}`,
      );
      return;
    }
    handler({
      iface: iface.name,
      srcIp: header.src.toString(),
      dstIp: header.dst.toString(),
      srcPort: datagram.srcPort,
      dstPort: datagram.dstPort,
      payload: datagram.payload,
    });
  }

  /**
   * Answer a datagram for a closed port with ICMP Port Unreachable (F-52).
   *
   * The error quotes the offending header plus 8 payload bytes (RFC 792) and
   * follows the normal route back, sourced from the ingress address; routing
   * failures are logged, never thrown out of the receive path.
   */
  private sendPortUnreachable(
    iface: NetworkInterface,
    offending: Ipv4Packet,
    port: number,
  ): void {
    const ingress = this.portOf(iface.name);
    // RFC 792/1812: never quote a non-initial fragment in an ICMP error.
    if (ingress.ip === undefined || offending.header.fragmentOffset > 0) {
      return;
    }
    const embedded = serializeIpv4(
      offending.header,
      offending.payload.slice(0, ICMP_QUOTED_BYTES),
    );
    const message: IcmpMessage = {
      kind: "error",
      type: ICMP_TYPE_DEST_UNREACHABLE,
      code: ICMP_CODE_PORT_UNREACHABLE,
      unused: 0,
      embedded,
    };
    const source = offending.header.src;
    try {
      const path = this.interfaceFor(source);
      this.emitIpv4(
        path.cfg,
        source,
        IPV4_PROTOCOL_ICMP,
        serializeIcmp(message),
        path.nextHop,
        {},
        ingress.ip,
      );
    } catch (err) {
      this.log(
        `${this.id}:${iface.name}`,
        "warn",
        `cannot answer UDP port ${port} from ${source}: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Next ephemeral UDP source port: a random start in the dynamic range,
   * then sequential, skipping ports bound locally.
   */
  private allocateUdpPort(): number {
    const first = this.udpEphemeralNext;
    const start =
      first ??
      UDP_EPHEMERAL_MIN +
        Math.floor(this.sim.random.next() * UDP_EPHEMERAL_PORTS);
    for (let offset = 0; offset < UDP_EPHEMERAL_PORTS; offset += 1) {
      const port =
        UDP_EPHEMERAL_MIN +
        ((start - UDP_EPHEMERAL_MIN + offset) % UDP_EPHEMERAL_PORTS);
      if (!this.udpSockets.has(port)) {
        this.udpEphemeralNext =
          UDP_EPHEMERAL_MIN +
          ((port - UDP_EPHEMERAL_MIN + 1) % UDP_EPHEMERAL_PORTS);
        return port;
      }
    }
    throw new Error(`${this.id}: no free ephemeral UDP port`);
  }

  private notifyEchoReply(
    iface: NetworkInterface,
    packet: Ipv4Packet,
    message: IcmpEcho,
  ): void {
    const key = `${message.identifier}:${message.sequence}`;
    const sentAt = this.pendingPings.get(key);
    if (sentAt !== undefined) {
      this.pendingPings.delete(key);
    }
    this.onEchoReply?.({
      iface: iface.name,
      srcIp: packet.header.src.toString(),
      dstIp: packet.header.dst.toString(),
      identifier: message.identifier,
      sequence: message.sequence,
      data: message.data.slice(),
      ttl: packet.header.ttl,
      rttUs: sentAt === undefined ? undefined : this.sim.now - sentAt,
    });
  }

  private notifyIcmpError(
    iface: NetworkInterface,
    packet: Ipv4Packet,
    message: IcmpError,
  ): void {
    const embedded = message.embedded.slice();
    const parsed = parseIpv4(embedded);
    const mtu =
      message.type === ICMP_TYPE_DEST_UNREACHABLE &&
      message.code === ICMP_CODE_FRAG_NEEDED
        ? message.unused & 0xffff
        : undefined;
    this.onIcmpError?.({
      iface: iface.name,
      from: packet.header.src.toString(),
      type: message.type,
      code: message.code,
      mtu,
      embedded,
      originalDst: parsed.ok ? parsed.value.header.dst.toString() : undefined,
      ttl: packet.header.ttl,
    });
  }

  private receiveArp(iface: NetworkInterface, payload: Uint8Array): void {
    const parsed = parseArp(payload);
    if (!parsed.ok) {
      iface.counters.rxErrors += 1;
      return;
    }
    this.handleArp(iface, parsed.value);
  }

  private handleArp(iface: NetworkInterface, packet: ArpPacket): void {
    const cfg = this.portOf(iface.name);
    const owner = this.ownerOf(packet.senderIp);
    if (owner !== undefined && !owner.iface.mac.equals(packet.senderMac)) {
      this.log(
        `${this.id}:${iface.name}`,
        "warn",
        `ARP conflict: ${packet.senderIp} announced by ${packet.senderMac} ` +
          `but this host owns it on ${owner.iface.name} ` +
          `(${owner.iface.mac})`,
      );
      return;
    }
    // Every ARP packet teaches us the sender's binding, including
    // gratuitous announcements and the request half of an exchange.
    this.learn(cfg, packet.senderIp, packet.senderMac);
    if (packet.oper !== ARP_OP_REQUEST) {
      return;
    }
    if (cfg.ip?.equals(packet.targetIp)) {
      this.reply(cfg, packet);
    }
  }

  private reply(cfg: HostPort, request: ArpPacket): void {
    const ip = cfg.ip;
    if (ip === undefined) {
      return;
    }
    this.sendRaw(
      cfg.iface.name,
      request.senderMac,
      ETHERTYPE_ARP,
      serializeArp({
        oper: ARP_OP_REPLY,
        senderMac: cfg.iface.mac,
        senderIp: ip,
        targetMac: request.senderMac,
        targetIp: request.senderIp,
      }),
    );
  }

  /** Refresh `ip -> mac` and flush anything queued behind it, in order. */
  private learn(cfg: HostPort, ip: Ipv4Address, mac: MacAddress): void {
    const entry = this.entryFor(cfg, ip);
    const timer = entry.timer;
    entry.timer = undefined;
    timer?.cancel();
    entry.mac = mac;
    entry.attempts = 0;
    entry.expiresAt = this.sim.now + this.arpTtlUs;
    if (entry.pending.length > 0) {
      this.flush(cfg.iface, entry);
    }
  }

  private flush(iface: NetworkInterface, entry: ArpEntry): void {
    const mac = entry.mac;
    if (mac === undefined) {
      return;
    }
    const queued = entry.pending;
    entry.pending = [];
    for (const frame of queued) {
      this.sendRaw(iface.name, mac, frame.etherType, frame.payload);
    }
  }

  private entryFor(cfg: HostPort, ip: Ipv4Address): ArpEntry {
    const key = ip.toString();
    const existing = cfg.arp.get(key);
    if (existing === undefined) {
      const created: ArpEntry = {
        ip,
        mac: undefined,
        expiresAt: 0,
        attempts: 0,
        timer: undefined,
        pending: [],
      };
      cfg.arp.set(key, created);
      return created;
    }
    if (
      existing.timer === undefined &&
      existing.mac !== undefined &&
      existing.expiresAt <= this.sim.now
    ) {
      // Stale entry: reuse the slot for a fresh resolution.
      existing.mac = undefined;
      existing.expiresAt = 0;
      existing.attempts = 0;
    }
    return existing;
  }

  private startResolution(cfg: HostPort, entry: ArpEntry): void {
    if (!cfg.iface.up || !cfg.iface.attached) {
      this.abandon(cfg, entry, `${cfg.iface.name} is not usable for ARP`);
      return;
    }
    entry.attempts += 1;
    this.sendArpRequest(cfg, entry.ip);
    entry.timer = this.sim.schedule(this.arpTimeoutUs, () =>
      this.onTimeout(cfg, entry),
    );
  }

  private onTimeout(cfg: HostPort, entry: ArpEntry): void {
    entry.timer = undefined;
    if (entry.mac !== undefined) {
      return;
    }
    if (entry.attempts <= this.arpRetries) {
      this.startResolution(cfg, entry);
      return;
    }
    this.abandon(
      cfg,
      entry,
      `host unreachable: no ARP reply from ${entry.ip} after ` +
        `${entry.attempts} requests`,
    );
  }

  private abandon(cfg: HostPort, entry: ArpEntry, reason: string): void {
    const timer = entry.timer;
    entry.timer = undefined;
    timer?.cancel();
    cfg.arp.delete(entry.ip.toString());
    const dropped = entry.pending.length;
    entry.pending = [];
    this.log(
      `${this.id}:${cfg.iface.name}`,
      "warn",
      `${reason} (${dropped} frames dropped)`,
    );
  }

  private sendArpRequest(cfg: HostPort, targetIp: Ipv4Address): void {
    const ip = cfg.ip;
    if (ip === undefined) {
      throw new Error(
        `${this.id}:${cfg.iface.name}: cannot send ARP without a source address`,
      );
    }
    this.sendRaw(
      cfg.iface.name,
      MacAddress.BROADCAST,
      ETHERTYPE_ARP,
      serializeArp({
        oper: ARP_OP_REQUEST,
        senderMac: cfg.iface.mac,
        senderIp: ip,
        targetMac: UNSPECIFIED_MAC,
        targetIp,
      }),
    );
  }

  private ownerOf(ip: Ipv4Address): HostPort | undefined {
    for (const cfg of this.ports.values()) {
      if (cfg.ip?.equals(ip)) {
        return cfg;
      }
    }
    return undefined;
  }

  private portOf(ifaceName: string): HostPort {
    const cfg = this.ports.get(ifaceName);
    if (cfg === undefined) {
      throw new Error(
        `${this.id}: no interface named ${JSON.stringify(ifaceName)}`,
      );
    }
    return cfg;
  }

  private log(scope: string, level: string, message: string): void {
    this.bus.emit({ t: this.sim.now, kind: "log", scope, level, message });
  }
}
