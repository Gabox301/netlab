/**
 * Host IPv4 integration: interface addressing (ip/mask/gateway), direct vs
 * gateway next hops through `sendTo`, automatic Echo Replies, and the
 * callbacks the shell uses for `ping` / `traceroute` (S5, S9).
 */

import { describe, expect, test } from "bun:test";
import { Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_CODE_FRAG_NEEDED,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  type IcmpMessage,
  type Ipv4Header,
  type Ipv4Packet,
  parseArp,
  parseEthernet,
  parseIcmp,
  parseIpv4,
  serializeIcmp,
  serializeIpv4,
} from "@netlab/protocols";
import { connect } from "../src/devices";
import { Host, type HostEchoReply, type HostIcmpError } from "../src/host";
import { Link } from "../src/link";
import { Router } from "../src/route";
import { Simulation } from "../src/sim";
import { type Trace, TraceBus } from "../src/trace";

const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";

const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const MAC_R1 = "02:00:00:00:00:01";
const MAC_R2 = "02:00:00:00:00:02";

const IP_A = "10.0.0.2";
const IP_B_SAME = "10.0.0.3";
const IP_B = "10.0.1.2";
const IP_R1_A = "10.0.0.1";
const IP_R1_B = "10.0.1.1";
const GATEWAY_LOCAL = "10.0.0.254";

function makeLink(sim: Simulation, bus: TraceBus, id: string): Link {
  return new Link(sim, id, { latencyUs: LATENCY_US }, bus);
}

function first<T>(items: Array<T>, what: string): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error(`expected ${what}`);
  }
  return item;
}

function transmitted(
  traces: Array<Trace>,
  link: string,
  from: "a" | "b",
): Array<{ t: number; frame: Uint8Array }> {
  return traces.flatMap((trace) =>
    trace.kind === "frame_tx" && trace.link === link && trace.from === from
      ? [{ t: trace.t, frame: trace.frame }]
      : [],
  );
}

