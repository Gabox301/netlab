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
 * else is ignored. Every bound lease carries its expiry (`now + lease-time`,
 * from the `sim` option) and the server prunes expired ones lazily, on the
 * next message or `getLeases()` call, so the address returns to the pool and
 * can be reassigned — a Request for an address an expired lease used to hold
 * is NAKed once somebody else owns it. A Request that renews a live lease
 * (same hardware address, same address) only moves its expiry forward.
 *
 * The client walks `discover` -> `request` -> `bound` and, when `autoRenew` is
 * on, `renew` (unicast at T1 = 50% of the lease) -> `rebind` (broadcast at
 * T2 = 87.5%) -> a fresh discovery when the lease runs out; `failed` is
 * terminal. Every phase is driven only by `Simulation` timers. Each DORA
 * attempt arms one timer and resends its message; after `retries`
 * retransmissions the client gives up. A DHCPNAK drops the pending offer and
 * restarts discovery with a fresh transaction id. On every Ack it applies
 * `Host.setIpConfig()` plus the gateway, remembers the DNS servers for the
 * shell and re-arms the lease timers. Transaction ids come from
 * `Simulation.random` and `secs` from `Simulation.now`: no `Math.random` and
 * no wall clock anywhere in this module.
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

/** Fraction of the lease at which a bound client renews (T1, RFC 2131 §4.4.5). */
export const DHCP_RENEW_RATIO = 0.5;

/** Fraction of the lease at which a renewing client rebinds by broadcast (T2). */
export const DHCP_REBIND_RATIO = 0.875;

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
  /**
   * Virtual time the bound lease expires; undefined while it is only offered
   * (an Offer reserves the address until the client Requests it) and on a
   * server built without a `sim` clock.
   */
  expiresAt?: number;
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
  /**
   * Simulation clock used to stamp and prune lease expiries. Without it the
   * server has no clock and its leases never expire.
   */
  sim?: Simulation;
}

