/**
 * DHCP server and client (F-72/73) on top of the UDP sockets from T1 (F-51).
 *
 * Two layers are deliberately mixed here, and both are needed:
 *
 * - **Unicast path.** The server binds port 67 and the client port 68 with
 *   `Host.bindUdp()`, and every exchange is wrapped in
 *   `serializeUdp()`/`parseUdp()` with the DHCP ports. A Request that
 *   arrives here came addressed to the server itself, so the client already
 *   owns an address and the Ack goes back with `Host.sendUdp()`.
 * - **Broadcast path.** A booting client has no address, so its Discover is
 *   addressed to `0.0.0.0 -> 255.255.255.255`. `Host.receiveIpv4()` drops
 *   anything its interfaces do not own, so those datagrams reach the
 *   application layer through `Host.onPayload` instead (chained, never
 *   replaced: `close()` restores the previous hook). Offers, NAKs and every
 *   reply to a booting client are built the same way and leave with
 *   `Host.sendRaw()`, Ethernet-unicast to the `chaddr` the request carried,
 *   because ARP has nothing to resolve yet.
 *
 * The server hands out pool addresses, remembers one lease per hardware
 * address, answers DHCPOFFER to a Discover and DHCPACK to a Request it can
 * honour, and NAKs a Request for an address somebody else holds. Anything
 * else is ignored. Leases never expire inside a simulation: there is no
 * renewal or rebinding timer (F-73 covers acquisition), and the lease-time
 * option is carried for the client and the shell.
 *
 * The client is a four-state machine — `discover`, `request`, `bound` and
 * the terminal `failed` — driven only by `Simulation` timers. Each attempt
 * arms one timer and resends its message; after `retries` retransmissions it
 * gives up. A DHCPNAK drops the pending offer and restarts discovery with a
 * fresh transaction id. On the Ack it applies `Host.setIpConfig()` plus the
 * gateway and remembers the DNS servers for the shell. Transaction ids come
 * from `Simulation.random` and `secs` from `Simulation.now`: no `Math.random`
 * and no wall clock anywhere in this module.
 */

import { Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  DHCP_BROADCAST_FLAG,
  DHCP_CHADDR_LENGTH,
  DHCP_CLIENT_PORT,
  DHCP_FILE_LENGTH,
  DHCP_HLEN_ETHERNET,
  DHCP_HTYPE_ETHERNET,
  DHCP_MESSAGE_ACK,
  DHCP_MESSAGE_DISCOVER,
  DHCP_MESSAGE_NAK,
  DHCP_MESSAGE_OFFER,
  DHCP_MESSAGE_REQUEST,
  DHCP_OP_REPLY,
  DHCP_OP_REQUEST,
  DHCP_SERVER_PORT,
  DHCP_SNAME_LENGTH,
  type DhcpMessage,
  type DhcpOption,
  dhcpFindOption,
  dhcpHardwareAddress,
  dhcpMessageType,
  ETHERTYPE_IPV4,
  IPV4_PROTOCOL_UDP,
  IPV4_VERSION,
  parseDhcp,
  parseIpv4,
  parseUdp,
  serializeDhcp,
  serializeIpv4,
  serializeUdp,
} from "@netlab/protocols";
import type { Host, HostIpConfigInput, HostPayloadHandler } from "./host";
import { DEFAULT_IPV4_TTL } from "./route";
import type { Simulation, TimerHandle } from "./sim";

/** Default lease duration advertised to clients (seconds). */
export const DEFAULT_DHCP_LEASE_TIME_SECONDS = 3600;

/** Default virtual wait before retransmitting one DHCP message. */
export const DEFAULT_DHCP_TIMEOUT_US = 4_000_000;

/** Default retransmissions after the first attempt (total = retries + 1). */
export const DEFAULT_DHCP_RETRIES = 3;

