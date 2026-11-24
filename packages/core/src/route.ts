/**
 * IPv4 routing: mask helpers, a longest-prefix-match table and the Router
 * device (F-32, F-33, F-35, F-36; S1, S2, S4, S6).
 *
 * The table holds three kinds of routes: connected networks derived from a
 * port's address/mask, static routes with an explicit gateway, and the
 * default route (`0.0.0.0/0`). Lookup maximizes prefix length, then
 * minimizes the metric, then keeps insertion order, so replays are stable.
 *
 * Forwarding decrements the TTL and re-serializes the header (which
 * recomputes the checksum), fragments to the egress port MTU unless DF is
 * set, and answers with RFC 792/1191 ICMP errors: Time Exceeded on TTL 0,
 * Destination Unreachable when the table has no match, and Fragmentation
 * Needed (with the MTU) when DF forbids splitting. Echo requests addressed
 * to the router itself get an Echo Reply, which makes `ping` to a gateway
 * work. ARP is per egress port, with a pending queue while the next hop
 * resolves.
 */

import { Cidr, Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  type ArpPacket,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_CODE_FRAG_NEEDED,
  ICMP_CODE_NET_UNREACHABLE,
  ICMP_CODE_TTL_EXCEEDED,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  type IcmpMessage,
  IPV4_MIN_HEADER_LENGTH,
  IPV4_PROTOCOL_ICMP,
  IPV4_VERSION,
  type Ipv4Header,
  type Ipv4Packet,
  parseArp,
  parseEthernet,
  parseIcmp,
  parseIpv4,
  serializeArp,
  serializeEthernet,
  serializeIcmp,
  serializeIpv4,
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
import type { Simulation, TimerHandle } from "./sim";
import type { TraceBus } from "./trace";

/** Default IPv4 MTU of a router port: 1500 bytes. */
export const DEFAULT_IPV4_MTU = 1500;

/** TTL for router-generated datagrams. */
export const DEFAULT_IPV4_TTL = 64;

const DEFAULT_ARP_TTL_US = 300_000_000;
const DEFAULT_ARP_TIMEOUT_US = 1_000_000;
const DEFAULT_ARP_RETRIES = 2;
const DEFAULT_ARP_QUEUE_LIMIT = 32;

/** RFC 826 request target: all zero bits. */
const UNSPECIFIED_MAC = MacAddress.parse("00:00:00:00:00:00");

/** `0.0.0.0/0`, the destination of a default route. */
const DEFAULT_DESTINATION = "0.0.0.0/0";

/** Kinds of route the table stores (F-32). */
export type RouteKind = "connected" | "static" | "default";

/** Input accepted by {@link RoutingTable.addRoute}. */
export interface RouteSpec {
  /** CIDR such as `10.0.1.0/24` or `0.0.0.0/0`. */
  destination: string | Cidr;
  /** Interface name the route resolves through. */
  iface: string;
  /** Next hop; omitted means directly connected. */
  gateway?: string | Ipv4Address;
  /** Preference among equal prefixes; lower wins. Default 0. */
  metric?: number;
}

/** One immutable row of the routing table. */
export interface RouteEntry {
  destination: Cidr;
  iface: string;
  gateway: Ipv4Address | undefined;
  metric: number;
  kind: RouteKind;
  /** Insertion index, the final tie-break. */
  order: number;
}

/** Dotted mask for `prefixLength` (`24` -> `255.255.255.0`). */
export function prefixToMask(prefixLength: number): Ipv4Address {
  if (
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > 32
  ) {
    throw new RangeError(`prefix length must be 0..32: ${prefixLength}`);
  }
  const value =
    prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return Ipv4Address.fromU32(value);
}

/** Prefix length of a contiguous dotted mask; throws when it is not one. */
export function prefixFromMask(mask: string | Ipv4Address): number {
  const value =
    typeof mask === "string" ? Ipv4Address.parse(mask).toU32() : mask.toU32();
  let prefix = 0;
  let sawZero = false;
  for (let bit = 31; bit >= 0; bit--) {
    if (((value >>> bit) & 1) === 1) {
      if (sawZero) {
        throw new Error(
          `invalid IPv4 mask (bits are not contiguous): ` +
            `${Ipv4Address.fromU32(value).toString()}`,
        );
      }
      prefix += 1;
    } else {
      sawZero = true;
    }
  }
  return prefix;
}

/** True when both addresses share `prefixLength` leading bits. */
export function sameSubnet(
  left: Ipv4Address,
  right: Ipv4Address,
  prefixLength: number,
): boolean {
  const mask = prefixToMask(prefixLength).toU32();
  return (left.toU32() & mask) === (right.toU32() & mask);
}

/** Split `10.0.0.1/24`; returns undefined when there is no slash. */
export function splitIpv4Prefix(
  text: string,
): { ip: Ipv4Address; prefixLength: number } | undefined {
  const slash = text.indexOf("/");
  if (slash < 0) {
    return undefined;
  }
  const address = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  if (!/^[0-9]{1,2}$/.test(prefixText)) {
    throw new Error(`invalid IPv4 prefix: ${JSON.stringify(text)}`);
  }
  const prefixLength = Number.parseInt(prefixText, 10);
  if (prefixLength > 32) {
    throw new Error(`invalid IPv4 prefix: ${JSON.stringify(text)}`);
  }
  return { ip: Ipv4Address.parse(address), prefixLength };
}

/**
 * Resolve an optional mask/prefix pair. Returns undefined when neither is
 * given; throws when both disagree.
 */
export function resolveOptionalPrefix(
  mask?: string,
  prefixLength?: number,
): number | undefined {
  if (prefixLength !== undefined) {
    if (
      !Number.isInteger(prefixLength) ||
      prefixLength < 0 ||
      prefixLength > 32
    ) {
      throw new RangeError(
        `prefix length must be an integer 0..32: ${prefixLength}`,
      );
    }
  }
  if (mask === undefined) {
    return prefixLength;
  }
  const fromMask = prefixFromMask(mask);
  if (prefixLength !== undefined && prefixLength !== fromMask) {
    throw new Error(`IPv4 mask ${mask} is /${fromMask}, not /${prefixLength}`);
  }
  return fromMask;
}

/**
 * Parse an IPv4 interface addressing form: `ip/prefix`, or `ip` plus a
 * mask or prefix length. The prefix is mandatory: a router/reassembling
 * host needs to know its connected network.
 */
export function parseIpv4Prefix(
  ip: string,
  mask?: string,
  prefixLength?: number,
): { ip: Ipv4Address; prefixLength: number } {
  const split = splitIpv4Prefix(ip);
  if (split !== undefined) {
    if (mask !== undefined || prefixLength !== undefined) {
      throw new Error(
        `ip ${JSON.stringify(ip)} already carries a prefix; ` +
          `remove mask/prefixLength`,
      );
    }
    return split;
  }
  const resolved = resolveOptionalPrefix(mask, prefixLength);
  if (resolved === undefined) {
    throw new Error(
      `missing mask or prefixLength for IPv4 interface ${JSON.stringify(ip)}`,
    );
  }
  return { ip: Ipv4Address.parse(ip), prefixLength: resolved };
}

function resolveMetric(metric: number | undefined): number {
  const value = metric ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `route metric must be a non-negative integer: ${value}`,
    );
  }
  return value;
}

