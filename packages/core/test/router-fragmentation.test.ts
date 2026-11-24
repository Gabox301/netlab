/**
 * Router fragmentation (S2) and destination reassembly (S3): MTU-driven
 * splitting with 8-byte offsets, DF + oversized datagram -> ICMP Frag Needed,
 * and the reassembler's timeout and memory limits.
 */

import { describe, expect, test } from "bun:test";
import { Ipv4Address } from "@netlab/bytes";
import {
  ETHERTYPE_IPV4,
  ICMP_CODE_FRAG_NEEDED,
  ICMP_TYPE_DEST_UNREACHABLE,
  IPV4_MIN_HEADER_LENGTH,
  IPV4_PROTOCOL_ICMP,
  type Ipv4Header,
  type Ipv4Packet,
  parseEthernet,
  parseIpv4,
  serializeIpv4,
} from "@netlab/protocols";
import { connect } from "../src/devices";
import { Host, type HostEchoReply, type HostIcmpError } from "../src/host";
import { Link } from "../src/link";
import { isFragmented, Reassembler } from "../src/reassembly";
import { fragmentIpv4Datagram, Router } from "../src/route";
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

function first<T>(items: Array<T>, what: string): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error(`expected ${what}`);
  }
  return item;
}

interface Ipv4Tx {
  t: number;
  packet: Ipv4Packet;
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

interface FragmentedTopology {
  sim: Simulation;
  bus: TraceBus;
  router: Router;
  a: Host;
  b: Host;
}

/** A — r1(p2 MTU) — B, with B's subnet behind the small-MTU port. */
function fragmentedRouter(mtu?: number): FragmentedTopology {
  const sim = new Simulation(43);
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
    router.addPort(
      "p2",
      mtu === undefined
        ? { mac: MAC_R2, ip: IP_R1_B, prefixLength: 24 }
        : { mac: MAC_R2, ip: IP_R1_B, prefixLength: 24, mtu },
    ),
    b.addInterface("eth0", {
      mac: MAC_B,
      ip: IP_B,
      mask: MASK_24,
      gateway: IP_R1_B,
    }),
  );
  return { sim, bus, router, a, b };
}

function testHeader(overrides: Partial<Ipv4Header> = {}): Ipv4Header {
  return {
    version: 4,
    ihl: 5,
    dscp: 0,
    ecn: 0,
    totalLength: 0,
    identification: 0x4242,
    flags: { reserved: false, dontFragment: false, moreFragments: false },
    fragmentOffset: 0,
    ttl: 63,
    protocol: IPV4_PROTOCOL_ICMP,
    checksum: 0,
    src: Ipv4Address.parse("10.0.0.2"),
    dst: Ipv4Address.parse("10.0.1.2"),
    options: new Uint8Array(0),
    ...overrides,
  };
}

function parseOrThrow(bytes: Uint8Array): Ipv4Packet {
  const parsed = parseIpv4(bytes);
  if (!parsed.ok) {
    throw new Error(`fragment did not parse: ${parsed.error.message}`);
  }
  return parsed.value;
}

describe("fragmentIpv4Datagram (S2)", () => {
  test("splits at 8-byte boundaries, keeps the id and clears DF", () => {
    const payload = new Uint8Array(1008);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i & 0xff;
    }
    const before = payload.slice();

    const fragments = fragmentIpv4Datagram(testHeader(), payload, 576);
    expect(fragments).toHaveLength(2);
    expect(payload).toEqual(before);

    const parsed = fragments.map(parseOrThrow);
    const head = first(parsed, "the first fragment").header;
    expect(head.identification).toBe(0x4242);
    expect(head.flags.dontFragment).toBe(false);
    expect(head.flags.moreFragments).toBe(true);
    expect(head.fragmentOffset).toBe(0);
    expect(head.ttl).toBe(63);
    expect(head.totalLength).toBe(20 + 552);

    const tail = parsed[1];
    if (tail === undefined) {
      throw new Error("expected a second fragment");
    }
    expect(tail.header.flags.moreFragments).toBe(false);
    expect(tail.header.fragmentOffset).toBe(69);
    expect(tail.header.totalLength).toBe(20 + 456);

    // Payload bytes are untouched and concatenate back to the original.
    expect(tail.payload).toEqual(payload.slice(552));
    const joined = new Uint8Array(1008);
    joined.set(first(parsed, "the first fragment").payload);
    joined.set(tail.payload, 552);
    expect(joined).toEqual(payload);
  });

  test("returns no fragments when the MTU cannot hold header + 8 bytes", () => {
    const fragments = fragmentIpv4Datagram(
      testHeader(),
      new Uint8Array(64),
      20,
    );
    expect(fragments).toHaveLength(0);
  });
});

