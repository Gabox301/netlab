/**
 * Router: longest-prefix routing table, IPv4 forwarding with TTL and ICMP
 * errors, and the routing loop that only TTL can stop (S1, S4, S6).
 *
 * Everything runs on the real stack: ARP resolves next hops per egress
 * interface, IPv4 headers are parsed and re-serialized with a fresh
 * checksum, and ICMP errors come back as ordinary IP datagrams.
 */

import { describe, expect, test } from "bun:test";
import { Cidr, MacAddress } from "@netlab/bytes";
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_CODE_NET_UNREACHABLE,
  ICMP_CODE_TTL_EXCEEDED,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_TIME_EXCEEDED,
  type IcmpMessage,
  type Ipv4Packet,
  parseArp,
  parseEthernet,
  parseIcmp,
  parseIpv4,
  serializeEthernet,
} from "@netlab/protocols";
import { connect } from "../src/devices";
import { Host, type HostEchoReply, type HostIcmpError } from "../src/host";
import { Link } from "../src/link";
import {
  prefixFromMask,
  prefixToMask,
  Router,
  RoutingTable,
} from "../src/route";
import { Simulation } from "../src/sim";
import { type Trace, TraceBus } from "../src/trace";

const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";

const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const MAC_R1 = "02:00:00:00:00:01";
const MAC_R2 = "02:00:00:00:00:02";

const IP_A = "10.0.0.2";
const IP_B = "10.0.1.2";
const IP_R1_A = "10.0.0.1";
const IP_R1_B = "10.0.1.1";

function makeLink(sim: Simulation, bus: TraceBus, id: string): Link {
  return new Link(sim, id, { latencyUs: LATENCY_US }, bus);
}

/** First element or a loud failure: keeps strict TS happy in assertions. */
function first<T>(items: Array<T>, what: string): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error(`expected ${what}`);
  }
  return item;
}

interface WireTx {
  t: number;
  frame: Uint8Array;
}

/** Frames one station transmitted on one link. */
function transmitted(
  traces: Array<Trace>,
  link: string,
  from: "a" | "b",
): Array<WireTx> {
  const out: Array<WireTx> = [];
  for (const trace of traces) {
    if (
      trace.kind === "frame_tx" &&
      trace.link === link &&
      trace.from === from
    ) {
      out.push({ t: trace.t, frame: trace.frame });
    }
  }
  return out;
}

interface Ipv4Tx {
  t: number;
  packet: Ipv4Packet;
}

function ipv4Txs(
  traces: Array<Trace>,
  link: string,
  from: "a" | "b",
): Array<Ipv4Tx> {
  const out: Array<Ipv4Tx> = [];
  for (const { t, frame } of transmitted(traces, link, from)) {
    const eth = parseEthernet(frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_IPV4) {
      continue;
    }
    const ip = parseIpv4(eth.value.payload);
    if (ip.ok) {
      out.push({ t, packet: ip.value });
    }
  }
  return out;
}

interface IcmpTx extends Ipv4Tx {
  message: IcmpMessage;
}

function icmpTxs(
  traces: Array<Trace>,
  link: string,
  from: "a" | "b",
): Array<IcmpTx> {
  const out: Array<IcmpTx> = [];
  for (const tx of ipv4Txs(traces, link, from)) {
    const icmp = parseIcmp(tx.packet.payload);
    if (icmp.ok) {
      out.push({ ...tx, message: icmp.value });
    }
  }
  return out;
}

function arpRequestTargets(
  traces: Array<Trace>,
  link: string,
  from: "a" | "b",
): Array<string> {
  const out: Array<string> = [];
  for (const { frame } of transmitted(traces, link, from)) {
    const eth = parseEthernet(frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_ARP) {
      continue;
    }
    const arp = parseArp(eth.value.payload);
    if (arp.ok && arp.value.oper === ARP_OP_REQUEST) {
      out.push(arp.value.targetIp.toString());
    }
  }
  return out;
}

function stateDetails(traces: Array<Trace>): Array<string> {
  return traces.flatMap((trace) =>
    trace.kind === "state" ? [trace.detail] : [],
  );
}

interface TwoSubnets {
  sim: Simulation;
  bus: TraceBus;
  router: Router;
  a: Host;
  b: Host;
}