function asCidr(destination: string | Cidr): Cidr {
  return typeof destination === "string"
    ? Cidr.parse(destination)
    : destination;
}

function isBetter(candidate: RouteEntry, current: RouteEntry): boolean {
  if (candidate.destination.prefixLength !== current.destination.prefixLength) {
    return (
      candidate.destination.prefixLength > current.destination.prefixLength
    );
  }
  if (candidate.metric !== current.metric) {
    return candidate.metric < current.metric;
  }
  return candidate.order < current.order;
}

/** Longest-prefix-match routing table (F-32). */
export class RoutingTable {
  private readonly routes: Array<RouteEntry> = [];
  private nextOrder = 0;

  /** Rows currently installed. */
  get size(): number {
    return this.routes.length;
  }

  /** Install the subnet a port is attached to (no gateway). */
  addConnected(iface: string, destination: string | Cidr): RouteEntry {
    return this.push(asCidr(destination), iface, undefined, 0);
  }

  /** Install a static route (gateway optional, metric defaults to 0). */
  addRoute(spec: RouteSpec): RouteEntry {
    const gateway =
      spec.gateway === undefined
        ? undefined
        : typeof spec.gateway === "string"
          ? Ipv4Address.parse(spec.gateway)
          : spec.gateway;
    return this.push(
      asCidr(spec.destination),
      spec.iface,
      gateway,
      resolveMetric(spec.metric),
    );
  }

