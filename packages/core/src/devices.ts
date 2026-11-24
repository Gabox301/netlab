/**
 * Device plumbing: interfaces, MAC admission and counters.
 *
 * Every simulated device owns a set of {@link NetworkInterface}s, and an
 * interface is what a {@link Link} talks to: it receives frames from the
 * wire and sends frames back. Frames are counted at the interface (F-13) so
 * the numbers stay meaningful even for devices that never look inside a
 * frame (a hub) or that refuse it (a host whose MAC does not match).
 *
 * The Ethernet admission prologue — parse, then `shouldAccept` — lives in
 * each concrete device instead of here: a switch is promiscuous by
 * construction, a host is not, and a hub does not parse at all. Keeping the
 * policy in the device makes the difference explicit rather than a flag
 * the base class would have to special-case.
 *
 * Interfaces created without a MAC get a locally administered unicast
 * address (`02:<5 random bytes>`) drawn from the simulation PRNG, so replays
 * stay reproducible (decision S14).
 */

import { MacAddress } from "@netlab/bytes";
import type { Link, Port } from "./link";
import type { Simulation } from "./sim";
import type { EndpointId, TraceBus } from "./trace";

/** Per-interface counters (F-13). */
export interface InterfaceCounters {
  rxFrames: number;
  rxBytes: number;
  txFrames: number;
  txBytes: number;
  /** Frames that reached the device but could not be decoded. */
  rxErrors: number;
  /** Well-formed frames the MAC filter refused (not addressed here). */
  rxDropped: number;
}

function emptyCounters(): InterfaceCounters {
  return {
    rxFrames: 0,
    rxBytes: 0,
    txFrames: 0,
    txBytes: 0,
    rxErrors: 0,
    rxDropped: 0,
  };
}

/** First octet of an invented MAC: locally administered, unicast (S14). */
const AUTO_MAC_PREFIX = 0x02;

/** Options accepted by `Device.addInterface()`. */
export interface InterfaceOptions {
  /** Explicit MAC; omitted means an automatic `02:...` address. */
  mac?: string;
}

/**
 * One port of a device: a MAC address, an administrative state, counters
 * and the link it is plugged into.
 */
export class NetworkInterface implements Port {
  readonly name: string;
  readonly mac: MacAddress;
  /** Administrative state. A down interface counts but never processes. */
  up = true;
  readonly counters: InterfaceCounters = emptyCounters();

  /** Accept every destination MAC (a switch port is promiscuous). */
  promiscuous = false;
  /** Multicast groups this interface has joined (F-12). */
  readonly multicastGroups: Array<MacAddress> = [];

  private readonly device: Device;
  private link: Link | undefined;
  private side: EndpointId | undefined;

  /** Interfaces belong to a device: create them with `addInterface()`. */
  constructor(device: Device, name: string, mac: MacAddress) {
    this.device = device;
    this.name = name;
    this.mac = mac;
  }

  /** True when a link is plugged in. */
  get attached(): boolean {
    return this.link !== undefined;
  }

  /** Link endpoint this interface occupies, if any. */
  get endpoint(): EndpointId | undefined {
    return this.side;
  }

  /** Plug into one end of `link`. Prefer {@link connect}. */
  attachLink(link: Link, side: EndpointId): void {
    this.link = link;
    this.side = side;
  }

  /** Unplug from the current link, if any. */
  detachLink(): void {
    this.link = undefined;
    this.side = undefined;
  }

  /**
   * Deliver a frame from the wire. Counters move even when the interface is
   * administratively down; the frame is then dropped without notice (S15:
   * the interface never adds its own trace, the link already reported it).
   */
  receive(frame: Uint8Array): void {
    this.counters.rxFrames += 1;
    this.counters.rxBytes += frame.length;
    if (!this.up) {
      return;
    }
    this.device.onFrame(this, frame);
  }

  /** Transmit a frame on the attached link. */
  send(frame: Uint8Array): void {
    const link = this.link;
    const side = this.side;
    if (!this.up) {
      throw new Error(`${this.device.id}:${this.name}: interface is down`);
    }
    if (link === undefined || side === undefined) {
      throw new Error(
        `${this.device.id}:${this.name}: interface is not attached to a link`,
      );
    }
    this.counters.txFrames += 1;
    this.counters.txBytes += frame.length;
    link.send(side, frame);
  }
}

/** Common state for every simulated device. */
export abstract class Device {
  readonly id: string;
  /** Interfaces in creation order. */
  readonly interfaces: Array<NetworkInterface> = [];

  protected readonly sim: Simulation;
  protected readonly bus: TraceBus;

  private readonly byName = new Map<string, NetworkInterface>();

  constructor(sim: Simulation, id: string, bus: TraceBus) {
    this.sim = sim;
    this.id = id;
    this.bus = bus;
  }

  /**
   * Handle a frame that an interface already counted and that passed the
   * device's admission rules. Receivers must treat `frame` as read-only.
   */
  abstract onFrame(iface: NetworkInterface, frame: Uint8Array): void;

  /** Look up an interface by name. Throws on unknown names. */
  getInterface(name: string): NetworkInterface {
    const found = this.byName.get(name);
    if (found === undefined) {
      throw new Error(`${this.id}: no interface named ${JSON.stringify(name)}`);
    }
    return found;
  }

  /**
   * Create and register an interface. Without `opts.mac` the address is
   * `02:` plus five bytes from the simulation PRNG (S14).
   */
  protected addInterface(
    name: string,
    opts: InterfaceOptions = {},
  ): NetworkInterface {
    if (this.byName.has(name)) {
      throw new Error(
        `${this.id}: duplicate interface name ${JSON.stringify(name)}`,
      );
    }
    const mac =
      opts.mac === undefined ? this.autoMac() : MacAddress.parse(opts.mac);
    const iface = new NetworkInterface(this, name, mac);
    this.interfaces.push(iface);
    this.byName.set(name, iface);
    return iface;
  }

  private autoMac(): MacAddress {
    const random = this.sim.random;
    const octets = new Uint8Array(6);
    octets[0] = AUTO_MAC_PREFIX;
    for (let i = 1; i < 6; i++) {
      octets[i] = Math.floor(random.next() * 256);
    }
    return MacAddress.fromBytes(octets);
  }
}

/** Plug two interfaces into the two ends of `link`. */
export function connect(
  link: Link,
  a: NetworkInterface,
  b: NetworkInterface,
): void {
  link.attach(a, b);
  a.attachLink(link, "a");
  b.attachLink(link, "b");
}