const UNSPECIFIED = "0.0.0.0";
const LIMITED_BROADCAST = "255.255.255.255";
const LIMITED_BROADCAST_ADDRESS = Ipv4Address.parse(LIMITED_BROADCAST);
const UNSPECIFIED_ADDRESS = Ipv4Address.parse(UNSPECIFIED);
const MICROS_PER_SECOND = 1_000_000;
const MAX_SECONDS = 0xffff;
const ETHERNET_HARDWARE_LENGTH = 6;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite value >= 0: ${value}`);
  }
  return value;
}

function checkRetries(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`retries must be a non-negative integer: ${value}`);
  }
  return value;
}

function checkLeaseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`leaseTimeSeconds must be 0..4294967295: ${value}`);
  }
  return value;
}

function parseAddress(name: string, text: string): string {
  try {
    return Ipv4Address.parse(text).toString();
  } catch (err) {
    throw new RangeError(
      `${name} has an invalid IPv4 address: ${errorMessage(err)}`,
    );
  }
}

/** The host interface `name`, defaulting to the first one. */
function resolveInterface(host: Host, name: string | undefined): string {
  if (name !== undefined) {
    return host.getInterface(name).name;
  }
  const first = host.interfaces[0];
  if (first === undefined) {
    throw new RangeError(`${host.id}: DHCP needs at least one interface`);
  }
  return first.name;
}

function messageTypeOption(type: number): DhcpOption {
  return { kind: "message-type", type };
}

/**
 * Wrap one DHCP message in IPv4 + UDP for the DHCP ports.
 *
 * DHCP always travels as `0.0.0.0 -> 255.255.255.255` while a host has no
 * address of its own; the reply side keeps the same destination because the
 * client cannot answer ARP yet.
 */
function dhcpDatagram(
  src: Ipv4Address,
  dst: Ipv4Address,
  srcPort: number,
  dstPort: number,
  identification: number,
  message: DhcpMessage,
): Uint8Array {
  const segment = serializeUdp(
    { srcPort, dstPort, payload: serializeDhcp(message) },
    src,
    dst,
  );
  return serializeIpv4(
    {
      version: IPV4_VERSION,
      ihl: 5,
      dscp: 0,
      ecn: 0,
      totalLength: 0,
      identification: identification & 0xffff,
      flags: { reserved: false, dontFragment: true, moreFragments: false },
      fragmentOffset: 0,
      ttl: DEFAULT_IPV4_TTL,
      protocol: IPV4_PROTOCOL_UDP,
      checksum: 0,
      src,
      dst,
      options: new Uint8Array(0),
    },
    segment,
  );
}

/** Base BOOTP message for one direction; callers add `options`. */
function bootpMessage(
  op: number,
  xid: number,
  chaddr: Uint8Array,
  secs: number,
  options: DhcpOption[],
): DhcpMessage {
  return {
    op,
    htype: DHCP_HTYPE_ETHERNET,
    hlen: DHCP_HLEN_ETHERNET,
    hops: 0,
    xid,
    secs,
    flags: DHCP_BROADCAST_FLAG,
    ciaddr: UNSPECIFIED,
    yiaddr: UNSPECIFIED,
    siaddr: UNSPECIFIED,
    giaddr: UNSPECIFIED,
    chaddr: chaddr.slice(0, DHCP_CHADDR_LENGTH),
    sname: new Uint8Array(DHCP_SNAME_LENGTH),
    file: new Uint8Array(DHCP_FILE_LENGTH),
    options,
  };
}

/**
 * Decode the DHCP message carried by an IPv4 datagram whose destination the
 * host does not own (`0.0.0.0` or the limited broadcast address).
 */
function decodeBroadcastDhcp(
  payload: Uint8Array,
  port: number,
): DhcpMessage | undefined {
  const datagram = parseIpv4(payload);
  if (!datagram.ok) {
    return undefined;
  }
  const destination = datagram.value.header.dst.toString();
  if (destination !== UNSPECIFIED && destination !== LIMITED_BROADCAST) {
    return undefined;
  }
  const segment = parseUdp(datagram.value.payload);
  if (!segment.ok || segment.value.dstPort !== port) {
    return undefined;
  }
  const message = parseDhcp(segment.value.payload);
  return message.ok ? message.value : undefined;
}

/**
 * Wire one DHCP endpoint to a host.
 *
 * Returns the detach function that closes the socket and restores the
 * previous `onPayload` hook. `onMessage` receives the ingress interface name
 * and whether the datagram reached us through the socket (`true`) or through
 * the broadcast hook (`false`).
 */
function attachDhcpReceiver(
  host: Host,
  port: number,
  onMessage: (iface: string, message: DhcpMessage, unicast: boolean) => void,
): () => void {
  // Bind first: a port conflict must throw before the hook is installed.
  const socket = host.bindUdp(port, (datagram) => {
    const parsed = parseDhcp(datagram.payload);
    if (parsed.ok) {
      onMessage(datagram.iface, parsed.value, true);
    }
  });
  const previous = host.onPayload;
  const hooked: HostPayloadHandler = (iface, etherType, payload) => {
    previous?.(iface, etherType, payload);
    if (etherType !== ETHERTYPE_IPV4) {
      return;
    }
    const message = decodeBroadcastDhcp(payload, port);
    if (message !== undefined) {
      onMessage(iface.name, message, false);
    }
  };
  host.onPayload = hooked;
  return () => {
    socket.close();
    if (host.onPayload === hooked) {
      host.onPayload = previous;
    }
  };
}

/** Hardware address of a message, or undefined when it is not Ethernet. */
function hardwareAddress(message: DhcpMessage): MacAddress | undefined {
  const bytes = dhcpHardwareAddress(message);
  if (bytes.length !== ETHERNET_HARDWARE_LENGTH) {
    return undefined;
  }
  return MacAddress.fromBytes(bytes);
}

/** Whether two hardware addresses are the same. */
function sameHardware(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Lease lifecycle on the server: proposed by an Offer, or confirmed by an Ack. */
export type DhcpLeaseState = "offered" | "bound";

/** One address the server handed out (or reserved) for a hardware address. */
export interface DhcpLease {
  /** Client hardware address, `aa:bb:...` form. */
  mac: string;
  /** Leased IPv4 address, dotted decimal. */
  ip: string;
  state: DhcpLeaseState;
}

/** Counters of the messages a {@link DhcpServer} processed. */
export interface DhcpServerStats {
  discovers: number;
  offers: number;
  requests: number;
  acks: number;
  naks: number;
  /** DHCP messages that were neither a Discover nor a Request. */
  ignored: number;
}

/** Options for {@link DhcpServer}. */
export interface DhcpServerOptions {
  /** Host playing the DHCP server; it must own the server address. */
  host: Host;
  /** Addresses the server may hand out, in allocation order. */
  pool: readonly string[];
  /** Interface to serve on; default the first one. */
  iface?: string;
  /** Subnet mask offered to clients; default the interface mask. */
  mask?: string;
  /** Default gateway offered; `null` omits the router option. */
  gateway?: string | null;
  /** DNS servers offered; default none. */
  dnsServers?: readonly string[];
  /** Lease duration advertised in seconds. */
  leaseTimeSeconds?: number;
  /** Server identifier; default the interface address. */
  serverIp?: string;
}

/**
 * DHCP server for one subnet.
 *
 * Allocates from `pool` in order, keeps one lease per hardware address and
 * answers on the interface the request arrived on. It is silent when the
 * pool is exhausted (RFC 2131 §4.3.1), so a client keeps retrying instead of
 * being told to wait.
 */
export class DhcpServer {
  readonly host: Host;
  readonly iface: string;
  readonly serverIp: string;
  readonly mask: string;
  readonly gateway: string | undefined;
  readonly dnsServers: readonly string[];
  readonly leaseTimeSeconds: number;
  readonly pool: readonly string[];
  readonly stats: DhcpServerStats = {
    discovers: 0,
    offers: 0,
    requests: 0,
    acks: 0,
    naks: 0,
    ignored: 0,
  };

  private readonly leases = new Map<string, DhcpLease>();
  private readonly detach: () => void;
  private ipId = 1;

  constructor(options: DhcpServerOptions) {
    this.host = options.host;
    this.iface = resolveInterface(this.host, options.iface);
    if (options.pool.length === 0) {
      throw new RangeError("pool must contain at least one address");
    }
    const pool: string[] = [];
    for (const entry of options.pool) {
      const ip = parseAddress("pool entry", entry);
      if (ip === UNSPECIFIED || ip === LIMITED_BROADCAST) {
        throw new RangeError(`pool entry must be a host address: ${ip}`);
      }
      if (pool.includes(ip)) {
        throw new RangeError(`duplicate pool entry: ${ip}`);
      }
      pool.push(ip);
    }
    this.pool = pool;

    const config = this.host.getIpConfig(this.iface);
    const configured = config?.ip.toString();
    const serverIp =
      options.serverIp === undefined
        ? configured
        : parseAddress("serverIp", options.serverIp);
    if (serverIp === undefined) {
      throw new RangeError(
        `${this.host.id}:${this.iface}: DHCP server needs an IPv4 address`,
      );
    }
    this.serverIp = serverIp;
    this.mask = parseAddress(
      "mask",
      options.mask ?? config?.mask?.toString() ?? "255.255.255.0",
    );
    this.gateway =
      options.gateway === null
        ? undefined
        : options.gateway === undefined
          ? config?.gateway?.toString()
          : parseAddress("gateway", options.gateway);
    this.dnsServers = (options.dnsServers ?? []).map((entry) =>
      parseAddress("dnsServers", entry),
    );
    this.leaseTimeSeconds = checkLeaseSeconds(
      options.leaseTimeSeconds ?? DEFAULT_DHCP_LEASE_TIME_SECONDS,
    );
    this.detach = attachDhcpReceiver(
      this.host,
      DHCP_SERVER_PORT,
      (iface, message, unicast) => {
        this.handle(iface, message, unicast);
      },
    );
  }

  /** Leases in allocation order. */
  getLeases(): DhcpLease[] {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  /** Stop serving and restore the host hooks. Idempotent. */
  close(): void {
    this.detach();
  }

  private handle(iface: string, message: DhcpMessage, unicast: boolean): void {
    if (message.op !== DHCP_OP_REQUEST) {
      this.stats.ignored += 1;
      return;
    }
    const mac = hardwareAddress(message);
    if (mac === undefined) {
      this.stats.ignored += 1;
      return;
    }
    const type = dhcpMessageType(message.options);
    if (type === DHCP_MESSAGE_DISCOVER) {
      this.onDiscover(iface, message, mac);
      return;
    }
    if (type === DHCP_MESSAGE_REQUEST) {
      this.onRequest(iface, message, mac, unicast);
      return;
    }
    this.stats.ignored += 1;
  }

  private onDiscover(
    iface: string,
    message: DhcpMessage,
    mac: MacAddress,
  ): void {
    this.stats.discovers += 1;
    const existing = this.leases.get(mac.toString());
    if (existing !== undefined) {
      // A retransmitted Discover keeps its reservation, bound or not.
      this.sendOffer(iface, message, mac, existing.ip);
      return;
    }
    const ip = this.pool.find((entry) => this.holder(entry) === undefined);
    if (ip === undefined) {
      return;
    }
    this.leases.set(mac.toString(), {
      mac: mac.toString(),
      ip,
      state: "offered",
    });
    this.sendOffer(iface, message, mac, ip);
  }

  private onRequest(
    iface: string,
    message: DhcpMessage,
    mac: MacAddress,
    unicast: boolean,
  ): void {
    this.stats.requests += 1;
    const requested = dhcpFindOption(message.options, "requested-ip")?.ip;
    const wanted =
      requested ??
      (message.ciaddr === UNSPECIFIED ? undefined : message.ciaddr);
    if (wanted === undefined || !this.pool.includes(wanted)) {
      this.sendNak(iface, message, mac);
      return;
    }
    const holder = this.holder(wanted);
    if (holder !== undefined && holder.mac !== mac.toString()) {
      this.sendNak(iface, message, mac);
      return;
    }
    this.leases.set(mac.toString(), {
      mac: mac.toString(),
      ip: wanted,
      state: "bound",
    });
    this.stats.acks += 1;
    // A Request that reached the socket already carried the address the
    // client owns, so the Ack can go back over the normal UDP path. Every
    // other reply needs a raw frame: the peer may have no address yet.
    const replyTo = unicast && wanted === message.ciaddr ? wanted : undefined;
    this.transmit(
      iface,
      mac,
      {
        ...bootpMessage(DHCP_OP_REPLY, message.xid, mac.toBytes(), 0, [
          messageTypeOption(DHCP_MESSAGE_ACK),
          { kind: "server-id", id: this.serverIp },
          { kind: "subnet-mask", mask: this.mask },
          ...(this.gateway === undefined
            ? []
            : ([{ kind: "router", routers: [this.gateway] }] as DhcpOption[])),
          ...(this.dnsServers.length === 0
            ? []
            : ([
                { kind: "dns", servers: [...this.dnsServers] },
              ] as DhcpOption[])),
          { kind: "lease-time", seconds: this.leaseTimeSeconds },
        ]),
        yiaddr: wanted,
        siaddr: this.serverIp,
      },
      replyTo,
    );
  }

  private sendOffer(
    iface: string,
    request: DhcpMessage,
    mac: MacAddress,
    ip: string,
  ): void {
    this.stats.offers += 1;
    this.transmit(iface, mac, {
      ...bootpMessage(DHCP_OP_REPLY, request.xid, mac.toBytes(), 0, [
        messageTypeOption(DHCP_MESSAGE_OFFER),
        { kind: "server-id", id: this.serverIp },
        { kind: "subnet-mask", mask: this.mask },
        { kind: "lease-time", seconds: this.leaseTimeSeconds },
      ]),
      yiaddr: ip,
      siaddr: this.serverIp,
    });
  }

  private sendNak(iface: string, request: DhcpMessage, mac: MacAddress): void {
    this.stats.naks += 1;
    this.transmit(iface, mac, {
      ...bootpMessage(DHCP_OP_REPLY, request.xid, mac.toBytes(), 0, [
        messageTypeOption(DHCP_MESSAGE_NAK),
        { kind: "server-id", id: this.serverIp },
      ]),
      siaddr: this.serverIp,
    });
  }

  /**
   * Send one reply.
   *
   * With `unicastTo` the Ack rides the ordinary UDP socket path (the peer
   * owns that address); otherwise the reply leaves as a raw frame to the
   * client's `chaddr`, which is the only way to reach a host that has no
   * address and therefore cannot answer ARP.
   */
  private transmit(
    iface: string,
    mac: MacAddress,
    message: DhcpMessage,
    unicastTo?: string,
  ): void {
    this.ipId = (this.ipId % MAX_SECONDS) + 1;
    try {
      if (unicastTo !== undefined) {
        this.host.sendUdp(unicastTo, DHCP_CLIENT_PORT, serializeDhcp(message), {
          iface,
          srcPort: DHCP_SERVER_PORT,
        });
        return;
      }
      this.host.sendRaw(
        iface,
        mac,
        ETHERTYPE_IPV4,
        dhcpDatagram(
          Ipv4Address.parse(this.serverIp),
          LIMITED_BROADCAST_ADDRESS,
          DHCP_SERVER_PORT,
          DHCP_CLIENT_PORT,
          this.ipId,
          message,
        ),
      );
    } catch {
      // A routing failure or a down interface must not escape the receive
      // path: the client retries and the lease stays as it was.
    }
  }

  private holder(ip: string): DhcpLease | undefined {
    for (const lease of this.leases.values()) {
      if (lease.ip === ip) {
        return lease;
      }
    }
    return undefined;
  }
}

/** Client states: `idle` before `start()`, `failed` after the retries ran out. */
export type DhcpClientState =
  | "idle"
  | "discover"
  | "request"
  | "bound"
  | "failed";

/** The lease a {@link DhcpClient} applied to its interface. */
export interface DhcpClientLease {
  ip: string;
  /** Subnet mask from the Ack, when the server sent one. */
  mask: string | undefined;
  /** Default gateway from the Ack, when the server sent one. */
  gateway: string | undefined;
  /** DNS servers from the Ack; empty when it carried none. */
  dnsServers: readonly string[];
  /** Server identifier from the Ack, when present. */
  serverId: string | undefined;
  /** Advertised lease duration in seconds, when present. */
  leaseTimeSeconds: number | undefined;
  /** Virtual time the Ack arrived. */
  acquiredAt: number;
}

/** Counters of the messages a {@link DhcpClient} sent and accepted. */
export interface DhcpClientStats {
  discovers: number;
  offers: number;
  requests: number;
  acks: number;
  naks: number;
}

/** Options for {@link DhcpClient}. */
export interface DhcpClientOptions {
  /** Host to configure; it starts without an IPv4 address. */
  host: Host;
  /** Simulation whose clock, timers and PRNG drive the exchange. */
  sim: Simulation;
  /** Interface to configure; default the first one. */
  iface?: string;
  /** Virtual wait per attempt; default {@link DEFAULT_DHCP_TIMEOUT_US}. */
  timeoutUs?: number;
  /** Retransmissions; default {@link DEFAULT_DHCP_RETRIES}. */
  retries?: number;
  /** Initial state-change hook. */
  onStateChange?: (state: DhcpClientState) => void;
}

interface DhcpOffer {
  ip: string;
  serverId: string | undefined;
}

/**
 * DHCP client for one interface.
 *
 * `start()` runs DORA: Discover (broadcast), Offer, Request, Ack. Every
 * attempt arms one `Simulation` timer; a timeout retransmits the current
 * message, and after `retries` retransmissions the client stops in `failed`.
 * A DHCPNAK discards the offer and starts over with a fresh transaction id.
 */
export class DhcpClient {
  readonly host: Host;
  readonly sim: Simulation;
  readonly iface: string;
  readonly stats: DhcpClientStats = {
    discovers: 0,
    offers: 0,
    requests: 0,
    acks: 0,
    naks: 0,
  };
  /** Called after every state change. */
  onStateChange: ((state: DhcpClientState) => void) | undefined = undefined;

  private readonly timeoutUs: number;
  private readonly retries: number;
  private readonly mac: MacAddress;
  private readonly detach: () => void;
  private stateValue: DhcpClientState = "idle";
  private leaseValue: DhcpClientLease | undefined = undefined;
  private xid = 0;
  private transmissions = 0;
  private startedAt = 0;
  private offer: DhcpOffer | undefined = undefined;
  private timer: TimerHandle | undefined = undefined;
  private ipId = 1;

  constructor(options: DhcpClientOptions) {
    this.host = options.host;
    this.sim = options.sim;
    this.iface = resolveInterface(this.host, options.iface);
    this.timeoutUs = checkDuration(
      "timeoutUs",
      options.timeoutUs ?? DEFAULT_DHCP_TIMEOUT_US,
    );
    this.retries = checkRetries(options.retries ?? DEFAULT_DHCP_RETRIES);
    this.mac = this.host.getInterface(this.iface).mac;
    this.onStateChange = options.onStateChange;
    this.detach = attachDhcpReceiver(
      this.host,
      DHCP_CLIENT_PORT,
      (_iface, message) => {
        this.receive(message);
      },
    );
  }

  /** Current state of the DORA machine. */
  get state(): DhcpClientState {
    return this.stateValue;
  }

  /** Lease applied to the interface, undefined before the first Ack. */
  get lease(): DhcpClientLease | undefined {
    return this.leaseValue;
  }

  /**
   * DNS servers learned over DHCP, in wire order. The shell uses the first
   * one as its default resolver (T4).
   */
  get dnsServers(): readonly string[] {
    return this.leaseValue?.dnsServers ?? [];
  }

  /** Begin (or restart) discovery with a fresh transaction id. */
  start(): void {
    this.cancelTimer();
    this.leaseValue = undefined;
    this.offer = undefined;
    this.transmissions = 0;
    this.startedAt = this.sim.now;
    this.xid = this.nextXid();
    this.setState("discover");
    this.sendDiscover();
  }

  /** Stop listening, cancel timers and return to `idle`. Idempotent. */
  close(): void {
    this.cancelTimer();
    this.detach();
    this.offer = undefined;
    if (this.stateValue !== "idle") {
      this.setState("idle");
    }
  }

  private receive(message: DhcpMessage): void {
    if (message.op !== DHCP_OP_REPLY) {
      return;
    }
    if (this.stateValue !== "discover" && this.stateValue !== "request") {
      return;
    }
    if (message.xid !== this.xid) {
      return;
    }
    if (!sameHardware(dhcpHardwareAddress(message), this.mac.toBytes())) {
      return;
    }
    const type = dhcpMessageType(message.options);
    if (type === DHCP_MESSAGE_OFFER) {
      this.onOffer(message);
      return;
    }
    if (type === DHCP_MESSAGE_ACK) {
      this.onAck(message);
      return;
    }
    if (type === DHCP_MESSAGE_NAK) {
      this.onNak();
    }
  }

  private onOffer(message: DhcpMessage): void {
    this.stats.offers += 1;
    if (
      message.yiaddr === UNSPECIFIED ||
      message.yiaddr === LIMITED_BROADCAST
    ) {
      return;
    }
    this.offer = {
      ip: message.yiaddr,
      serverId: dhcpFindOption(message.options, "server-id")?.id,
    };
    this.setState("request");
    this.transmissions = 0;
    this.sendRequest();
  }

  private onAck(message: DhcpMessage): void {
    this.stats.acks += 1;
    const ip = message.yiaddr === UNSPECIFIED ? this.offer?.ip : message.yiaddr;
    if (ip === undefined) {
      return;
    }
    const mask = dhcpFindOption(message.options, "subnet-mask")?.mask;
    const gateway = dhcpFindOption(message.options, "router")?.routers[0];
    const dnsServers = dhcpFindOption(message.options, "dns")?.servers ?? [];
    const serverId = dhcpFindOption(message.options, "server-id")?.id;
    const leaseTimeSeconds = dhcpFindOption(
      message.options,
      "lease-time",
    )?.seconds;
    try {
      const config: HostIpConfigInput = { ip, gateway: gateway ?? null };
      if (mask !== undefined) {
        config.mask = mask;
      }
      this.host.setIpConfig(this.iface, config);
    } catch {
      // A lease the host cannot apply (e.g. an impossible mask) leaves the
      // client in `request`; its retry timer eventually fails it.
      return;
    }
    this.leaseValue = {
      ip,
      mask,
      gateway,
      dnsServers,
      serverId,
      leaseTimeSeconds,
      acquiredAt: this.sim.now,
    };
    this.cancelTimer();
    this.setState("bound");
  }

  private onNak(): void {
    this.stats.naks += 1;
    // The offered address is gone: start a new exchange from scratch.
    this.start();
  }

  private sendDiscover(): void {
    this.stats.discovers += 1;
    this.transmissions += 1;
    this.transmit(
      bootpMessage(
        DHCP_OP_REQUEST,
        this.xid,
        this.mac.toBytes(),
        this.secondsSinceStart(),
        [messageTypeOption(DHCP_MESSAGE_DISCOVER)],
      ),
    );
    this.arm();
  }

  private sendRequest(): void {
    const offer = this.offer;
    if (offer === undefined) {
      return;
    }
    this.stats.requests += 1;
    this.transmissions += 1;
    this.transmit(
      bootpMessage(
        DHCP_OP_REQUEST,
        this.xid,
        this.mac.toBytes(),
        this.secondsSinceStart(),
        [
          messageTypeOption(DHCP_MESSAGE_REQUEST),
          { kind: "requested-ip", ip: offer.ip },
          ...(offer.serverId === undefined
            ? []
            : ([{ kind: "server-id", id: offer.serverId }] as DhcpOption[])),
        ],
      ),
    );
    this.arm();
  }

  /** `secs` counts whole seconds since the last `start()`, from `sim.now`. */
  private secondsSinceStart(): number {
    return Math.min(
      MAX_SECONDS,
      Math.floor((this.sim.now - this.startedAt) / MICROS_PER_SECOND),
    );
  }

  private arm(): void {
    this.cancelTimer();
    this.timer = this.sim.schedule(this.timeoutUs, () => {
      this.timer = undefined;
      this.onTimeout();
    });
  }

  private cancelTimer(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  private onTimeout(): void {
    if (this.stateValue !== "discover" && this.stateValue !== "request") {
      return;
    }
    if (this.transmissions >= this.retries + 1) {
      this.setState("failed");
      return;
    }
    if (this.stateValue === "discover") {
      this.sendDiscover();
      return;
    }
    this.sendRequest();
  }

  private transmit(message: DhcpMessage): void {
    this.ipId = (this.ipId % MAX_SECONDS) + 1;
    try {
      this.host.sendRaw(
        this.iface,
        MacAddress.BROADCAST,
        ETHERTYPE_IPV4,
        dhcpDatagram(
          UNSPECIFIED_ADDRESS,
          LIMITED_BROADCAST_ADDRESS,
          DHCP_CLIENT_PORT,
          DHCP_SERVER_PORT,
          this.ipId,
          message,
        ),
      );
    } catch {
      // A down interface must not escape the receive path.
    }
  }

  private setState(state: DhcpClientState): void {
    if (this.stateValue === state) {
      return;
    }
    this.stateValue = state;
    if (state !== "bound") {
      this.cancelTimer();
    }
    this.onStateChange?.(state);
  }

  private nextXid(): number {
    const xid = Math.floor(this.sim.random.next() * 0x1_0000_0000) >>> 0;
    return xid === 0 ? 1 : xid;
  }
}