  /** Install `0.0.0.0/0` through `gateway`. */
  addDefaultRoute(
    gateway: string | Ipv4Address,
    iface: string,
    metric = 0,
  ): RouteEntry {
    return this.addRoute({
      destination: DEFAULT_DESTINATION,
      gateway,
      iface,
      metric,
    });
  }

  /** Best route for `destination`, or undefined when nothing matches. */
  lookup(destination: string | Ipv4Address): RouteEntry | undefined {
    const target =
      typeof destination === "string"
        ? Ipv4Address.parse(destination)
        : destination;
    let best: RouteEntry | undefined;
    for (const entry of this.routes) {
      if (!entry.destination.contains(target)) {
        continue;
      }
      if (best === undefined || isBetter(entry, best)) {
        best = entry;
      }
    }
    return best === undefined ? undefined : { ...best };
  }

  /** Snapshot in insertion order, safe to keep after the call. */
  entries(): Array<RouteEntry> {
    return this.routes.map((entry) => ({ ...entry }));
  }

  /** Remove every route and reset the insertion counter. */
  clear(): void {
    this.routes.length = 0;
    this.nextOrder = 0;
  }

  private push(
    destination: Cidr,
    iface: string,
    gateway: Ipv4Address | undefined,
    metric: number,
  ): RouteEntry {
    if (iface.length === 0) {
      throw new Error("route iface must not be empty");
    }
    const kind: RouteKind =
      gateway === undefined
        ? "connected"
        : destination.prefixLength === 0
          ? "default"
          : "static";
    const entry: RouteEntry = {
      destination,
      iface,
      gateway,
      metric,
      kind,
      order: this.nextOrder++,
    };
    this.routes.push(entry);
    return { ...entry };
  }
}

/** IPv4 header length implied by its options, exactly as serialized. */
function headerLength(header: Ipv4Header): number {
  return IPV4_MIN_HEADER_LENGTH + header.options.length;
}

/**
 * Split `payload` so every fragment fits `mtu` bytes of IPv4 datagram.
 *
 * Fragment offsets stay multiples of 8 (units of 8 bytes on the wire), DF is
 * cleared on the pieces, MF is set on every piece except the last one of the
 * original datagram, and the identification/options are preserved. Returns
 * an empty array when the MTU cannot hold the header plus one 8-byte unit.
 * The input payload is never mutated.
 */
export function fragmentIpv4Datagram(
  header: Ipv4Header,
  payload: Uint8Array,
  mtu: number,
): Array<Uint8Array> {
  if (!Number.isInteger(mtu) || mtu <= headerLength(header)) {
    return [];
  }
  const maxPayload = Math.floor((mtu - headerLength(header)) / 8) * 8;
  if (maxPayload <= 0) {
    return [];
  }
  if (payload.length === 0) {
    return [
      serializeIpv4(
        {
          ...header,
          flags: {
            reserved: header.flags.reserved,
            dontFragment: false,
            moreFragments: false,
          },
        },
        payload,
      ),
    ];
  }
  const fragments: Array<Uint8Array> = [];
  for (let offset = 0; offset < payload.length; offset += maxPayload) {
    const chunk = payload.slice(offset, offset + maxPayload);
    const more =
      offset + chunk.length < payload.length || header.flags.moreFragments;
    fragments.push(
      serializeIpv4(
        {
          ...header,
          flags: {
            reserved: header.flags.reserved,
            dontFragment: false,
            moreFragments: more,
          },
          fragmentOffset: header.fragmentOffset + offset / 8,
        },
        chunk,
      ),
    );
  }
  return fragments;
}

/** Per-port configuration accepted by {@link Router.addPort}. */
export interface RouterPortOptions extends InterfaceOptions {
  /** Address; `10.0.0.1/24` or `10.0.0.1` plus `mask`/`prefixLength`. */
  ip: string;
  /** Prefix length (0..32), alternative to `mask`. */
  prefixLength?: number;
  /** Dotted subnet mask, alternative to `prefixLength`. */
  mask?: string;
  /** Egress MTU; default {@link DEFAULT_IPV4_MTU}. */
  mtu?: number;
}

/** Router tunables. Defaults mirror {@link Host} ARP and reassembly. */
export interface RouterOptions {
  arpTtlUs?: number;
  arpTimeoutUs?: number;
  arpRetries?: number;
  arpQueueLimit?: number;
  reassemblyTimeoutUs?: number;
  reassemblyMaxBytes?: number;
}

