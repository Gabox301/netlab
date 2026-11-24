/**
 * Layer-2 interconnect devices: a learning switch and a repeater hub.
 *
 * The switch learns `(VLAN, source MAC) -> ingress port` from every admitted
 * frame (F-14/F-17) and ages entries out after `agingTimeUs` (default 300 s).
 * Forwarding is then: known-fresh unicast goes to that port only, everything
 * else (unknown unicast, broadcast, multicast) is flooded to the other ports
 * of the same VLAN (F-15). A frame whose destination is learned on the
 * ingress port is filtered, which is what makes a switch a switch instead of
 * a hub.
 *
 * VLANs (F-17, S1/S3) are configured per port, at creation time:
 *
 * - **access** carries one VLAN and never sees a tag. Its `vlan` defaults to
 *   {@link DEFAULT_VLAN_ID} (1), so an unconfigured switch keeps behaving
 *   exactly like the pre-VLAN one: untagged frames everywhere, one table.
 * - **trunk** carries many VLANs, tagged. `allowed` defaults to every usable
 *   VLAN; `native` is the VLAN that travels untagged and is where untagged
 *   ingress is classified. It defaults to *none*: a trunk with no native
 *   VLAN drops untagged frames instead of guessing.
 *
 * Ingress policy is strict and never throws: a VID the port does not carry is
 * counted (`rxDropped`) and logged. A tagged frame on an access port cannot be
 * classified at all, so it keeps the pre-VLAN `rxErrors` counter it used to
 * get from the strict parser.
 *
 * Egress reconstructs the frame per port (S5: received frames are never
 * mutated): access sends `serializeEthernet(...)`, trunk sends
 * `serializeTaggedEthernet(...)` with the ingress PCP/DEI and the VLAN of the
 * frame, except for the native VLAN, which leaves untagged. A second tag is
 * never interpreted: it stays in the payload (S4: no QinQ).
 *
 * A switch port is promiscuous by construction: forwarding by MAC table is
 * impossible if the interface first discards frames addressed to somebody
 * else. It still counts what it sees, and it refuses malformed frames.
 *
 * The hub is the control group: no parsing, no learning, no filtering, no
 * VLANs — every frame leaves every other port (still counted per interface).
 *
 * `getMacTable()` (F-16) returns a snapshot, never the internal map, sorted by
 * MAC (and by VLAN for the same MAC) so `show mac-table` output and tests
 * agree.
 */

import type { MacAddress } from "@netlab/bytes";
import {
  isVlanId,
  parseEthernetWithVlan,
  serializeEthernet,
  serializeTaggedEthernet,
  shouldAccept,
  VLAN_ID_MAX,
  VLAN_ID_MIN,
  type VlanAwareEthernetFrame,
} from "@netlab/protocols";
import { Device, type NetworkInterface } from "./devices";
import type { Simulation } from "./sim";
import type { TraceBus } from "./trace";

/** MAC aging time when a switch does not say otherwise: 300 s. */
export const DEFAULT_AGING_TIME_US = 300_000_000;

/** VLAN of an access port that was not configured: the default VLAN. */
export const DEFAULT_VLAN_ID = 1;

/** Port mode understood by `Switch.addPort()`: `access` implies the other. */
export type VlanPortMode = "access" | "trunk";

/** Per-port VLAN configuration accepted by `Switch.addPort()`. */
export interface VlanPortConfig {
  /** `access` (default) or `trunk`. */
  mode?: VlanPortMode;
  /** access: the VLAN this port belongs to. Default {@link DEFAULT_VLAN_ID}. */
  vlan?: number;
  /** trunk: VLANs carried on the port. Default every usable VLAN. */
  allowed?: readonly number[];
  /** trunk: VLAN that travels untagged (PVID). Default none. */
  native?: number;
}

/** One row of `getMacTable()`, safe to keep after the call. */
export interface MacTableEntry {
  mac: MacAddress;
  /** Interface name the MAC was learned on. */
  port: string;
  /** VLAN the binding belongs to: the same MAC can appear in several. */
  vlan: number;
  /** Virtual time at which this entry stops being fresh. */
  expiresAt: number;
}

/** Switch tunables. */
export interface SwitchOptions {
  /** How long a learned MAC stays fresh, in microseconds. */
  agingTimeUs?: number;
}