describe("Router MTU handling (S2, S6)", () => {
  test("fragments to the egress MTU and the destination reassembles (S3)", () => {
    const { sim, bus, a } = fragmentedRouter(576);
    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    a.sendPing(IP_B, { size: 1000 });
    sim.runAll();

    const reply = first(replies, "an echo reply after reassembly");
    expect(reply.data.length).toBe(1000);
    expect(reply.srcIp).toBe(IP_B);

    const traces = bus.drain();
    const fragments = ipv4Txs(traces, "l2", "a");
    expect(fragments).toHaveLength(2);

    const offsets = fragments.map((f) => f.packet.header.fragmentOffset);
    expect(offsets).toEqual([0, 69]);
    const more = fragments.map((f) => f.packet.header.flags.moreFragments);
    expect(more).toEqual([true, false]);
    const sizes = fragments.map((f) => f.packet.payload.length);
    expect(sizes).toEqual([552, 456]);
    const identification = first(fragments, "the first fragment").packet.header
      .identification;
    for (const fragment of fragments) {
      expect(fragment.packet.header.ttl).toBe(63);
      expect(fragment.packet.header.identification).toBe(identification);
      expect(fragment.packet.header.flags.dontFragment).toBe(false);
    }
  });

  test("default MTU 1500 splits a 2000-byte echo once", () => {
    const { sim, bus, a } = fragmentedRouter();
    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    a.sendPing(IP_B, { size: 2000 });
    sim.runAll();

    expect(first(replies, "an echo reply").data.length).toBe(2000);
    const fragments = ipv4Txs(bus.drain(), "l2", "a");
    expect(fragments).toHaveLength(2);
    expect(fragments.map((f) => f.packet.header.fragmentOffset)).toEqual([
      0, 185,
    ]);
    expect(fragments.map((f) => f.packet.payload.length)).toEqual([1480, 528]);
  });

  test("DF + oversized datagram yields Fragmentation Needed with the MTU", () => {
    const { sim, bus, a } = fragmentedRouter(576);
    const errors: Array<HostIcmpError> = [];
    a.onIcmpError = (error) => errors.push(error);

    a.sendPing(IP_B, { size: 1000, dontFragment: true });
    sim.runAll();

    const error = first(errors, "a Fragmentation Needed at A");
    expect(error.type).toBe(ICMP_TYPE_DEST_UNREACHABLE);
    expect(error.code).toBe(ICMP_CODE_FRAG_NEEDED);
    expect(error.mtu).toBe(576);
    expect(error.from).toBe(IP_R1_A);
    expect(error.originalDst).toBe(IP_B);

    // Nothing was fragmented or forwarded on the small-MTU link.
    expect(ipv4Txs(bus.drain(), "l2", "a").length).toBe(0);
  });

  test("DF at exactly the MTU passes without fragmentation", () => {
    const { sim, bus, a } = fragmentedRouter(576);
    const replies: Array<HostEchoReply> = [];
    a.onEchoReply = (reply) => replies.push(reply);

    // 20 IPv4 + 8 ICMP + 548 data = 576 bytes on the wire.
    a.sendPing(IP_B, { size: 548, dontFragment: true });
    sim.runAll();

    expect(replies.length).toBe(1);
    const forwarded = ipv4Txs(bus.drain(), "l2", "a");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.packet.header.flags.moreFragments).toBe(false);
    expect(forwarded[0]?.packet.header.fragmentOffset).toBe(0);
    expect(forwarded[0]?.packet.header.flags.dontFragment).toBe(true);
  });
});