function arpTargets(
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

function icmpMessages(
  traces: Array<Trace>,
  link: string,
  from: "a" | "b",
): Array<IcmpMessage> {
  const out: Array<IcmpMessage> = [];
  for (const { frame } of transmitted(traces, link, from)) {
    const eth = parseEthernet(frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_IPV4) {
      continue;
    }
    const ip = parseIpv4(eth.value.payload);
    if (!ip.ok) {
      continue;
    }
    const icmp = parseIcmp(ip.value.payload);
    if (icmp.ok) {
      out.push(icmp.value);
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

function testHeader(overrides: Partial<Ipv4Header> = {}): Ipv4Header {
  return {
    version: 4,
    ihl: 5,
    dscp: 0,
    ecn: 0,
    totalLength: 0,
    identification: 0x0101,
    flags: { reserved: false, dontFragment: false, moreFragments: false },
    fragmentOffset: 0,
    ttl: 64,
    protocol: 1,
    checksum: 0,
    src: Ipv4Address.parse(IP_A),
    dst: Ipv4Address.parse(IP_B_SAME),
    options: new Uint8Array(0),
    ...overrides,
  };
}

describe("Host IPv4 configuration (S5)", () => {
  test("accepts ip/mask/gateway in addInterface() and reports them", () => {
    const host = new Host(new Simulation(5), "h", new TraceBus());
    host.addInterface("eth0", {
      ip: IP_A,
      mask: MASK_24,
      gateway: IP_R1_A,
    });

    const config = host.getIpConfig("eth0");
    expect(config?.ip.toString()).toBe(IP_A);
    expect(config?.prefixLength).toBe(24);
    expect(config?.mask?.toString()).toBe(MASK_24);
    expect(config?.gateway?.toString()).toBe(IP_R1_A);
  });

  test("accepts CIDR in ip and updates config through setIpConfig()", () => {
    const host = new Host(new Simulation(5), "h", new TraceBus());
    host.addInterface("eth0", { ip: "10.0.0.5/24", gateway: IP_R1_A });

    expect(host.getIpConfig("eth0")?.prefixLength).toBe(24);

    // Omitted fields keep their previous values; `null` clears the gateway.
    host.setIpConfig("eth0", { ip: "10.1.0.5", mask: "255.255.255.128" });
    expect(host.getIpConfig("eth0")?.ip.toString()).toBe("10.1.0.5");
    expect(host.getIpConfig("eth0")?.prefixLength).toBe(25);
    expect(host.getIpConfig("eth0")?.gateway?.toString()).toBe(IP_R1_A);

    host.setIpConfig("eth0", { ip: "10.1.0.6/26", gateway: null });
    expect(host.getIpConfig("eth0")?.prefixLength).toBe(26);
    expect(host.getIpConfig("eth0")?.gateway).toBeUndefined();
  });

  test("rejects non-contiguous masks and conflicting prefix information", () => {
    const host = new Host(new Simulation(5), "h", new TraceBus());
    expect(() =>
      host.addInterface("eth0", { ip: IP_A, mask: "255.0.255.0" }),
    ).toThrow(/contiguous/i);

    host.addInterface("eth1", { ip: IP_A, prefixLength: 24 });
    expect(() =>
      host.setIpConfig("eth1", {
        ip: IP_A,
        mask: MASK_24,
        prefixLength: 25,
      }),
    ).toThrow(/mask|prefix/i);
    expect(() =>
      host.setIpConfig("eth1", { ip: "10.0.0.2/24", prefixLength: 24 }),
    ).toThrow(/mask|prefix/i);
  });
});

describe("Host IPv4 next hop selection", () => {
  test("same subnet ARPs the destination even when a gateway is set", () => {
    const sim = new Simulation(11);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", {
        mac: MAC_A,
        ip: IP_A,
        mask: MASK_24,
        gateway: GATEWAY_LOCAL,
      }),
      b.addInterface("eth0", {
        mac: MAC_B,
        ip: IP_B_SAME,
        mask: MASK_24,
        gateway: GATEWAY_LOCAL,
      }),
    );

    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    a.sendPing(IP_B_SAME, { size: 16 });
    sim.runAll();

    expect(replies).toHaveLength(1);
    expect(arpTargets(bus.drain(), "l0", "a")).toEqual([IP_B_SAME]);
    expect(a.arpLookup("eth0", IP_B_SAME)?.toString()).toBe(MAC_B);
    expect(a.arpLookup("eth0", GATEWAY_LOCAL)).toBeUndefined();
  });

  test("off-subnet sends ARP the gateway and keep the final IP destination", () => {
    const sim = new Simulation(13);
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

    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    a.sendPing(IP_B, { size: 8 });
    sim.runAll();

    expect(replies).toHaveLength(1);
    const traces = bus.drain();
    // A only ever ARPed its gateway, never B.
    expect(arpTargets(traces, "l1", "a")).toEqual([IP_R1_A]);
    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();
    expect(a.arpLookup("eth0", IP_R1_A)?.toString()).toBe(MAC_R1);

    // The inner IP destination stayed B: the gateway is only the L2 hop.
    const echoRequest = first(
      ipv4Txs(traces, "l1", "a").filter(
        (tx) => tx.packet.header.dst.toString() === IP_B,
      ),
      "an echo request to B on l1",
    );
    expect(echoRequest.packet.header.src.toString()).toBe(IP_A);
  });

  test("off-subnet without a gateway throws synchronously", () => {
    const sim = new Simulation(17);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
      b.addInterface("eth0", {
        mac: MAC_B,
        ip: IP_B_SAME,
        mask: MASK_24,
      }),
    );

    expect(() => a.sendPing(IP_B)).toThrow(/gateway|route/i);
    expect(() =>
      a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, new Uint8Array(4)),
    ).toThrow(/gateway|route/i);
    // Nothing left the interface and nothing was queued.
    expect(transmitted(bus.drain(), "l0", "a")).toHaveLength(0);
  });
});