/** A(10.0.0.2/24) — r1(10.0.0.1, 10.0.1.1) — B(10.0.1.2/24). */
function twoSubnetRouter(): TwoSubnets {
  const sim = new Simulation(31);
  const bus = new TraceBus();
  const router = new Router(sim, "r1", bus);
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);

  connect(
    makeLink(sim, bus, "l1"),
    a.addInterface("eth0", {
      mac: MAC_A,
      ip: IP_A,
      mask: MASK_24,
      gateway: IP_R1_A,
    }),
    router.addPort("p1", {
      mac: MAC_R1,
      ip: IP_R1_A,
      prefixLength: 24,
    }),
  );
  connect(
    makeLink(sim, bus, "l2"),
    router.addPort("p2", {
      mac: MAC_R2,
      ip: IP_R1_B,
      prefixLength: 24,
    }),
    b.addInterface("eth0", {
      mac: MAC_B,
      ip: IP_B,
      mask: MASK_24,
      gateway: IP_R1_B,
    }),
  );
  return { sim, bus, router, a, b };
}

describe("RoutingTable (S1)", () => {
  test("longest prefix wins over shorter static and default routes", () => {
    const table = new RoutingTable();
    table.addConnected("p1", Cidr.parse("10.0.0.0/24"));
    table.addRoute({
      destination: "10.0.0.0/16",
      gateway: "10.0.0.254",
      iface: "p2",
      metric: 5,
    });
    table.addRoute({
      destination: "10.0.1.0/24",
      gateway: "10.0.1.1",
      iface: "p2",
      metric: 12,
    });
    table.addDefaultRoute("10.0.0.254", "p1", 100);

    const connected = table.lookup("10.0.0.9");
    expect(connected?.iface).toBe("p1");
    expect(connected?.destination.toString()).toBe("10.0.0.0/24");
    expect(connected?.kind).toBe("connected");
    expect(connected?.gateway).toBeUndefined();

    const shorter = table.lookup("10.0.2.9");
    expect(shorter?.destination.toString()).toBe("10.0.0.0/16");
    expect(shorter?.kind).toBe("static");

    const fallback = table.lookup("8.8.8.8");
    expect(fallback?.kind).toBe("default");
    expect(fallback?.gateway?.toString()).toBe("10.0.0.254");
    expect(fallback?.metric).toBe(100);

    expect(table.entries().map((entry) => entry.kind)).toEqual([
      "connected",
      "static",
      "static",
      "default",
    ]);
    expect(table.size).toBe(4);
  });

  test("equal prefixes prefer the lower metric, then insertion order", () => {
    const table = new RoutingTable();
    table.addRoute({
      destination: "10.5.0.0/16",
      gateway: "10.0.0.1",
      iface: "p1",
      metric: 20,
    });
    table.addRoute({
      destination: "10.5.0.0/16",
      gateway: "10.0.0.2",
      iface: "p2",
      metric: 10,
    });
    table.addRoute({
      destination: "10.5.0.0/16",
      gateway: "10.0.0.3",
      iface: "p3",
      metric: 10,
    });
    expect(table.lookup("10.5.1.1")?.iface).toBe("p2");
  });

  test("rejects bad metrics and unusable masks", () => {
    const table = new RoutingTable();
    expect(() =>
      table.addRoute({
        destination: "10.0.0.0/16",
        iface: "p1",
        metric: -1,
      }),
    ).toThrow(/metric/i);
    expect(
      table.addConnected("p1", Cidr.parse("10.0.0.0/24")).gateway,
    ).toBeUndefined();

    expect(prefixFromMask("255.255.255.0")).toBe(24);
    expect(prefixFromMask("255.255.255.252")).toBe(30);
    expect(prefixFromMask("0.0.0.0")).toBe(0);
    expect(prefixToMask(24).toString()).toBe("255.255.255.0");
    expect(() => prefixFromMask("255.0.255.0")).toThrow(/contiguous/i);
    expect(() => prefixToMask(33)).toThrow(/prefix/i);
  });
});