interface AccessPort {
  mode: "access";
  vlan: number;
}

interface TrunkPort {
  mode: "trunk";
  /** `undefined` means every usable VLAN is carried. */
  allowed: ReadonlySet<number> | undefined;
  /** `undefined` means no VLAN travels untagged. */
  native: number | undefined;
}

type ResolvedVlanPort = AccessPort | TrunkPort;

interface TableEntry {
  mac: MacAddress;
  port: string;
  vlan: number;
  expiresAt: number;
}

function requireVlanId(value: number, what: string): number {
  if (!isVlanId(value)) {
    throw new RangeError(
      `${what} must be a VLAN id in [${VLAN_ID_MIN}, ${VLAN_ID_MAX}]: ${value}`,
    );
  }
  return value;
}

function resolvePortVlan(cfg: VlanPortConfig): ResolvedVlanPort {
  const mode = cfg.mode ?? "access";
  if (mode === "access") {
    if (cfg.allowed !== undefined) {
      throw new RangeError(
        "allowed is a trunk setting; access carries one VLAN",
      );
    }
    if (cfg.native !== undefined) {
      throw new RangeError(
        "native is a trunk setting; access carries one VLAN",
      );
    }
    return {
      mode: "access",
      vlan: requireVlanId(cfg.vlan ?? DEFAULT_VLAN_ID, "access vlan"),
    };
  }
  if (mode !== "trunk") {
    throw new RangeError(`unknown switch port mode: ${String(mode)}`);
  }
  if (cfg.vlan !== undefined) {
    throw new RangeError("vlan is an access setting; use native on a trunk");
  }
  const native =
    cfg.native === undefined
      ? undefined
      : requireVlanId(cfg.native, "trunk native");
  const allowed =
    cfg.allowed === undefined
      ? undefined
      : new Set(cfg.allowed.map((vid) => requireVlanId(vid, "trunk allowed")));
  if (allowed !== undefined && allowed.size === 0) {
    throw new RangeError("trunk allowed must list at least one VLAN");
  }
  if (native !== undefined && allowed !== undefined && !allowed.has(native)) {
    throw new RangeError(
      `trunk native VLAN ${native} must also be an allowed VLAN`,
    );
  }
  return { mode: "trunk", allowed, native };
}