describe("Host ping and ICMP callbacks", () => {
  test("answers Echo Requests automatically and exposes replies with RTT", () => {
    const sim = new Simulation(19);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", {
        mac: MAC_A,
        ip: IP_A,
        mask: MASK_24,
      }),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B_SAME, mask: MASK_24 }),
    );

    const atA: Array<HostEchoReply> = [];
    const atB: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => atA.push(reply);
    b.onEchoReply = (reply) => atB.push(reply);

    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const handle = a.sendPing(IP_B_SAME, {
      identifier: 0x1234,
      sequence: 7,
      data,
    });
    expect(handle).toMatchObject({
      iface: "eth0",
      destIp: IP_B_SAME,
      identifier: 0x1234,
      sequence: 7,
      size: 8,
      ttl: 64,
      dontFragment: false,
    });

    sim.runAll();

    expect(atB).toHaveLength(0);
    const reply = first(atA, "an echo reply at A");
    expect(reply).toMatchObject({
      iface: "eth0",
      srcIp: IP_B_SAME,
      dstIp: IP_A,
      identifier: 0x1234,
      sequence: 7,
    });
    expect(reply.data).toEqual(data);
    expect(reply.rttUs).toBeGreaterThan(0);

    // The reply seen on the wire is a real ICMP Echo Reply.
    const replies = icmpMessages(bus.drain(), "l0", "b");
    const echoReply = first(replies, "an echo reply on the wire");
    expect(echoReply.kind).toBe("echo");
    if (echoReply.kind === "echo") {
      expect(echoReply.type).toBe(ICMP_TYPE_ECHO_REPLY);
      expect(echoReply.identifier).toBe(0x1234);
      expect(echoReply.sequence).toBe(7);
      expect(echoReply.data).toEqual(data);
    }
  });

  test("sendIpv4() carries any protocol payload to onPayload", () => {
    const sim = new Simulation(23);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B_SAME, mask: MASK_24 }),
    );

    const received: Array<{ etherType: number; bytes: Uint8Array }> = [];
    b.onPayload = (_iface, etherType, bytes) => {
      received.push({ etherType, bytes });
    };

    const payload = new Uint8Array([9, 8, 7, 6]);
    a.sendIpv4(IP_B_SAME, 99, payload, { ttl: 32 });
    sim.runAll();

    const got = first(received, "a payload at B");
    expect(got.etherType).toBe(ETHERTYPE_IPV4);
    const ip = parseIpv4(got.bytes);
    expect(ip.ok).toBe(true);
    if (ip.ok) {
      expect(ip.value.header.protocol).toBe(99);
      expect(ip.value.payload).toEqual(payload);
    }
  });

  test("surfaces Time Exceeded and Frag Needed through onIcmpError", () => {
    const sim = new Simulation(29);
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
        mtu: 576,
      }),
      b.addInterface("eth0", {
        mac: MAC_B,
        ip: IP_B,
        mask: MASK_24,
        gateway: IP_R1_B,
      }),
    );

    const errors: Array<HostIcmpError> = [];
    a.onIcmpError = (error) => errors.push(error);

    a.sendPing(IP_B, { ttl: 1 });
    sim.runAll();
    const exceeded = first(errors, "a Time Exceeded");
    expect(exceeded.type).toBe(ICMP_TYPE_TIME_EXCEEDED);
    expect(exceeded.code).toBe(0);
    expect(exceeded.from).toBe(IP_R1_A);

    a.sendPing(IP_B, { size: 1000, dontFragment: true });
    sim.runAll();
    const fragNeeded = errors[1];
    if (fragNeeded === undefined) {
      throw new Error("expected a Fragmentation Needed error");
    }
    expect(fragNeeded.type).toBe(ICMP_TYPE_DEST_UNREACHABLE);
    expect(fragNeeded.code).toBe(ICMP_CODE_FRAG_NEEDED);
    expect(fragNeeded.mtu).toBe(576);
  });
});

describe("Host IPv4 contracts (S9)", () => {
  test("malformed IPv4 and ICMP never throw and never produce replies", () => {
    const sim = new Simulation(33);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B_SAME, mask: MASK_24 }),
    );

    const replies: Array<HostEchoReply> = [];
    b.onEchoReply = (reply) => replies.push(reply);
    const payloads: Array<Uint8Array> = [];
    b.onPayload = (_iface, _etherType, bytes) => payloads.push(bytes);

    const goodIcmp = serializeIcmp({
      kind: "echo",
      type: ICMP_TYPE_ECHO_REQUEST,
      code: 0,
      identifier: 1,
      sequence: 1,
      data: new Uint8Array(4),
    });
    const corruptIcmp = goodIcmp.slice();
    corruptIcmp[2] = (corruptIcmp[2] as number) ^ 0xff;
    const badIcmpDatagram = serializeIpv4(
      testHeader({
        src: Ipv4Address.parse(IP_A),
        dst: Ipv4Address.parse(IP_B_SAME),
      }),
      corruptIcmp,
    );

    expect(() => {
      a.sendRaw(
        "eth0",
        MacAddress.parse(MAC_B),
        ETHERTYPE_IPV4,
        new Uint8Array(10),
      );
      a.sendRaw(
        "eth0",
        MacAddress.parse(MAC_B),
        ETHERTYPE_IPV4,
        badIcmpDatagram,
      );
      sim.runAll();
    }).not.toThrow();

    expect(replies).toHaveLength(0);
    // Legacy hook still sees the raw payloads, exactly as before IPv4.
    expect(payloads).toHaveLength(2);
    const wire = transmitted(bus.drain(), "l0", "b");
    expect(wire).toHaveLength(0);
  });

  test("frames are not mutated after send()", () => {
    const sim = new Simulation(35);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B_SAME, mask: MASK_24 }),
    );

    const seen: Array<{ frame: Uint8Array; snapshot: Uint8Array }> = [];
    bus.subscribe((trace) => {
      if (trace.kind === "frame_tx") {
        seen.push({ frame: trace.frame, snapshot: trace.frame.slice() });
      }
    });

    a.sendPing(IP_B_SAME, { size: 32 });
    sim.runAll();

    expect(seen.length).toBeGreaterThan(0);
    for (const { frame, snapshot } of seen) {
      expect(frame).toEqual(snapshot);
    }
  });

  test("sendPing() without an IPv4 address fails like sendTo() does", () => {
    const sim = new Simulation(37);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", { mac: MAC_A }),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B_SAME, mask: MASK_24 }),
    );
    expect(() => a.sendPing(IP_B_SAME)).toThrow(/IPv4/);
    expect(() => a.sendIpv4(IP_B_SAME, 99, new Uint8Array(1))).toThrow(/IPv4/);
  });
});