describe("Reassembler (S3)", () => {
  interface Piece {
    offset: number;
    data: Uint8Array;
    more: boolean;
  }

  function fragmentPacket(
    piece: Piece,
    overrides: Partial<Ipv4Header> = {},
  ): Ipv4Packet {
    const bytes = serializeIpv4(
      testHeader({
        fragmentOffset: piece.offset / 8,
        flags: {
          reserved: false,
          dontFragment: false,
          moreFragments: piece.more,
        },
        ...overrides,
      }),
      piece.data,
    );
    return parseOrThrow(bytes);
  }

  function payloadOf(length: number, seed = 0): Uint8Array {
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = (seed + i) & 0xff;
    }
    return data;
  }

  test("assembles out-of-order fragments once the last one arrives", () => {
    const sim = new Simulation(1);
    const buffer = new Reassembler(sim, { timeoutUs: 1000, maxBytes: 1024 });
    const full = payloadOf(24);
    const last = fragmentPacket({
      offset: 16,
      data: full.slice(16),
      more: false,
    });
    const firstHalf = fragmentPacket({
      offset: 0,
      data: full.slice(0, 16),
      more: true,
    });

    const firstResult = buffer.add(last);
    expect(firstResult.kind).toBe("pending");
    expect(buffer.bufferedBytes).toBe(8);
    expect(buffer.pendingDatagrams).toBe(1);

    const result = buffer.add(firstHalf);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") {
      throw new Error("expected a complete packet");
    }
    expect(result.packet.payload).toEqual(full);
    expect(result.packet.header.src.toString()).toBe("10.0.0.2");
    expect(result.packet.header.dst.toString()).toBe("10.0.1.2");
    expect(result.packet.header.protocol).toBe(IPV4_PROTOCOL_ICMP);
    expect(result.packet.header.flags.moreFragments).toBe(false);
    expect(result.packet.header.fragmentOffset).toBe(0);
    expect(result.packet.header.totalLength).toBe(
      IPV4_MIN_HEADER_LENGTH + full.length,
    );
    expect(buffer.completed).toBe(1);
    expect(buffer.bufferedBytes).toBe(0);
    expect(buffer.pendingDatagrams).toBe(0);
  });

  test("passes an unfragmented packet straight through", () => {
    const buffer = new Reassembler(new Simulation(1));
    const packet = fragmentPacket({
      offset: 0,
      data: payloadOf(16),
      more: false,
    });
    expect(isFragmented(packet)).toBe(false);
    expect(buffer.add(packet).kind).toBe("complete");
    expect(buffer.completed).toBe(0);
    expect(buffer.bufferedBytes).toBe(0);
  });

  test("times out incomplete datagrams and frees their memory", () => {
    const sim = new Simulation(1);
    const expiries: Array<number> = [];
    const buffer = new Reassembler(sim, {
      timeoutUs: 1000,
      maxBytes: 1024,
      onExpire: (expiry) => expiries.push(expiry.bytes),
    });
    const full = payloadOf(24);

    buffer.add(
      fragmentPacket({ offset: 0, data: full.slice(0, 16), more: true }),
    );
    expect(buffer.bufferedBytes).toBe(16);
    expect(buffer.pendingDatagrams).toBe(1);

    sim.runUntil(1000);
    expect(buffer.pendingDatagrams).toBe(0);
    expect(buffer.bufferedBytes).toBe(0);
    expect(buffer.expired).toBe(1);
    expect(expiries).toEqual([16]);

    // The tail alone cannot complete anything after the head was purged.
    expect(
      buffer.add(
        fragmentPacket({ offset: 16, data: full.slice(16), more: false }),
      ).kind,
    ).toBe("pending");
    expect(buffer.pendingDatagrams).toBe(1);
  });

  test("enforces the memory limit and counts the rejected fragment", () => {
    const buffer = new Reassembler(new Simulation(1), {
      timeoutUs: 1000,
      maxBytes: 32,
    });
    const full = payloadOf(32);

    expect(
      buffer.add(
        fragmentPacket({ offset: 0, data: full.slice(0, 16), more: true }),
      ).kind,
    ).toBe("pending");
    expect(
      buffer.add(
        fragmentPacket(
          { offset: 0, data: payloadOf(16, 1), more: true },
          { identification: 0x7777 },
        ),
      ).kind,
    ).toBe("pending");
    expect(buffer.bufferedBytes).toBe(32);

    const rejected = buffer.add(
      fragmentPacket(
        { offset: 0, data: payloadOf(16, 2), more: true },
        { identification: 0x8888 },
      ),
    );
    expect(rejected.kind).toBe("dropped");
    if (rejected.kind === "dropped") {
      expect(rejected.reason).toBe("memory_limit");
    }
    expect(buffer.dropped).toBe(1);
    expect(buffer.bufferedBytes).toBe(32);
    expect(buffer.pendingDatagrams).toBe(2);

    buffer.clear();
    expect(buffer.bufferedBytes).toBe(0);
    expect(buffer.pendingDatagrams).toBe(0);
  });

  test("rejects conflicting last fragments for the same datagram", () => {
    const buffer = new Reassembler(new Simulation(1), {
      timeoutUs: 1000,
      maxBytes: 1024,
    });
    const full = payloadOf(24);
    buffer.add(
      fragmentPacket({ offset: 0, data: full.slice(0, 8), more: true }),
    );
    buffer.add(
      fragmentPacket({ offset: 16, data: full.slice(16), more: false }),
    );
    // Last fragment at offset 8 claims a total of 16, but 24 was already
    // declared: the whole datagram is inconsistent and gets dropped.
    const conflicted = buffer.add(
      fragmentPacket({ offset: 8, data: full.slice(8, 16), more: false }),
    );
    expect(conflicted.kind).toBe("dropped");
    if (conflicted.kind === "dropped") {
      expect(conflicted.reason).toBe("invalid");
    }
    expect(buffer.dropped).toBe(1);
    expect(buffer.bufferedBytes).toBe(0);
    expect(buffer.pendingDatagrams).toBe(0);
  });
});
