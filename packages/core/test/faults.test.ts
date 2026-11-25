/**
 * Manual fault injection at the core level (F-100): cutting a cable,
 * restarting a device and wiping the ARP cache.
 *
 * A fault is an explicit action on virtual time, never a wall-clock timer, so
 * the same seed replays the same trace sequence. Frames already in flight are
 * resolved when they arrive, which is why the "cut mid-flight" case is
 * asserted at arrival time and not at send time.
 */

import { describe, expect, test } from "bun:test";
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  parseArp,
  parseEthernet,
} from "@netlab/protocols";
import { connect } from "../src/devices";
import { Host } from "../src/host";
import { Link, type LinkParams } from "../src/link";
import { Simulation } from "../src/sim";
import { type Trace, TraceBus } from "../src/trace";

const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";
const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const IP_A = "10.0.0.2";
const IP_B = "10.0.0.3";
const LINK_ID = "l1";

interface FaultLab {
  sim: Simulation;
  bus: TraceBus;
  link: Link;
  a: Host;
  b: Host;
  /** Payloads B accepted, in arrival order. */
  atB: Array<{ iface: string; etherType: number; bytes: Uint8Array }>;
}

/** A and B on one explicit-MAC link, B recording every accepted payload. */
function lab(seed = 11, params: Partial<LinkParams> = {}): FaultLab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const link = new Link(
    sim,
    LINK_ID,
    { latencyUs: LATENCY_US, ...params },
    bus,
  );
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  connect(
    link,
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
    b.addInterface("eth0", { mac: MAC_B, ip: IP_B, mask: MASK_24 }),
  );
  const atB: FaultLab["atB"] = [];
  b.onPayload = (iface, etherType, payload) => {
    atB.push({ iface: iface.name, etherType, bytes: payload.slice() });
  };
  return { sim, bus, link, a, b, atB };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** One IPv4 payload from A to B; ARP resolves on the way when needed. */
function sendPayload(host: Host, text = "hola"): void {
  host.sendTo("eth0", IP_B, ETHERTYPE_IPV4, bytes(text));
}

function arpRequests(
  traces: ReadonlyArray<Trace>,
  from: "a" | "b" = "a",
): number {
  let count = 0;
  for (const trace of traces) {
    if (trace.kind !== "frame_tx") {
      continue;
    }
    if (trace.link !== LINK_ID || trace.from !== from) {
      continue;
    }
    const eth = parseEthernet(trace.frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_ARP) {
      continue;
    }
    const arp = parseArp(eth.value.payload);
    if (arp.ok && arp.value.oper === ARP_OP_REQUEST) {
      count += 1;
    }
  }
  return count;
}

function drops(traces: ReadonlyArray<Trace>): Array<{
  t: number;
  reason: string;
  where: string;
}> {
  return traces.flatMap((trace) =>
    trace.kind === "frame_drop"
      ? [{ t: trace.t, reason: trace.reason, where: trace.where }]
      : [],
  );
}

describe("cutting and restoring a link (F-100)", () => {
  test("a cut link drops frames with reason link_down", () => {
    const { sim, bus, link, a, atB } = lab();
    link.setUp(false);
    sendPayload(a);
    sim.runAll();

    expect(atB).toHaveLength(0);
    const dropped = drops(bus.drain());
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]).toMatchObject({
      t: 0,
      reason: "link_down",
      where: `${LINK_ID}:a>b`,
    });
  });

  test("a restored link delivers again", () => {
    const { sim, link, a, atB } = lab();
    link.setUp(false);
    sendPayload(a, "perdido");
    sim.runAll();
    expect(atB).toHaveLength(0);

    link.setUp(true);
    sendPayload(a, "llega");
    sim.runAll();

    expect(atB).toHaveLength(1);
    // The serializer pads a short frame to the 60-byte Ethernet minimum, so
    // only the crafted prefix carries the payload.
    expect(atB[0]?.bytes.subarray(0, 5)).toEqual(bytes("llega"));
    expect(atB[0]?.iface).toBe("eth0");
    expect(atB[0]?.etherType).toBe(ETHERTYPE_IPV4);
  });

  test("cutting a resolved link drops the very next frame", () => {
    const { sim, bus, link, a, atB } = lab();
    sendPayload(a, "primero");
    sim.runAll();
    expect(atB).toHaveLength(1);
    bus.drain();

    const cutAt = sim.now;
    link.setUp(false);
    sendPayload(a, "segundo");
    sim.runAll();

    expect(atB).toHaveLength(1);
    const dropped = drops(bus.drain());
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ t: cutAt, reason: "link_down" });
  });

  test("a frame already in flight is dropped at arrival", () => {
    const { sim, bus, link, a, atB } = lab();
    sendPayload(a, "primero");
    sim.runAll();
    expect(atB).toHaveLength(1);
    bus.drain();

    const sentAt = sim.now;
    sendPayload(a, "en vuelo");
    expect(atB).toHaveLength(1);

    link.setUp(false);
    sim.runAll();

    expect(atB).toHaveLength(1);
    const dropped = drops(bus.drain());
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      t: sentAt + LATENCY_US,
      reason: "link_down",
    });
  });
});