/** Snapshot of a router port, safe to keep after the call. */
export interface RouterPortConfig {
  name: string;
  ip: Ipv4Address;
  prefixLength: number;
  mask: Ipv4Address;
  mtu: number;
}

interface RouterArpEntry {
  ip: Ipv4Address;
  mac: MacAddress | undefined;
  expiresAt: number;
  attempts: number;
  timer: TimerHandle | undefined;
  /** IPv4 datagrams waiting for this next hop. */
  pending: Array<Uint8Array>;
}

interface RouterPort {
  iface: NetworkInterface;
  ip: Ipv4Address;
  prefixLength: number;
  mtu: number;
  arp: Map<string, RouterArpEntry>;
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

/** IPv4 router: routing table, per-port ARP, forwarding and ICMP errors. */
export class Router extends Device {
  private readonly table = new RoutingTable();
  private readonly ports = new Map<string, RouterPort>();
  private readonly arpTtlUs: number;
  private readonly arpTimeoutUs: number;
  private readonly arpRetries: number;
  private readonly arpQueueLimit: number;
  private readonly reassembler: Reassembler;
  private ipId = 1;

  constructor(
    sim: Simulation,
    id: string,
    bus: TraceBus,
    opts: RouterOptions = {},
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

  /**
   * Add an addressed port and install its connected route. `ip` may carry
   * `/prefix`; otherwise `mask` or `prefixLength` is required.
   */
  addPort(name: string, opts: RouterPortOptions): NetworkInterface {
    const { ip, prefixLength } = parseIpv4Prefix(
      opts.ip,
      opts.mask,
      opts.prefixLength,
    );
    const mtu = opts.mtu ?? DEFAULT_IPV4_MTU;
    if (!Number.isInteger(mtu) || mtu < 68) {
      throw new RangeError(
        `MTU must be an integer >= 68 (RFC 791 minimum): ${opts.mtu}`,
      );
    }
    const iface = super.addInterface(
      name,
      opts.mac === undefined ? {} : { mac: opts.mac },
    );
    this.ports.set(name, {
      iface,
      ip,
      prefixLength,
      mtu,
      arp: new Map(),
    });
    this.table.addConnected(
      name,
      Cidr.parse(`${ip.toString()}/${prefixLength}`),
    );
    return iface;
  }

  /** Install a static route through an existing port. */
  addRoute(spec: RouteSpec): RouteEntry {
    this.portOf(spec.iface);
    return this.table.addRoute(spec);
  }

  /** Install `0.0.0.0/0` through an existing port. */
  addDefaultRoute(
    gateway: string | Ipv4Address,
    iface: string,
    metric = 0,
  ): RouteEntry {
    return this.addRoute({
      destination: DEFAULT_DESTINATION,
      gateway,
      iface,
      metric,
    });
  }

  /** Best route for `destination`, or undefined. */
  lookupRoute(destination: string | Ipv4Address): RouteEntry | undefined {
    return this.table.lookup(destination);
  }

  /** Route snapshot in insertion order. */
  getRouteTable(): Array<RouteEntry> {
    return this.table.entries();
  }

  /** Port configuration snapshots in creation order. */
  getPorts(): Array<RouterPortConfig> {
    return [...this.ports.values()].map((port) => ({
      name: port.iface.name,
      ip: port.ip,
      prefixLength: port.prefixLength,
      mask: prefixToMask(port.prefixLength),
      mtu: port.mtu,
    }));
  }

  /** Resolved MAC for `ip` on `ifaceName`, or undefined when unknown/stale. */
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
    const port = this.portOf(iface.name);
    const owner = this.ownerOf(packet.senderIp);
    if (owner !== undefined && !owner.iface.mac.equals(packet.senderMac)) {
      this.log(
        `${this.id}:${iface.name}`,
        "warn",
        `ARP conflict: ${packet.senderIp} announced by ${packet.senderMac} ` +
          `but this router owns it on ${owner.iface.name}`,
      );
      return;
    }
    this.learn(port, packet.senderIp, packet.senderMac);
    if (packet.oper !== ARP_OP_REQUEST) {
      return;
    }
    if (port.ip.equals(packet.targetIp)) {
      this.sendArpReply(port, packet);
    }
  }

