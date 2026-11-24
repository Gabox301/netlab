/**
 * Layer-2 interconnect devices: a learning switch and a repeater hub.
 *
 * The switch learns `source MAC -> ingress port` from every admitted frame
 * (F-14) and ages entries out after `agingTimeUs` (default 300 s). Forwarding
 * is then: known-fresh unicast goes to that port only, everything else
 * (unknown unicast, broadcast, multicast) is flooded to every other port
 * (F-15). A frame whose destination is learned on the ingress port is
 * filtered, which is what makes a switch a switch instead of a hub.
 *
 * A switch port is promiscuous by construction: forwarding by MAC table is
 * impossible if the interface first discards frames addressed to somebody
 * else. It still counts what it sees, and it refuses malformed frames.
 *
 * The hub is the control group: no parsing, no learning, no filtering —
 * every frame leaves every other port (still counted per interface).
 *
 * `getMacTable()` (F-16) returns a snapshot, never the internal map, sorted
 * by MAC so `show mac-table` output and tests agree.
 */

import type { MacAddress } from "@netlab/bytes";
import { parseEthernet, shouldAccept } from "@netlab/protocols";
import { Device, type NetworkInterface } from "./devices";
import type { Simulation } from "./sim";
import type { TraceBus } from "./trace";

/** MAC aging time when a switch does not say otherwise: 300 s. */
export const DEFAULT_AGING_TIME_US = 300_000_000;

/** One row of `getMacTable()`, safe to keep after the call. */
export interface MacTableEntry {
  mac: MacAddress;
  /** Interface name the MAC was learned on. */
  port: string;
  /** Virtual time at which this entry stops being fresh. */
  expiresAt: number;
}

/** Switch tunables. */
export interface SwitchOptions {
  /** How long a learned MAC stays fresh, in microseconds. */
  agingTimeUs?: number;
}

interface TableEntry {
  mac: MacAddress;
  port: string;
  expiresAt: number;
}

function compareMac(a: MacAddress, b: MacAddress): number {
  const left = a.toString();
  const right = b.toString();
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Send a frame to every usable interface except the ingress one. */
function sendToOthers(
  ports: Array<NetworkInterface>,
  ingress: NetworkInterface,
  frame: Uint8Array,
): void {
  for (const port of ports) {
    if (port === ingress || !port.attached || !port.up) {
      continue;
    }
    port.send(frame);
  }
}

export class Switch extends Device {
  private readonly agingTimeUs: number;
  private readonly table = new Map<string, TableEntry>();

  constructor(
    sim: Simulation,
    id: string,
    bus: TraceBus,
    opts: SwitchOptions = {},
  ) {
    super(sim, id, bus);
    const aging = opts.agingTimeUs ?? DEFAULT_AGING_TIME_US;
    if (!Number.isFinite(aging) || aging <= 0) {
      throw new RangeError(`agingTimeUs must be > 0: ${aging}`);
    }
    this.agingTimeUs = aging;
  }

  /** Add a promiscuous switching port. */
  addPort(name: string, mac?: string): NetworkInterface {
    const port = this.addInterface(name, mac === undefined ? {} : { mac });
    port.promiscuous = true;
    return port;
  }

  /** Fresh learned bindings, sorted by MAC, as copies. */
  getMacTable(): Array<MacTableEntry> {
    const now = this.sim.now;
    const rows: Array<MacTableEntry> = [];
    for (const [key, entry] of this.table) {
      if (entry.expiresAt <= now) {
        this.table.delete(key);
        continue;
      }
      rows.push({
        mac: entry.mac,
        port: entry.port,
        expiresAt: entry.expiresAt,
      });
    }
    rows.sort((a, b) => compareMac(a.mac, b.mac));
    return rows;
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
    this.learn(iface.name, eth.src);
    if (eth.dst.isMulticast()) {
      sendToOthers(this.interfaces, iface, frame);
      return;
    }
    const entry = this.lookup(eth.dst);
    if (entry === undefined) {
      sendToOthers(this.interfaces, iface, frame);
      return;
    }
    if (entry.port === iface.name) {
      // Destination is behind the ingress port: nothing to do.
      return;
    }
    const egress = this.interfaces.find((port) => port.name === entry.port);
    if (egress === undefined || !egress.attached) {
      this.log(`port ${entry.port} is detached: dropping frame for ${eth.dst}`);
      return;
    }
    if (!egress.up) {
      this.log(`port ${entry.port} is down: dropping frame for ${eth.dst}`);
      return;
    }
    egress.send(frame);
  }

  private learn(port: string, mac: MacAddress): void {
    const key = mac.toString();
    const expiresAt = this.sim.now + this.agingTimeUs;
    const existing = this.table.get(key);
    if (existing === undefined) {
      this.table.set(key, { mac, port, expiresAt });
      return;
    }
    existing.port = port;
    existing.expiresAt = expiresAt;
  }

  private lookup(mac: MacAddress): TableEntry | undefined {
    const key = mac.toString();
    const entry = this.table.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= this.sim.now) {
      this.table.delete(key);
      return undefined;
    }
    return entry;
  }

  private log(message: string): void {
    this.bus.emit({
      t: this.sim.now,
      kind: "log",
      scope: `${this.id}`,
      level: "warn",
      message,
    });
  }
}

/** Repeater: repeats every frame to every other port, no parsing at all. */
export class Hub extends Device {
  addPort(name: string, mac?: string): NetworkInterface {
    return this.addInterface(name, mac === undefined ? {} : { mac });
  }

  onFrame(ingress: NetworkInterface, frame: Uint8Array): void {
    sendToOthers(this.interfaces, ingress, frame);
  }
}