describe("ARP cache flush (F-100)", () => {
  test("flushArp() purges the cache and the next send re-resolves", () => {
    const { sim, bus, a, atB } = lab();
    sendPayload(a, "uno");
    sim.runAll();
    expect(atB).toHaveLength(1);
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);
    bus.drain();

    expect(a.flushArp("eth0")).toBe(1);
    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();

    sendPayload(a, "dos");
    sim.runAll();

    expect(atB).toHaveLength(2);
    expect(arpRequests(bus.drain())).toBe(1);
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);
  });

  test("flushArp() without an interface covers every interface", () => {
    const { sim, a } = lab();
    sendPayload(a);
    sim.runAll();
    expect(a.flushArp()).toBe(1);
    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();
  });

  test("flushArp() rejects an unknown interface", () => {
    const { a } = lab();
    expect(() => a.flushArp("eth9")).toThrow(/no interface named "eth9"/);
  });

  test("flushArp() cancels a pending resolution and its retries", () => {
    const { sim, bus, link, a } = lab();
    link.setUp(false);
    sendPayload(a, "pendiente");
    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();
    bus.drain();

    expect(a.flushArp("eth0")).toBe(1);
    sim.runAll();

    // The retry timer is gone: no request after the flush, no abandoned
    // resolution log either.
    expect(arpRequests(bus.drain())).toBe(0);
  });
});

describe("device restart (F-100)", () => {
  test("restart() clears the ARP cache and the next send re-resolves", () => {
    const { sim, bus, a, atB } = lab();
    sendPayload(a, "antes");
    sim.runAll();
    expect(atB).toHaveLength(1);
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);
    bus.drain();

    a.restart();

    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();
    expect(a.interfaces.every((iface) => iface.up)).toBe(true);

    sendPayload(a, "despues");
    sim.runAll();

    expect(atB).toHaveLength(2);
    expect(arpRequests(bus.drain())).toBe(1);
  });

  test("restart() brings a down interface back up", () => {
    const { a } = lab();
    const iface = a.getInterface("eth0");
    iface.up = false;

    a.restart();

    expect(iface.up).toBe(true);
  });

  test("restart() drops a pending resolution instead of retrying it", () => {
    const { sim, bus, link, a } = lab();
    link.setUp(false);
    sendPayload(a, "pendiente");
    bus.drain();

    a.restart();
    sim.runAll();

    expect(arpRequests(bus.drain())).toBe(0);
    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();
  });
});

describe("fault determinism", () => {
  function faultRun(seed: number): Array<string> {
    const { sim, bus, link, a } = lab(seed, {
      latencyUs: LATENCY_US,
      lossRate: 0.4,
    });
    link.setUp(false);
    sendPayload(a, "uno");
    sim.runUntil(500_000);
    link.setUp(true);
    a.flushArp();
    sendPayload(a, "dos");
    a.restart();
    sendPayload(a, "tres");
    sim.runAll();
    return bus.drain().map((trace) => {
      if (trace.kind === "frame_tx") {
        return `${trace.kind}:${trace.link}:${trace.from}:${trace.length}:${trace.t}`;
      }
      if (trace.kind === "frame_rx") {
        return `${trace.kind}:${trace.link}:${trace.to}:${trace.length}:${trace.t}`;
      }
      if (trace.kind === "frame_drop") {
        return `${trace.kind}:${trace.link}:${trace.reason}:${trace.t}`;
      }
      return `${trace.kind}:${trace.t}`;
    });
  }

  test("the same seed reproduces the same fault trace", () => {
    expect(faultRun(7)).toEqual(faultRun(7));
  });
});