  private sendArpReply(port: RouterPort, request: ArpPacket): void {
    this.sendFrame(
      port,
      request.senderMac,
      serializeArp({
        oper: ARP_OP_REPLY,
        senderMac: port.iface.mac,
        senderIp: port.ip,
        targetMac: request.senderMac,
        targetIp: request.senderIp,
      }),
      ETHERTYPE_ARP,
    );
  }

  private receiveIpv4(iface: NetworkInterface, payload: Uint8Array): void {
    const parsed = parseIpv4(payload);
    if (!parsed.ok) {
      this.log(
        `${this.id}:${iface.name}`,
        "warn",
        `ipv4 dropped: ${parsed.error.message}`,
      );
      return;
    }
    const packet = parsed.value;
    if (this.ownerOf(packet.header.dst) !== undefined) {
      this.receiveLocal(packet);
      return;
    }
    this.forward(packet);
  }

  private receiveLocal(packet: Ipv4Packet): void {
    if (isFragmented(packet)) {
      const result = this.reassembler.add(packet);
      if (result.kind === "complete") {
        this.deliverLocal(result.packet);
      }
      return;
    }
    this.deliverLocal(packet);
  }

  private deliverLocal(packet: Ipv4Packet): void {
    if (packet.header.protocol !== IPV4_PROTOCOL_ICMP) {
      return;
    }
    const parsed = parseIcmp(packet.payload);
    if (!parsed.ok) {
      this.log(this.id, "warn", `local icmp dropped: ${parsed.error.message}`);
      return;
    }
    const message = parsed.value;
    if (message.kind !== "echo" || message.type !== ICMP_TYPE_ECHO_REQUEST) {
      return;
    }
    const reply = serializeIcmp({
      kind: "echo",
      type: ICMP_TYPE_ECHO_REPLY,
      code: 0,
      identifier: message.identifier,
      sequence: message.sequence,
      data: message.data.slice(),
    });
    const route = this.table.lookup(packet.header.src);
    if (route === undefined) {
      this.log(
        this.id,
        "warn",
        `no route to echo reply target ${packet.header.src}`,
      );
      return;
    }
    const egress = this.portOf(route.iface);
    const datagram = serializeIpv4(
      this.generatedHeader(
        egress,
        packet.header.src,
        IPV4_PROTOCOL_ICMP,
        packet.header.dst,
      ),
      reply,
    );
    this.transmit(egress, route.gateway ?? packet.header.src, datagram);
    this.state(`echo_reply src=${packet.header.dst} dst=${packet.header.src}`);
  }

  private forward(packet: Ipv4Packet): void {
    const destination = packet.header.dst;
    const route = this.table.lookup(destination);
    if (route === undefined) {
      this.log(
        this.id,
        "warn",
        `no route to ${destination}: sending destination unreachable`,
      );
      this.sendIcmpError(
        packet,
        ICMP_TYPE_DEST_UNREACHABLE,
        ICMP_CODE_NET_UNREACHABLE,
        undefined,
      );
      return;
    }
    if (packet.header.ttl <= 1) {
      this.state(`ttl_exceeded dst=${destination}`);
      this.sendIcmpError(
        packet,
        ICMP_TYPE_TIME_EXCEEDED,
        ICMP_CODE_TTL_EXCEEDED,
        undefined,
      );
      return;
    }
    const egress = this.portOf(route.iface);
    if (!egress.iface.up || !egress.iface.attached) {
      this.log(
        `${this.id}:${egress.iface.name}`,
        "warn",
        `egress is unusable for ${destination}: sending unreachable`,
      );
      this.sendIcmpError(
        packet,
        ICMP_TYPE_DEST_UNREACHABLE,
        ICMP_CODE_NET_UNREACHABLE,
        undefined,
      );
      return;
    }

    const ttl = packet.header.ttl - 1;
    const header: Ipv4Header = { ...packet.header, ttl };
    const totalLength = headerLength(header) + packet.payload.length;
    const nextHop = route.gateway ?? destination;

    if (totalLength > egress.mtu) {
      if (packet.header.flags.dontFragment) {
        this.log(
          this.id,
          "warn",
          `DF set and ${totalLength} bytes exceed ${egress.mtu}: ` +
            `fragmentation needed`,
        );
        this.sendIcmpError(
          packet,
          ICMP_TYPE_DEST_UNREACHABLE,
          ICMP_CODE_FRAG_NEEDED,
          egress.mtu,
        );
        return;
      }
      const fragments = fragmentIpv4Datagram(
        header,
        packet.payload,
        egress.mtu,
      );
      if (fragments.length === 0) {
        this.log(
          `${this.id}:${egress.iface.name}`,
          "warn",
          `MTU ${egress.mtu} cannot hold an IPv4 fragment header`,
        );
        return;
      }
      for (const fragment of fragments) {
        this.transmit(egress, nextHop, fragment);
      }
      this.state(
        `fragment dst=${destination} mtu=${egress.mtu} ` +
          `count=${fragments.length}`,
      );
      return;
    }

    this.transmit(egress, nextHop, serializeIpv4(header, packet.payload));
    this.state(
      `forward src=${packet.header.src} dst=${destination} ` +
        `ttl=${ttl} out=${egress.iface.name}`,
    );
  }