/**
 * DHCP server for one subnet.
 *
 * Allocates from `pool` in order, keeps one lease per hardware address and
 * answers on the interface the request arrived on. It is silent when the
 * pool is exhausted (RFC 2131 §4.3.1), so a client keeps retrying instead of
 * being told to wait. With a `sim` clock every bound lease expires
 * `lease-time` after it was granted or last renewed.
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
  private readonly clock: Simulation | undefined;
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
    this.clock = options.sim;
    this.detach = attachDhcpReceiver(
      this.host,
      DHCP_SERVER_PORT,
      (iface, message, unicast) => {
        this.handle(iface, message, unicast);
      },
    );
  }

  /** Virtual time in microseconds, or undefined without a `sim` clock. */
  private get nowUs(): number | undefined {
    return this.clock?.now;
  }

  /** Leases in allocation order; expired ones are dropped first. */
  getLeases(): DhcpLease[] {
    this.pruneExpired();
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  /**
   * Drop leases past their expiry so their addresses return to the pool.
   *
   * Expiry is lazy on purpose: a lease nobody asks about needs no timer, and
   * a simulation that drains its event queue (`runAll()`) must not be kept
   * alive by bookkeeping the next request would redo anyway.
   */
  private pruneExpired(now: number | undefined = this.nowUs): void {
    if (now === undefined) {
      return;
    }
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt !== undefined && now >= lease.expiresAt) {
        this.leases.delete(key);
      }
    }
  }

  /** Expiry stamped on a lease granted right now, or undefined without a clock. */
  private leaseExpiry(): number | undefined {
    const now = this.nowUs;
    if (now === undefined) {
      return undefined;
    }
    return now + this.leaseTimeSeconds * MICROS_PER_SECOND;
  }

  /** Stop serving and restore the host hooks. Idempotent. */
  close(): void {
    this.detach();
  }

  private handle(iface: string, message: DhcpMessage, unicast: boolean): void {
    // Every request sees an up-to-date pool: a lease that ran out while the
    // segment was quiet is reusable (and, once reused, a renewal of it is
    // NAKed like any other address nobody owns).
    this.pruneExpired();
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
    // A renewal lands here too: same hardware address, same address, live
    // lease, so only the expiry moves and the client keeps its configuration.
    const expiresAt = this.leaseExpiry();
    this.leases.set(mac.toString(), {
      mac: mac.toString(),
      ip: wanted,
      state: "bound",
      ...(expiresAt === undefined ? {} : { expiresAt }),
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
  | "renew"
  | "rebind"
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
  /**
   * Virtual time the lease dies (`acquiredAt` + lease time); undefined when
   * the Ack carried no lease-time, which leaves the client with a lease it
   * cannot expire.
   */
  expiresAt: number | undefined;
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
  /**
   * Follow the lease timers: renew at T1 (50% of the lease, unicast to the
   * server that granted it), rebind at T2 (87.5%, broadcast) and go back to
   * discovery when the lease runs out.
   *
   * Off by default. A renewing client never stops scheduling events, so a
   * `Simulation` that drains its queue (`runAll()`) would never finish; the
   * scenarios that want the lifecycle turn it on and drive the clock with
   * `runUntil()`.
   */
  autoRenew?: boolean;
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
 *
 * With `autoRenew` the Ack also arms the lease timers: `renew` unicasts a
 * Request to the server identifier at T1 (50% of the lease), `rebind`
 * broadcasts it at T2 (87.5%) when that server stopped answering, and the
 * lease deadline itself sends the client back to discovery with the address
 * cleared. Both renewing messages carry the leased address in `ciaddr`, so a
 * server recognises the lease and only moves its expiry (RFC 2131 §4.3.2).
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
  private readonly autoRenew: boolean;
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
    this.autoRenew = options.autoRenew ?? false;
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
    if (
      this.stateValue !== "discover" &&
      this.stateValue !== "request" &&
      this.stateValue !== "renew" &&
      this.stateValue !== "rebind"
    ) {
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
      // An Offer only matters while acquiring; during the lease lifecycle the
      // client already owns an address.
      if (this.stateValue === "discover" || this.stateValue === "request") {
        this.onOffer(message);
      }
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
    // A renewing Ack may leave `yiaddr` empty: the client already owns the
    // address, which the server echoed in `ciaddr`.
    const current = this.offer?.ip ?? this.leaseValue?.ip;
    const ip = message.yiaddr === UNSPECIFIED ? current : message.yiaddr;
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
    const acquiredAt = this.sim.now;
    this.leaseValue = {
      ip,
      mask,
      gateway,
      dnsServers,
      serverId,
      leaseTimeSeconds,
      acquiredAt,
      expiresAt:
        leaseTimeSeconds === undefined
          ? undefined
          : acquiredAt + leaseTimeSeconds * MICROS_PER_SECOND,
    };
    this.offer = undefined;
    this.cancelTimer();
    this.setState("bound");
    this.armLeaseTimer();
  }

  private onNak(): void {
    this.stats.naks += 1;
    // The lease is not ours (or the offer is gone): start a new exchange from
    // scratch. The applied configuration is left alone on purpose — a NAK is
    // an answer, and a fresh DORA replaces the address one round trip later.
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

  /**
   * T1: the point where a bound client starts renewing, half the lease.
   *
   * Timers are derived from the lease itself (`acquiredAt`/`expiresAt`), not
   * from a server option, which is why an Ack without `lease-time` leaves the
   * client with no renewal at all.
   */
  private renewAt(lease: DhcpClientLease): number {
    return this.ratioAt(lease, DHCP_RENEW_RATIO);
  }

  /** T2: the point where the client gives up on its server and broadcasts. */
  private rebindAt(lease: DhcpClientLease): number {
    return this.ratioAt(lease, DHCP_REBIND_RATIO);
  }

  private ratioAt(lease: DhcpClientLease, ratio: number): number {
    const expiresAt = lease.expiresAt as number;
    return lease.acquiredAt + (expiresAt - lease.acquiredAt) * ratio;
  }

  /**
   * Next lease deadline for the current phase.
   *
   * While retries remain it is the next retransmission; once the budget for a
   * phase is gone it is the phase's own deadline (T2 for renewing, the lease
   * expiry for rebinding), so an unanswered renewal waits quietly instead of
   * polling.
   */
  private leaseDeadline(lease: DhcpClientLease): number {
    const exhausted = this.transmissions >= this.retries + 1;
    if (this.stateValue === "bound") {
      return this.renewAt(lease);
    }
    if (this.stateValue === "renew") {
      return exhausted
        ? this.rebindAt(lease)
        : Math.min(this.sim.now + this.timeoutUs, this.rebindAt(lease));
    }
    if (this.stateValue === "rebind") {
      return exhausted
        ? (lease.expiresAt as number)
        : Math.min(this.sim.now + this.timeoutUs, lease.expiresAt as number);
    }
    return lease.expiresAt as number;
  }

  /** Schedule the single lease timer, clamped to the lease expiry. */
  private armLeaseTimer(): void {
    this.cancelTimer();
    const lease = this.leaseValue;
    const expiresAt = lease?.expiresAt;
    if (!this.autoRenew || lease === undefined || expiresAt === undefined) {
      return;
    }
    // A zero-second lease carries no deadline: arming it would loop through
    // expire -> discover -> Ack at the same virtual time.
    if (expiresAt <= lease.acquiredAt) {
      return;
    }
    const now = this.sim.now;
    const at = Math.max(now, Math.min(this.leaseDeadline(lease), expiresAt));
    this.timer = this.sim.scheduleAt(at, () => {
      this.timer = undefined;
      this.onLeaseTimer();
    });
  }

  /** One lease deadline: start renewing, start rebinding, retransmit or die. */
  private onLeaseTimer(): void {
    const lease = this.leaseValue;
    const expiresAt = lease?.expiresAt;
    if (lease === undefined || expiresAt === undefined) {
      return;
    }
    if (this.sim.now >= expiresAt) {
      this.expireLease();
      return;
    }
    if (this.stateValue === "bound") {
      this.beginRenew(lease);
      return;
    }
    if (this.stateValue === "renew") {
      if (this.sim.now >= this.rebindAt(lease)) {
        this.beginRebind(lease);
        return;
      }
      if (this.transmissions >= this.retries + 1) {
        // Unanswered renewal: wait for T2 instead of flooding the server.
        this.armLeaseTimer();
        return;
      }
      this.sendLeaseRequest(lease, "renew");
      this.armLeaseTimer();
      return;
    }
    if (this.stateValue === "rebind") {
      if (this.transmissions >= this.retries + 1) {
        // Nothing answered on the broadcast either: only the expiry is left.
        this.armLeaseTimer();
        return;
      }
      this.sendLeaseRequest(lease, "rebind");
      this.armLeaseTimer();
    }
  }

  /** Enter RENEWING: unicast to the server that granted the lease. */
  private beginRenew(lease: DhcpClientLease): void {
    this.setState("renew");
    this.transmissions = 0;
    this.xid = this.nextXid();
    if (lease.serverId === undefined) {
      // Without a server identifier there is nobody to unicast to, so the
      // renewal starts as a rebind.
      this.beginRebind(lease);
      return;
    }
    this.sendLeaseRequest(lease, "renew");
    this.armLeaseTimer();
  }

  /** Enter REBINDING: broadcast, because the renewing server went quiet. */
  private beginRebind(lease: DhcpClientLease): void {
    this.setState("rebind");
    this.transmissions = 0;
    this.xid = this.nextXid();
    this.sendLeaseRequest(lease, "rebind");
    this.armLeaseTimer();
  }

  /**
   * One Request during the lease lifecycle.
   *
   * RFC 2131 §4.3.2: RENEWING unicasts to the server identifier with the
   * leased address in `ciaddr` and no `requested-ip`; REBINDING sends the
   * same message to the broadcast address because the server that granted
   * the lease stopped answering.
   */
  private sendLeaseRequest(
    lease: DhcpClientLease,
    phase: "renew" | "rebind",
  ): void {
    this.stats.requests += 1;
    this.transmissions += 1;
    const message = bootpMessage(
      DHCP_OP_REQUEST,
      this.xid,
      this.mac.toBytes(),
      this.secondsSinceStart(),
      [messageTypeOption(DHCP_MESSAGE_REQUEST)],
    );
    message.ciaddr = lease.ip;
    if (phase === "renew" && lease.serverId !== undefined) {
      this.transmitUnicast(lease.serverId, message);
      return;
    }
    this.transmit(message);
  }

  /**
   * The lease ran out with nothing answering.
   *
   * The address is no longer defensible, so the interface goes back to
   * 0.0.0.0 before discovery restarts with a fresh transaction id. A NAK
   * deliberately does not do this: the server answered and the next DORA is a
   * round trip away, so the configuration stays until the new Ack replaces
   * it.
   */
  private expireLease(): void {
    this.cancelTimer();
    this.clearIpConfig();
    this.leaseValue = undefined;
    this.start();
  }

  private clearIpConfig(): void {
    try {
      this.host.setIpConfig(this.iface, { ip: UNSPECIFIED, gateway: null });
    } catch {
      // A host that refuses the reset keeps the stale address; the lease is
      // gone either way and discovery continues.
    }
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

  /**
   * Unicast one renewal through the normal UDP path.
   *
   * The client owns an address by now, so the socket layer can resolve the
   * server and the exchange looks like any other UDP datagram.
   */
  private transmitUnicast(serverId: string, message: DhcpMessage): void {
    this.ipId = (this.ipId % MAX_SECONDS) + 1;
    try {
      this.host.sendUdp(serverId, DHCP_SERVER_PORT, serializeDhcp(message), {
        iface: this.iface,
        srcPort: DHCP_CLIENT_PORT,
      });
    } catch {
      // Unroutable (or an address the host cannot source): the retry timer
      // covers it and T2 turns the client into a rebinding one.
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