/** True when `cfg` carries `vid` at all (tagged or untagged). */
function carriesVlan(cfg: ResolvedVlanPort, vid: number): boolean {
  if (cfg.mode === "access") {
    return cfg.vlan === vid;
  }
  return cfg.allowed === undefined || cfg.allowed.has(vid);
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
  private readonly vlanByPort = new Map<string, ResolvedVlanPort>();

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

  /**
   * Add a promiscuous switching port.
   *
   * `vlan` is validated before the interface exists, so a bad configuration
   * leaves no half-built port behind. Omitted or empty means access VLAN 1.
   */
  addPort(
    name: string,
    mac?: string,
    vlan: VlanPortConfig = {},
  ): NetworkInterface {
    const resolved = resolvePortVlan(vlan);
    const port = this.addInterface(name, mac === undefined ? {} : { mac });
    port.promiscuous = true;
    this.vlanByPort.set(name, resolved);
    return port;
  }

  /** Fresh learned bindings, sorted by MAC then VLAN, as copies. */
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
        vlan: entry.vlan,
        expiresAt: entry.expiresAt,
      });
    }
    rows.sort((a, b) => compareMac(a.mac, b.mac) || a.vlan - b.vlan);
    return rows;
  }

  onFrame(iface: NetworkInterface, frame: Uint8Array): void {
    const portVlan = this.vlanConfig(iface.name);
    const parsed = parseEthernetWithVlan(frame);
    if (!parsed.ok) {
      iface.counters.rxErrors += 1;
      return;
    }
    const eth = parsed.value;
    if (!shouldAccept(iface.mac, eth, iface)) {
      iface.counters.rxDropped += 1;
      return;
    }
    const vid = this.classifyIngress(portVlan, eth, iface);
    if (vid === undefined) {
      return;
    }
    this.learn(vid, iface.name, eth.src);
    if (eth.dst.isMulticast()) {
      this.flood(vid, iface, eth);
      return;
    }
    const entry = this.lookup(vid, eth.dst);
    if (entry === undefined) {
      this.flood(vid, iface, eth);
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
    const egressVlan = this.vlanConfig(egress.name);
    if (!carriesVlan(egressVlan, vid)) {
      this.log(
        `port ${entry.port} does not carry VLAN ${vid}: dropping frame for ${eth.dst}`,
      );
      return;
    }
    this.transmit(egress, egressVlan, vid, eth);
  }

  /**
   * VLAN an ingress frame belongs to, or `undefined` when the port refuses
   * it. Refusals are counted and logged, never thrown (S5).
   */
  private classifyIngress(
    cfg: ResolvedVlanPort,
    eth: VlanAwareEthernetFrame,
    iface: NetworkInterface,
  ): number | undefined {
    const tag = eth.vlan;
    if (cfg.mode === "access") {
      if (tag === undefined) {
        return cfg.vlan;
      }
      // An access port carries untagged frames only, so there is nothing to
      // classify. Before VLANs this frame died in the strict parser.
      iface.counters.rxErrors += 1;
      this.log(
        `port ${iface.name} is access VLAN ${cfg.vlan}: dropping tagged frame (VID ${tag.vid})`,
      );
      return undefined;
    }
    if (tag === undefined) {
      if (cfg.native === undefined) {
        iface.counters.rxDropped += 1;
        this.log(
          `port ${iface.name} has no native VLAN: dropping untagged frame`,
        );
        return undefined;
      }
      return cfg.native;
    }
    if (!isVlanId(tag.vid)) {
      iface.counters.rxDropped += 1;
      this.log(
        `port ${iface.name} received VID ${tag.vid}, which is not a usable VLAN id: dropping frame`,
      );
      return undefined;
    }
    if (!carriesVlan(cfg, tag.vid)) {
      iface.counters.rxDropped += 1;
      this.log(
        `port ${iface.name} trunk does not allow VID ${tag.vid}: dropping frame`,
      );
      return undefined;
    }
    return tag.vid;
  }

  /** Copy the frame out of one port in the shape that port expects. */
  private transmit(
    port: NetworkInterface,
    cfg: ResolvedVlanPort,
    vid: number,
    frame: VlanAwareEthernetFrame,
  ): void {
    const header = {
      dst: frame.dst,
      src: frame.src,
      etherType: frame.etherType,
    };
    if (cfg.mode === "trunk" && vid !== cfg.native) {
      port.send(
        serializeTaggedEthernet(
          {
            ...header,
            vlan: {
              pcp: frame.vlan?.pcp ?? 0,
              dei: frame.vlan?.dei ?? 0,
              vid,
            },
          },
          frame.payload,
        ),
      );
      return;
    }
    port.send(serializeEthernet(header, frame.payload));
  }

  /** Flood one VLAN: only the other ports that carry it leave with a copy. */
  private flood(
    vid: number,
    ingress: NetworkInterface,
    frame: VlanAwareEthernetFrame,
  ): void {
    for (const port of this.interfaces) {
      if (port === ingress || !port.attached || !port.up) {
        continue;
      }
      const cfg = this.vlanConfig(port.name);
      if (!carriesVlan(cfg, vid)) {
        continue;
      }
      this.transmit(port, cfg, vid, frame);
    }
  }

  /** Port VLAN configuration, defaulting to access VLAN 1 when unknown. */
  private vlanConfig(port: string): ResolvedVlanPort {
    const cfg = this.vlanByPort.get(port);
    if (cfg !== undefined) {
      return cfg;
    }
    const fallback: ResolvedVlanPort = {
      mode: "access",
      vlan: DEFAULT_VLAN_ID,
    };
    this.vlanByPort.set(port, fallback);
    return fallback;
  }

  private learn(vid: number, port: string, mac: MacAddress): void {
    const key = `${vid}:${mac.toString()}`;
    const expiresAt = this.sim.now + this.agingTimeUs;
    const existing = this.table.get(key);
    if (existing === undefined) {
      this.table.set(key, { mac, port, vlan: vid, expiresAt });
      return;
    }
    existing.port = port;
    existing.expiresAt = expiresAt;
  }

  private lookup(vid: number, mac: MacAddress): TableEntry | undefined {
    const key = `${vid}:${mac.toString()}`;
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