  private sendIcmpError(
    offending: Ipv4Packet,
    type: typeof ICMP_TYPE_DEST_UNREACHABLE | typeof ICMP_TYPE_TIME_EXCEEDED,
    code: number,
    mtu: number | undefined,
  ): void {
    // RFC 792/1812: never answer with an ICMP error when the datagram is a
    // non-initial fragment or is itself an ICMP error.
    if (offending.header.fragmentOffset > 0) {
      return;
    }
    if (offending.header.protocol === IPV4_PROTOCOL_ICMP) {
      const parsed = parseIcmp(offending.payload);
      if (parsed.ok && parsed.value.kind === "error") {
        return;
      }
    }
    const embedded = serializeIpv4(
      offending.header,
      offending.payload.slice(0, 8),
    );
    const message: IcmpMessage = {
      kind: "error",
      type,
      code,
      unused: mtu ?? 0,
      embedded,
    };
    const target = offending.header.src;
    const route = this.table.lookup(target);
    if (route === undefined) {
      this.log(this.id, "warn", `no route to ICMP error target ${target}`);
      return;
    }
    const egress = this.portOf(route.iface);
    if (!egress.iface.up || !egress.iface.attached) {
      this.log(
        `${this.id}:${egress.iface.name}`,
        "warn",
        `egress is unusable for ICMP error to ${target}`,
      );
      return;
    }
    const datagram = serializeIpv4(
      this.generatedHeader(egress, target, IPV4_PROTOCOL_ICMP),
      serializeIcmp(message),
    );
    if (datagram.length > egress.mtu) {
      this.log(
        `${this.id}:${egress.iface.name}`,
        "warn",
        `ICMP error to ${target} does not fit MTU ${egress.mtu}`,
      );
      return;
    }
    this.state(
      `icmp_error type=${type} code=${code} dst=${target} ` + `mtu=${mtu ?? 0}`,
    );
    this.transmit(egress, route.gateway ?? target, datagram);
  }

  private generatedHeader(
    port: RouterPort,
    destination: Ipv4Address,
    protocol: number,
    source: Ipv4Address = port.ip,
  ): Ipv4Header {
    return {
      version: IPV4_VERSION,
      ihl: 5,
      dscp: 0,
      ecn: 0,
      totalLength: 0,
      identification: this.nextIpId(),
      flags: { reserved: false, dontFragment: false, moreFragments: false },
      fragmentOffset: 0,
      ttl: DEFAULT_IPV4_TTL,
      protocol,
      checksum: 0,
      src: source,
      dst: destination,
      options: new Uint8Array(0),
    };
  }

  private nextIpId(): number {
    const id = this.ipId;
    this.ipId = (this.ipId + 1) & 0xffff;
    return id;
  }

  /** ARP resolution plus L2 transmission of one IPv4 datagram. */
  private transmit(
    port: RouterPort,
    nextHop: Ipv4Address,
    datagram: Uint8Array,
  ): void {
    if (!port.iface.up || !port.iface.attached) {
      this.log(
        `${this.id}:${port.iface.name}`,
        "warn",
        `cannot send to ${nextHop}: interface is not usable`,
      );
      return;
    }
    const mac = this.macFor(port, nextHop);
    if (mac !== undefined) {
      this.sendFrame(port, mac, datagram, ETHERTYPE_IPV4);
      return;
    }
    const entry = this.entryFor(port, nextHop);
    if (entry.pending.length >= this.arpQueueLimit) {
      this.log(
        `${this.id}:${port.iface.name}`,
        "warn",
        `ARP queue full for ${nextHop}: dropped ${datagram.length}-byte ` +
          `datagram`,
      );
      return;
    }
    entry.pending.push(datagram);
    if (entry.timer === undefined) {
      this.startResolution(port, entry);
    }
  }