describe("Router forwarding (S4)", () => {
  test("delivers an echo across subnets with TTL - 1 and a valid checksum", () => {
    const { sim, bus, router, a } = twoSubnetRouter();
    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    const handle = a.sendPing(IP_B, { size: 24 });
    expect(handle.iface).toBe("eth0");
    expect(handle.destIp).toBe(IP_B);
    sim.runAll();

    const reply = first(replies, "an echo reply at A");
    expect(reply.srcIp).toBe(IP_B);
    expect(reply.dstIp).toBe(IP_A);
    expect(reply.identifier).toBe(handle.identifier);
    expect(reply.sequence).toBe(handle.sequence);
    expect(reply.data.length).toBe(24);
    expect(reply.rttUs).toBeGreaterThan(0);

    // The forwarded request on l2 has TTL 63 and revalidates end to end.
    const traces = bus.drain();
    const forward = first(ipv4Txs(traces, "l2", "a"), "a forwarded request");
    expect(forward.packet.header.src.toString()).toBe(IP_A);
    expect(forward.packet.header.dst.toString()).toBe(IP_B);
    expect(forward.packet.header.ttl).toBe(63);

    // B's reply leaves B with TTL 64; the router forwards it back at 63.
    const back = first(ipv4Txs(traces, "l2", "b"), "an echo reply on l2");
    expect(back.packet.header.src.toString()).toBe(IP_B);
    expect(back.packet.header.dst.toString()).toBe(IP_A);
    expect(back.packet.header.ttl).toBe(64);

    const forwardedBack = first(
      ipv4Txs(traces, "l1", "b"),
      "a forwarded echo reply on l1",
    );
    expect(forwardedBack.packet.header.dst.toString()).toBe(IP_A);
    expect(forwardedBack.packet.header.ttl).toBe(63);

    // Router reports its work through the trace bus.
    expect(stateDetails(traces).some((d) => /forward/.test(d))).toBe(true);

    // Header bytes on the wire verify to `internetChecksum() === 0` inside
    // parseIpv4, so landing here with a parsed packet proves the checksum.
    expect(router.getRouteTable().map((entry) => entry.kind)).toEqual([
      "connected",
      "connected",
    ]);
  });

  test("answers echo requests addressed to one of its own interfaces", () => {
    const { sim, a } = twoSubnetRouter();
    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    a.sendPing(IP_R1_A, { size: 8 });
    sim.runAll();

    const reply = first(replies, "an echo reply from the router");
    expect(reply.srcIp).toBe(IP_R1_A);
    expect(reply.dstIp).toBe(IP_A);
    expect(reply.data.length).toBe(8);
    expect(reply.rttUs).toBeGreaterThan(0);
  });

  test("TTL 1 yields ICMP Time Exceeded to the source (S4)", () => {
    const { sim, bus, a } = twoSubnetRouter();
    const errors: Array<HostIcmpError> = [];
    a.onIcmpError = (error) => errors.push(error);

    a.sendPing(IP_B, { ttl: 1 });
    sim.runAll();

    const error = first(errors, "a Time Exceeded at A");
    expect(error.type).toBe(ICMP_TYPE_TIME_EXCEEDED);
    expect(error.code).toBe(ICMP_CODE_TTL_EXCEEDED);
    expect(error.from).toBe(IP_R1_A);
    expect(error.originalDst).toBe(IP_B);
    expect(error.mtu).toBeUndefined();

    // The embedded datagram is the original echo request header.
    const embedded = parseIpv4(error.embedded);
    expect(embedded.ok).toBe(true);
    if (embedded.ok) {
      expect(embedded.value.header.dst.toString()).toBe(IP_B);
      expect(embedded.value.header.protocol).toBe(1);
    }

    // Nothing was forwarded toward B.
    expect(ipv4Txs(bus.drain(), "l2", "a").length).toBe(0);
  });

  test("no route yields ICMP Destination Unreachable", () => {
    const { sim, bus, a } = twoSubnetRouter();
    const errors: Array<HostIcmpError> = [];
    a.onIcmpError = (error) => errors.push(error);

    a.sendPing("192.0.2.9");
    sim.runAll();

    const error = first(errors, "a Destination Unreachable at A");
    expect(error.type).toBe(ICMP_TYPE_DEST_UNREACHABLE);
    expect(error.code).toBe(ICMP_CODE_NET_UNREACHABLE);
    expect(error.from).toBe(IP_R1_A);
    expect(error.originalDst).toBe("192.0.2.9");

    const traces = bus.drain();
    const wire = first(icmpTxs(traces, "l1", "b"), "an ICMP error on l1");
    expect(wire.message.kind).toBe("error");
    expect(wire.message.type).toBe(ICMP_TYPE_DEST_UNREACHABLE);
    expect(ipv4Txs(traces, "l2", "a").length).toBe(0);
  });

  test("connected /24 beats a broader static and a default route (S1)", () => {
    const { sim, bus, router, a } = twoSubnetRouter();
    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    router.addRoute({
      destination: "10.0.0.0/8",
      gateway: "10.0.1.99",
      iface: "p2",
      metric: 1,
    });
    router.addDefaultRoute("10.0.1.99", "p2", 1);

    a.sendPing(IP_B, { size: 8 });
    sim.runAll();

    expect(replies.length).toBe(1);
    // The /8 and the default would have ARPed the dead 10.0.1.99.
    expect(arpRequestTargets(bus.drain(), "l2", "a")).toEqual([IP_B]);
  });

  test("a static route forwards through a second router (S1)", () => {
    const sim = new Simulation(23);
    const bus = new TraceBus();
    const r1 = new Router(sim, "r1", bus);
    const r2 = new Router(sim, "r2", bus);
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);

    connect(
      makeLink(sim, bus, "l1"),
      a.addInterface("eth0", {
        mac: MAC_A,
        ip: IP_A,
        mask: MASK_24,
        gateway: IP_R1_A,
      }),
      r1.addPort("p1", { mac: MAC_R1, ip: IP_R1_A, prefixLength: 24 }),
    );
    connect(
      makeLink(sim, bus, "l2"),
      r1.addPort("p2", {
        mac: "02:00:00:00:00:11",
        ip: "10.9.0.1",
        prefixLength: 30,
      }),
      r2.addPort("p2", {
        mac: "02:00:00:00:00:12",
        ip: "10.9.0.2",
        prefixLength: 30,
      }),
    );
    connect(
      makeLink(sim, bus, "l3"),
      r2.addPort("p1", { mac: MAC_R2, ip: IP_R1_B, prefixLength: 24 }),
      b.addInterface("eth0", {
        mac: MAC_B,
        ip: IP_B,
        mask: MASK_24,
        gateway: IP_R1_B,
      }),
    );

    // R1 reaches B's whole subnet through R2; R2 only has the connected /24
    // and a default back toward R1 for the return path.
    r1.addRoute({
      destination: "10.0.1.0/24",
      gateway: "10.9.0.2",
      iface: "p2",
      metric: 5,
    });
    r2.addDefaultRoute("10.9.0.1", "p2");

    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);
    a.sendPing(IP_B, { size: 16 });
    sim.runAll();

    expect(replies).toHaveLength(1);
    expect(r1.lookupRoute(IP_B)?.kind).toBe("static");
    expect(r1.lookupRoute(IP_B)?.gateway?.toString()).toBe("10.9.0.2");
    expect(r1.lookupRoute(IP_B)?.metric).toBe(5);

    // Two router hops: TTL 64 -> 63 -> 62 on the last link.
    const lastHop = first(
      ipv4Txs(bus.drain(), "l3", "a"),
      "a forwarded request on l3",
    );
    expect(lastHop.packet.header.ttl).toBe(62);
    expect(lastHop.packet.header.dst.toString()).toBe(IP_B);
  });

  test("routing loop between two routers is cut by TTL (S6)", () => {
    const sim = new Simulation(37);
    const bus = new TraceBus();
    const r1 = new Router(sim, "r1", bus);
    const r2 = new Router(sim, "r2", bus);
    const a = new Host(sim, "a", bus);

    connect(
      makeLink(sim, bus, "l1"),
      a.addInterface("eth0", {
        mac: MAC_A,
        ip: IP_A,
        mask: MASK_24,
        gateway: IP_R1_A,
      }),
      r1.addPort("p1", {
        mac: MAC_R1,
        ip: IP_R1_A,
        prefixLength: 24,
      }),
    );
    connect(
      makeLink(sim, bus, "l2"),
      r1.addPort("p2", {
        mac: "02:00:00:00:00:11",
        ip: "10.9.0.1",
        prefixLength: 30,
      }),
      r2.addPort("p2", {
        mac: "02:00:00:00:00:12",
        ip: "10.9.0.2",
        prefixLength: 30,
      }),
    );
    connect(
      makeLink(sim, bus, "l3"),
      r2.addPort("p1", {
        mac: MAC_R2,
        ip: "10.8.0.1",
        prefixLength: 24,
      }),
      new Host(sim, "sink", bus).addInterface("eth0", {
        mac: "02:00:00:00:00:99",
        ip: "10.8.0.2",
        mask: MASK_24,
      }),
    );

    // Both routers send everything they do not know back to the other one.
    r1.addDefaultRoute("10.9.0.2", "p2");
    r2.addDefaultRoute("10.9.0.1", "p2");

    const errors: Array<HostIcmpError> = [];
    a.onIcmpError = (error) => errors.push(error);
    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    a.sendPing("8.8.8.8", { ttl: 3 });
    const processed = sim.runAll();
    expect(processed).toBeGreaterThan(0);
    expect(sim.pendingEvents).toBe(0);

    const error = first(errors, "a Time Exceeded from the loop");
    expect(error.type).toBe(ICMP_TYPE_TIME_EXCEEDED);
    expect(error.code).toBe(ICMP_CODE_TTL_EXCEEDED);
    expect(error.from).toBe(IP_R1_A);
    expect(error.originalDst).toBe("8.8.8.8");
    expect(replies.length).toBe(0);

    // Exactly one crossing each way on the inter-router link, TTL 2 then 1.
    const traces = bus.drain();
    const r1ToR2 = ipv4Txs(traces, "l2", "a");
    const r2ToR1 = ipv4Txs(traces, "l2", "b");
    expect(r1ToR2.length).toBe(1);
    expect(r2ToR1.length).toBe(1);
    expect(r1ToR2[0]?.packet.header.ttl).toBe(2);
    expect(r2ToR1[0]?.packet.header.ttl).toBe(1);
  });

  test("exposes ports (ip, mask, mtu) and route table snapshots", () => {
    const sim = new Simulation(3);
    const bus = new TraceBus();
    const router = new Router(sim, "r1", bus);
    router.addPort("p1", {
      mac: MAC_R1,
      ip: IP_R1_A,
      mask: MASK_24,
      mtu: 900,
    });
    router.addDefaultRoute("10.0.0.254", "p1", 10);

    const ports = router.getPorts();
    expect(ports).toHaveLength(1);
    expect(ports[0]?.name).toBe("p1");
    expect(ports[0]?.ip.toString()).toBe(IP_R1_A);
    expect(ports[0]?.prefixLength).toBe(24);
    expect(ports[0]?.mask.toString()).toBe(MASK_24);
    expect(ports[0]?.mtu).toBe(900);

    expect(router.lookupRoute("10.0.0.9")?.kind).toBe("connected");
    expect(router.lookupRoute("8.8.8.8")?.kind).toBe("default");
    expect(router.getRouteTable()).toHaveLength(2);
  });

  test("rejects a port without prefix information or with a bad MTU", () => {
    const sim = new Simulation(3);
    const bus = new TraceBus();
    const router = new Router(sim, "r1", bus);

    expect(() =>
      router.addPort("p1", { mac: MAC_R1, ip: IP_R1_A, mtu: 900 }),
    ).toThrow(/prefix|mask/i);
    expect(() =>
      router.addPort("p2", {
        mac: MAC_R2,
        ip: IP_R1_B,
        prefixLength: 24,
        mtu: 20,
      }),
    ).toThrow(/mtu/i);
    expect(() =>
      router.addRoute({
        destination: "10.0.0.0/8",
        gateway: "10.0.0.254",
        iface: "ghost",
      }),
    ).toThrow(/ghost/);
  });

  test("ignores unknown ethertypes and malformed IPv4 without throwing (S9)", () => {
    const { sim, router, a } = twoSubnetRouter();
    const p1 = router.getInterface("p1");
    const malformed = serializeEthernet(
      {
        dst: p1.mac,
        src: MacAddress.parse(MAC_A),
        etherType: ETHERTYPE_IPV4,
      },
      new Uint8Array(8),
    );
    const unknown = serializeEthernet(
      {
        dst: p1.mac,
        src: MacAddress.parse(MAC_A),
        etherType: 0x86dd,
      },
      new Uint8Array(40),
    );
    expect(() => {
      p1.receive(malformed);
      p1.receive(unknown);
      sim.runAll();
    }).not.toThrow();
    // No ARP request, no ICMP error and no forwarded frame came out of it.
    expect(a.getInterface("eth0").counters.rxFrames).toBe(0);
  });
});
