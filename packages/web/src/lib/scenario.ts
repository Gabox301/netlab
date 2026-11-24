/**
 * The fixed two-subnet lab used by the UI spike (S3): h1 -- r1 -- h2, seed
 * 11, real `@netlab/core` devices. This module is pure engine code: no DOM,
 * no SvelteKit, so both the Web Worker and a Bun smoke check can run it.
 */

import {
  connect,
  Host,
  Link,
  Router,
  Simulation,
  type Trace,
  TraceBus,
} from "@netlab/core";
import { Shell } from "@netlab/shell";
import type {
  InterfaceSnapshot,
  NeighborSnapshot,
  RouteSnapshot,
  SimResult,
  WireTrace,
} from "./sim-protocol";

export const SCENARIO = "dos-subredes";
export const SEED = 11;
export const HORIZON_US = 10_000;

const LINK_LATENCY_US = 10;
const PING_INTERVAL_US = 2_500;
const PING_COUNT = 4;
const PING_SIZE = 32;
const MASK_24 = "255.255.255.0";

const IP_H1 = "10.0.0.2";
const IP_R1_P0 = "10.0.0.1";
const IP_R1_P1 = "10.0.1.1";
const IP_H2 = "10.0.1.2";

const MAC_H1 = "02:00:00:00:00:0a";
const MAC_R1_P0 = "02:00:00:00:00:01";
const MAC_R1_P1 = "02:00:00:00:00:02";
const MAC_H2 = "02:00:00:00:00:0b";

interface Lab {
  sim: Simulation;
  bus: TraceBus;
  h1: Host;
  h2: Host;
  r1: Router;
}

/** Structural view of the public ARP lookup shared by Host and Router. */
interface ArpLookup {
  arpLookup(iface: string, ip: string): { toString(): string } | undefined;
}

function link(sim: Simulation, bus: TraceBus, id: string): Link {
  return new Link(sim, id, { latencyUs: LINK_LATENCY_US }, bus);
}

function buildLab(seed: number): Lab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const h1 = new Host(sim, "h1", bus);
  const h2 = new Host(sim, "h2", bus);
  const r1 = new Router(sim, "r1", bus);

  connect(
    link(sim, bus, "l-h1-r1"),
    h1.addInterface("eth0", {
      mac: MAC_H1,
      ip: IP_H1,
      mask: MASK_24,
      gateway: IP_R1_P0,
    }),
    r1.addPort("p0", {
      mac: MAC_R1_P0,
      ip: IP_R1_P0,
      prefixLength: 24,
    }),
  );
  connect(
    link(sim, bus, "l-r1-h2"),
    r1.addPort("p1", {
      mac: MAC_R1_P1,
      ip: IP_R1_P1,
      prefixLength: 24,
    }),
    h2.addInterface("eth0", {
      mac: MAC_H2,
      ip: IP_H2,
      mask: MASK_24,
      gateway: IP_R1_P1,
    }),
  );

  return { sim, bus, h1, h2, r1 };
}

