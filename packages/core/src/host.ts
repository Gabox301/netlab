/**
 * End host: Ethernet interfaces plus an ARP cache with a pending queue
 * (F-12, F-13, F-19, F-20, F-21).
 *
 * ARP here is deliberately synchronous (decision S13): `sendTo()` consults
 * the cache and either transmits immediately or queues the frame and sends
 * one request; the reply arrives later through the normal event queue.
 * Nothing awaits a promise, so tests advance virtual time with
 * `sim.runAll()` / `runUntil()` only.
 *
 * IPv4 itself is phase 2 (decision S16). An address is an identity in the
 * ARP table and the source field of outgoing frames; the caller supplies
 * EtherType and payload.
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
  parseArp,
  parseEthernet,
  serializeArp,
  serializeEthernet,
  shouldAccept,
} from "@netlab/protocols";
import {
  Device,
  type InterfaceOptions,
  type NetworkInterface,
} from "./devices";
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

/** Per-interface configuration for `Host.addInterface()`. */
export interface HostInterfaceOptions extends InterfaceOptions {
  /** IPv4 identity used as the ARP sender address. */
  ip?: string;
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

/** Interface plus its addressing state. */
interface HostPort {
  iface: NetworkInterface;
  ip: Ipv4Address | undefined;
  arp: Map<string, ArpEntry>;
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

  private readonly arpTtlUs: number;
  private readonly arpTimeoutUs: number;
  private readonly arpRetries: number;
  private readonly arpQueueLimit: number;
  private readonly ports = new Map<string, HostPort>();

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
  }

  /** Create an interface, optionally with a MAC and an IPv4 address. */
  override addInterface(
    name: string,
    opts: HostInterfaceOptions = {},
  ): NetworkInterface {
    const iface = super.addInterface(
      name,
      opts.mac === undefined ? {} : { mac: opts.mac },
    );
    this.ports.set(name, {
      iface,
      ip: opts.ip === undefined ? undefined : Ipv4Address.parse(opts.ip),
      arp: new Map(),
    });
    return iface;
  }

  /** Assign (or replace) the IPv4 identity of an existing interface. */
  setAddress(ifaceName: string, ip: string): void {
    this.portOf(ifaceName).ip = Ipv4Address.parse(ip);
  }

  /**
   * Send an L3 payload to `destIp` through `ifaceName`.
   *
   * Resolves the next hop from the ARP cache, or queues the frame and starts
   * a resolution. Throws when the interface has no source address: ARP
   * cannot ask on behalf of a host without one.
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
    const known = this.arpLookup(ifaceName, destIp);
    if (known !== undefined) {
      this.sendRaw(ifaceName, known, etherType, payload);
      return;
    }
    const entry = this.entryFor(cfg, Ipv4Address.parse(destIp));
    if (entry.pending.length >= this.arpQueueLimit) {
      this.log(
        `${this.id}:${ifaceName}`,
        "warn",
        `ARP queue full for ${destIp}: dropped ${payload.length}-byte frame`,
      );
      return;
    }
    entry.pending.push({ etherType, payload });
    if (entry.timer === undefined) {
      this.startResolution(cfg, entry);
    }
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
    const entry = this.portOf(ifaceName).arp.get(
      Ipv4Address.parse(ip).toString(),
    );
    if (entry === undefined || entry.mac === undefined) {
      return undefined;
    }
    return entry.expiresAt > this.sim.now ? entry.mac : undefined;
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
    this.onPayload?.(iface, eth.etherType, eth.payload);
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