  private sendFrame(
    port: RouterPort,
    destination: MacAddress,
    payload: Uint8Array,
    etherType: number,
  ): void {
    port.iface.send(
      serializeEthernet(
        { dst: destination, src: port.iface.mac, etherType },
        payload,
      ),
    );
  }

  private macFor(port: RouterPort, ip: Ipv4Address): MacAddress | undefined {
    const entry = port.arp.get(ip.toString());
    if (entry === undefined || entry.mac === undefined) {
      return undefined;
    }
    return entry.expiresAt > this.sim.now ? entry.mac : undefined;
  }

  private learn(port: RouterPort, ip: Ipv4Address, mac: MacAddress): void {
    const entry = this.entryFor(port, ip);
    const timer = entry.timer;
    entry.timer = undefined;
    timer?.cancel();
    entry.mac = mac;
    entry.attempts = 0;
    entry.expiresAt = this.sim.now + this.arpTtlUs;
    if (entry.pending.length > 0) {
      this.flush(port, entry);
    }
  }

  private flush(port: RouterPort, entry: RouterArpEntry): void {
    const mac = entry.mac;
    if (mac === undefined) {
      return;
    }
    const queued = entry.pending;
    entry.pending = [];
    for (const datagram of queued) {
      this.sendFrame(port, mac, datagram, ETHERTYPE_IPV4);
    }
  }

  private entryFor(port: RouterPort, ip: Ipv4Address): RouterArpEntry {
    const key = ip.toString();
    const existing = port.arp.get(key);
    if (existing === undefined) {
      const created: RouterArpEntry = {
        ip,
        mac: undefined,
        expiresAt: 0,
        attempts: 0,
        timer: undefined,
        pending: [],
      };
      port.arp.set(key, created);
      return created;
    }
    if (
      existing.timer === undefined &&
      existing.mac !== undefined &&
      existing.expiresAt <= this.sim.now
    ) {
      existing.mac = undefined;
      existing.expiresAt = 0;
      existing.attempts = 0;
    }
    return existing;
  }

  private startResolution(port: RouterPort, entry: RouterArpEntry): void {
    if (!port.iface.up || !port.iface.attached) {
      this.abandon(port, entry, `${port.iface.name} is not usable for ARP`);
      return;
    }
    entry.attempts += 1;
    this.sendFrame(
      port,
      MacAddress.BROADCAST,
      serializeArp({
        oper: ARP_OP_REQUEST,
        senderMac: port.iface.mac,
        senderIp: port.ip,
        targetMac: UNSPECIFIED_MAC,
        targetIp: entry.ip,
      }),
      ETHERTYPE_ARP,
    );
    entry.timer = this.sim.schedule(this.arpTimeoutUs, () =>
      this.onArpTimeout(port, entry),
    );
  }

  private onArpTimeout(port: RouterPort, entry: RouterArpEntry): void {
    entry.timer = undefined;
    if (entry.mac !== undefined) {
      return;
    }
    if (entry.attempts <= this.arpRetries) {
      this.startResolution(port, entry);
      return;
    }
    this.abandon(
      port,
      entry,
      `host unreachable: no ARP reply from ${entry.ip} after ` +
        `${entry.attempts} requests`,
    );
  }

  private abandon(
    port: RouterPort,
    entry: RouterArpEntry,
    reason: string,
  ): void {
    const timer = entry.timer;
    entry.timer = undefined;
    timer?.cancel();
    port.arp.delete(entry.ip.toString());
    const dropped = entry.pending.length;
    entry.pending = [];
    this.log(
      `${this.id}:${port.iface.name}`,
      "warn",
      `${reason} (${dropped} datagrams dropped)`,
    );
  }

  private ownerOf(ip: Ipv4Address): RouterPort | undefined {
    for (const port of this.ports.values()) {
      if (port.ip.equals(ip)) {
        return port;
      }
    }
    return undefined;
  }

  private portOf(name: string): RouterPort {
    const port = this.ports.get(name);
    if (port === undefined) {
      throw new Error(`${this.id}: no interface named ${JSON.stringify(name)}`);
    }
    return port;
  }

  private state(detail: string): void {
    this.bus.emit({ t: this.sim.now, kind: "state", scope: this.id, detail });
  }

  private log(scope: string, level: string, message: string): void {
    this.bus.emit({ t: this.sim.now, kind: "log", scope, level, message });
  }
}