function toHex(frame: Uint8Array): string {
  let out = "";
  for (const byte of frame) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function serializeTrace(trace: Trace): WireTrace {
  switch (trace.kind) {
    case "frame_tx":
      return {
        t: trace.t,
        kind: trace.kind,
        link: trace.link,
        from: trace.from,
        length: trace.length,
        frame: toHex(trace.frame),
      };
    case "frame_rx":
      return {
        t: trace.t,
        kind: trace.kind,
        link: trace.link,
        to: trace.to,
        length: trace.length,
        frame: toHex(trace.frame),
      };
    case "frame_drop":
      return {
        t: trace.t,
        kind: trace.kind,
        link: trace.link,
        where: trace.where,
        reason: trace.reason,
        length: trace.length,
        frame: toHex(trace.frame),
      };
    case "state":
      return {
        t: trace.t,
        kind: trace.kind,
        scope: trace.scope,
        detail: trace.detail,
      };
    case "log":
      return {
        t: trace.t,
        kind: trace.kind,
        scope: trace.scope,
        level: trace.level,
        message: trace.message,
      };
  }
}

function snapshotInterfaces(lab: Lab): InterfaceSnapshot[] {
  const rows: InterfaceSnapshot[] = [];

  for (const iface of lab.h1.interfaces) {
    const cfg = lab.h1.getIpConfig(iface.name);
    rows.push({
      device: lab.h1.id,
      deviceKind: "host",
      iface: iface.name,
      mac: iface.mac.toString(),
      ip: cfg?.ip.toString() ?? null,
      prefixLength: cfg?.prefixLength ?? null,
      gateway: cfg?.gateway?.toString() ?? null,
    });
  }

  for (const port of lab.r1.getPorts()) {
    rows.push({
      device: lab.r1.id,
      deviceKind: "router",
      iface: port.name,
      mac: lab.r1.getInterface(port.name).mac.toString(),
      ip: port.ip.toString(),
      prefixLength: port.prefixLength,
      gateway: null,
    });
  }

  for (const iface of lab.h2.interfaces) {
    const cfg = lab.h2.getIpConfig(iface.name);
    rows.push({
      device: lab.h2.id,
      deviceKind: "host",
      iface: iface.name,
      mac: iface.mac.toString(),
      ip: cfg?.ip.toString() ?? null,
      prefixLength: cfg?.prefixLength ?? null,
      gateway: cfg?.gateway?.toString() ?? null,
    });
  }

  return rows;
}

function addNeighbor(
  rows: NeighborSnapshot[],
  device: string,
  source: ArpLookup,
  iface: string,
  ip: string,
): void {
  const mac = source.arpLookup(iface, ip);
  if (mac !== undefined) {
    rows.push({ device, iface, ip, mac: mac.toString() });
  }
}

function snapshotNeighbors(lab: Lab): NeighborSnapshot[] {
  const rows: NeighborSnapshot[] = [];
  addNeighbor(rows, "h1", lab.h1, "eth0", IP_R1_P0);
  addNeighbor(rows, "r1", lab.r1, "p0", IP_H1);
  addNeighbor(rows, "r1", lab.r1, "p1", IP_H2);
  addNeighbor(rows, "h2", lab.h2, "eth0", IP_R1_P1);
  return rows;
}

function snapshotRoutes(lab: Lab): RouteSnapshot[] {
  return lab.r1.getRouteTable().map((route) => ({
    destination: route.destination.toString(),
    iface: route.iface,
    gateway: route.gateway?.toString() ?? null,
    metric: route.metric,
    kind: route.kind,
  }));
}

/**
 * Run `traceroute 10.0.1.2` from h1 on a fresh copy of the same lab. The
 * shell advances virtual time by itself; keeping it separate from the 10 ms
 * capture is what lets the packet list stay within the horizon.
 */
async function tracerouteTranscript(): Promise<string[]> {
  const lab = buildLab(SEED);
  const shell = new Shell({ host: lab.h1, sim: lab.sim });
  return shell.exec(`traceroute ${IP_H2}`);
}

/** Run the fixed scenario and return everything the workbench renders. */
export async function runScenario(): Promise<SimResult> {
  const lab = buildLab(SEED);

  for (let index = 0; index < PING_COUNT; index += 1) {
    const sequence = index;
    lab.sim.schedule(index * PING_INTERVAL_US, () => {
      lab.h1.sendPing(IP_H2, { sequence, size: PING_SIZE });
    });
  }

  const events = lab.sim.runUntil(HORIZON_US);
  const traces = lab.bus.drain().map(serializeTrace);
  const transcript = await tracerouteTranscript();

  return {
    scenario: SCENARIO,
    seed: SEED,
    horizonUs: HORIZON_US,
    simTimeUs: lab.sim.now,
    events,
    traceCount: traces.length,
    traces,
    interfaces: snapshotInterfaces(lab),
    neighbors: snapshotNeighbors(lab),
    routes: snapshotRoutes(lab),
    transcript,
  };
}
