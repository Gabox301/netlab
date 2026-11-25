/**
 * TCP machine (F-54/55/56/57/58): three-way handshake, simultaneous open,
 * four-way close with TIME_WAIT expiry, RST for closed ports, a handshake
 * through a router, ordered payload transfer with cumulative ACKs, the
 * sliding window with flow control (advertised window, zero-window probing,
 * backpressure from a slow receiver), and retransmission (RTO with backoff,
 * fast retransmit on the third duplicate ACK).
 *
 * Every run is deterministic: explicit MACs, explicit ISNs and the
 * simulation clock driven by `runAll()` (no timers left) or `runUntil()`
 * (TIME_WAIT, a zero-window probe or an RTO still armed — `runAll()` would
 * spin on a persist timer that keeps re-arming while the peer window stays
 * closed, and on an RTO that keeps re-sending into a dead wire).
 */

import { describe, expect, test } from "bun:test";
import { Ipv4Address } from "@netlab/bytes";
import {
  ETHERTYPE_IPV4,
  IPV4_PROTOCOL_TCP,
  parseEthernet,
  parseIpv4,
  parseTcp,
  serializeTcp,
  type TcpFlags,
  type TcpSegment,
} from "@netlab/protocols";
import { connect } from "../src/devices";
import { Host, type HostTcpSegment } from "../src/host";
import { Link, type LinkParams } from "../src/link";
import { Router } from "../src/route";
import { Simulation } from "../src/sim";
import {
  DEFAULT_MAX_RTO_US,
  DEFAULT_MSS,
  DEFAULT_RTO_US,
  DEFAULT_SEND_WINDOW,
  DEFAULT_TIME_WAIT_US,
  TcpSocket,
  type TcpSocketOptions,
  type TcpState,
} from "../src/tcp";
import { type DropReason, type Trace, TraceBus } from "../src/trace";

const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";

const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const MAC_R1 = "02:00:00:00:00:01";
const MAC_R2 = "02:00:00:00:00:02";

const IP_A = "10.0.0.2";
const IP_B = "10.0.0.3";
const IP_B_ROUTED = "10.0.1.2";
const IP_R1_A = "10.0.0.1";
const IP_R1_B = "10.0.1.1";

const SERVER_PORT = 80;
const CLIENT_ISN = 1000;
const SERVER_ISN = 2000;

const NO_FLAGS: TcpFlags = {
  fin: false,
  syn: false,
  rst: false,
  psh: false,
  ack: false,
  urg: false,
};

interface DirectRig {
  sim: Simulation;
  bus: TraceBus;
  a: Host;
  b: Host;
}

/** A(10.0.0.2/24) — B(10.0.0.3/24) on one link. */
function directLink(seed = 41): DirectRig {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  connect(
    new Link(sim, "l0", { latencyUs: LATENCY_US }, bus),
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
    b.addInterface("eth0", { mac: MAC_B, ip: IP_B, mask: MASK_24 }),
  );
  return { sim, bus, a, b };
}

interface RoutedRig {
  sim: Simulation;
  bus: TraceBus;
  a: Host;
  b: Host;
}

/** A(10.0.0.2/24) — r1 — B(10.0.1.2/24), gateway on each side. */
function routedLink(): RoutedRig {
  const sim = new Simulation(31);
  const bus = new TraceBus();
  const router = new Router(sim, "r1", bus);
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  connect(
    new Link(sim, "l1", { latencyUs: LATENCY_US }, bus),
    a.addInterface("eth0", {
      mac: MAC_A,
      ip: "10.0.0.2",
      mask: MASK_24,
      gateway: IP_R1_A,
    }),
    router.addPort("p1", { mac: MAC_R1, ip: IP_R1_A, prefixLength: 24 }),
  );
  connect(
    new Link(sim, "l2", { latencyUs: LATENCY_US }, bus),
    router.addPort("p2", { mac: MAC_R2, ip: IP_R1_B, prefixLength: 24 }),
    b.addInterface("eth0", {
      mac: MAC_B,
      ip: IP_B_ROUTED,
      mask: MASK_24,
      gateway: IP_R1_B,
    }),
  );
  return { sim, bus, a, b };
}

/** Decode the TCP segment carried by one Ethernet frame, if any. */
function decodeTcp(frame: Uint8Array): TcpSegment | undefined {
  const eth = parseEthernet(frame);
  if (!eth.ok || eth.value.etherType !== ETHERTYPE_IPV4) {
    return undefined;
  }
  const ip = parseIpv4(eth.value.payload);
  if (!ip.ok || ip.value.header.protocol !== IPV4_PROTOCOL_TCP) {
    return undefined;
  }
  const seg = parseTcp(ip.value.payload, {
    src: ip.value.header.src,
    dst: ip.value.header.dst,
  });
  return seg.ok ? seg.value : undefined;
}

/** TCP segments `from` put on the wire, each with the time of its frame. */
function tcpFrames(
  traces: Array<Trace>,
  from: "a" | "b",
): Array<{ t: number; seg: TcpSegment }> {
  const out: Array<{ t: number; seg: TcpSegment }> = [];
  for (const trace of traces) {
    if (trace.kind !== "frame_tx" || trace.from !== from) {
      continue;
    }
    const seg = decodeTcp(trace.frame);
    if (seg !== undefined) {
      out.push({ t: trace.t, seg });
    }
  }
  return out;
}

/** TCP segments `from` put on the wire, decoded from the frame traces. */
function tcpSegments(traces: Array<Trace>, from: "a" | "b"): Array<TcpSegment> {
  return tcpFrames(traces, from).map((frame) => frame.seg);
}

/** TCP segments the link dropped for `reason`, with the time of the drop. */
function droppedTcp(
  traces: Array<Trace>,
  reason: DropReason = "loss",
): Array<{ t: number; seg: TcpSegment }> {
  const out: Array<{ t: number; seg: TcpSegment }> = [];
  for (const trace of traces) {
    if (trace.kind !== "frame_drop" || trace.reason !== reason) {
      continue;
    }
    const seg = decodeTcp(trace.frame);
    if (seg !== undefined) {
      out.push({ t: trace.t, seg });
    }
  }
  return out;
}

/**
 * Every attempt to put the payload segment starting at `seq` on the wire, in
 * order: frames the link delivered (`frame_tx`) and frames it dropped
 * (`frame_drop`, emitted instead of `frame_tx` when the drop is decided).
 */
function attemptFrames(
  traces: Array<Trace>,
  seq: number,
  from: "a" | "b" = "a",
): Array<{ t: number; seg: TcpSegment; delivered: boolean }> {
  const tag = `:${from}>`;
  const out: Array<{ t: number; seg: TcpSegment; delivered: boolean }> = [];
  for (const trace of traces) {
    if (trace.kind !== "frame_tx" && trace.kind !== "frame_drop") {
      continue;
    }
    const delivered = trace.kind === "frame_tx";
    if (delivered ? trace.from !== from : !trace.where.includes(tag)) {
      continue;
    }
    const seg = decodeTcp(trace.frame);
    if (seg !== undefined && seg.payload.length > 0 && seg.seq === seq) {
      out.push({ t: trace.t, seg, delivered });
    }
  }
  return out;
}

function connected(): {
  sim: Simulation;
  bus: TraceBus;
  client: TcpSocket;
  server: TcpSocket;
} {
  const { sim, bus, a, b } = directLink();
  const server = new TcpSocket({ host: b, sim, initialSequence: SERVER_ISN });
  const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
  server.listen(SERVER_PORT);
  client.connect(IP_B, SERVER_PORT);
  sim.runAll();
  // Drop the handshake traces: callers assert on the close traffic.
  bus.drain();
  return { sim, bus, client, server };
}

describe("tcp handshake (F-53/54/55)", () => {
  test("establishes a three-way handshake between two hosts", () => {
    const { sim, bus, a, b } = directLink();
    const server = new TcpSocket({ host: b, sim, initialSequence: SERVER_ISN });
    const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
    const serverStates: Array<TcpState> = [];
    server.onStateChange = (state) => serverStates.push(state);

    server.listen(SERVER_PORT);
    expect(server.state).toBe("LISTEN");
    client.connect(IP_B, SERVER_PORT);
    expect(client.state).toBe("SYN_SENT");

    sim.runAll();

    expect(client.state).toBe("ESTABLISHED");
    expect(server.state).toBe("ESTABLISHED");
    expect(serverStates).toEqual(["LISTEN", "SYN_RECEIVED", "ESTABLISHED"]);
    expect(server.remoteIp).toBe(IP_A);
    expect(server.remotePort).toBe(client.localPort);
    expect(client.remoteIp).toBe(IP_B);
    expect(client.remotePort).toBe(SERVER_PORT);
    // Both sides know the peer's ISN and advance their own by one.
    expect(server.irs).toBe(CLIENT_ISN);
    expect(client.irs).toBe(SERVER_ISN);
    expect(client.sndNxt).toBe(CLIENT_ISN + 1);
    expect(server.sndNxt).toBe(SERVER_ISN + 1);

    const traces = bus.drain();
    const fromClient = tcpSegments(traces, "a");
    const fromServer = tcpSegments(traces, "b");
    expect(fromClient).toHaveLength(2);
    expect(fromServer).toHaveLength(1);
    expect(fromClient[0]?.flags).toEqual({ ...NO_FLAGS, syn: true });
    expect(fromClient[0]?.seq).toBe(CLIENT_ISN);
    expect(fromClient[0]?.window).toBeGreaterThan(0);
    expect(fromServer[0]?.flags).toEqual({
      ...NO_FLAGS,
      syn: true,
      ack: true,
    });
    expect(fromServer[0]?.seq).toBe(SERVER_ISN);
    expect(fromServer[0]?.ack).toBe(CLIENT_ISN + 1);
    expect(fromClient[1]?.flags).toEqual({ ...NO_FLAGS, ack: true });
    expect(fromClient[1]?.seq).toBe(CLIENT_ISN + 1);
    expect(fromClient[1]?.ack).toBe(SERVER_ISN + 1);
  });

  test("completes a simultaneous open from SYN_SENT on both sides", () => {
    const { sim, bus, a, b } = directLink();
    const left = new TcpSocket({ host: a, sim, initialSequence: 1000 });
    const right = new TcpSocket({ host: b, sim, initialSequence: 2000 });

    left.connect(IP_B, 2001, { localPort: 2000 });
    right.connect(IP_A, 2000, { localPort: 2001 });
    expect(left.state).toBe("SYN_SENT");
    expect(right.state).toBe("SYN_SENT");

    sim.runAll();

    expect(left.state).toBe("ESTABLISHED");
    expect(right.state).toBe("ESTABLISHED");
    expect(left.remotePort).toBe(2001);
    expect(right.remotePort).toBe(2000);
    expect(left.irs).toBe(2000);
    expect(right.irs).toBe(1000);

    const traces = bus.drain();
    const synack = tcpSegments(traces, "a").find(
      (seg) => seg.flags.syn && seg.flags.ack,
    );
    expect(synack?.seq).toBe(1000);
    expect(synack?.ack).toBe(2001);
  });

  test("establishes a handshake through a router", () => {
    const { sim, a, b } = routedLink();
    const server = new TcpSocket({ host: b, sim, initialSequence: SERVER_ISN });
    const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
    server.listen(SERVER_PORT);
    client.connect(IP_B_ROUTED, SERVER_PORT);

    sim.runUntil(sim.now + 1_000);

    expect(client.state).toBe("ESTABLISHED");
    expect(server.state).toBe("ESTABLISHED");
    expect(server.irs).toBe(CLIENT_ISN);
    expect(client.irs).toBe(SERVER_ISN);
  });
});

describe("tcp close (F-55)", () => {
  test("closes in four ways and leaves the closer in TIME_WAIT", () => {
    const { sim, bus, client, server } = connected();
    expect(client.state).toBe("ESTABLISHED");

    const t0 = sim.now;
    client.close();
    expect(client.state).toBe("FIN_WAIT_1");

    // FIN reaches the server: it acknowledges and parks in CLOSE_WAIT.
    sim.runUntil(t0 + LATENCY_US + 1);
    expect(server.state).toBe("CLOSE_WAIT");

    // Its ACK reaches the client: half-closed, waiting for the peer's FIN.
    sim.runUntil(t0 + 2 * LATENCY_US + 1);
    expect(client.state).toBe("FIN_WAIT_2");

    const finAt = sim.now;
    server.close();
    expect(server.state).toBe("LAST_ACK");
    sim.runUntil(finAt + 2 * LATENCY_US + 1);
    expect(client.state).toBe("TIME_WAIT");
    expect(server.state).toBe("CLOSED");

    const traces = bus.drain();
    expect(tcpSegments(traces, "a").map((seg) => seg.flags.fin)).toEqual([
      true,
      false,
    ]);
    const fromServer = tcpSegments(traces, "b");
    expect(fromServer.map((seg) => seg.flags.fin)).toEqual([false, true]);

    // TIME_WAIT expiry is a Simulation timer: runUntil, never runAll.
    const expiry = finAt + LATENCY_US + DEFAULT_TIME_WAIT_US;
    expect(sim.pendingEvents).toBe(1);
    sim.runUntil(expiry - 1);
    expect(client.state).toBe("TIME_WAIT");
    sim.runUntil(expiry);
    expect(client.state).toBe("CLOSED");
    expect(sim.pendingEvents).toBe(0);
  });

  test("answers a SYN for a closed port with RST|ACK and aborts the socket", () => {
    const { sim, bus, a } = directLink();
    const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
    const states: Array<TcpState> = [];
    client.onStateChange = (state) => states.push(state);

    client.connect(IP_B, 9999);
    sim.runUntil(sim.now + 10 * LATENCY_US);

    expect(states).toEqual(["SYN_SENT", "CLOSED"]);
    expect(client.state).toBe("CLOSED");

    const reset = tcpSegments(bus.drain(), "b").find((seg) => seg.flags.rst);
    expect(reset?.flags).toEqual({ ...NO_FLAGS, rst: true, ack: true });
    expect(reset?.srcPort).toBe(9999);
    expect(reset?.dstPort).toBe(client.localPort);
    expect(reset?.ack).toBe(CLIENT_ISN + 1);
  });

  test("answers an unexpected non-SYN segment with a bare RST", () => {
    const { sim, bus, a } = directLink();
    const srcIp = a.routeSourceIp(IP_B);
    const stray = serializeTcp(
      {
        srcPort: 50000,
        dstPort: 8080,
        seq: 42,
        ack: 7,
        flags: { ...NO_FLAGS, ack: true },
        window: 1024,
        urgent: 0,
        payload: new Uint8Array(0),
      },
      srcIp,
      Ipv4Address.parse(IP_B),
    );

    expect(a.sendTcpSegment(IP_B, stray)).toEqual({ iface: "eth0" });
    sim.runUntil(sim.now + 4 * LATENCY_US);

    const reset = tcpSegments(bus.drain(), "b").find((seg) => seg.flags.rst);
    expect(reset?.flags).toEqual({ ...NO_FLAGS, rst: true });
    expect(reset?.srcPort).toBe(8080);
    expect(reset?.dstPort).toBe(50000);
    // RFC 793: a RST answering a segment that carried ACK takes its SEQ.
    expect(reset?.seq).toBe(7);
    expect(reset?.ack).toBe(0);
  });
});

describe("tcp host seam", () => {
  test("delivers a segment to a port bound without its own handler", () => {
    const { sim, a, b } = directLink();
    const seen: Array<HostTcpSegment> = [];
    b.onTcpSegment = (segment) => seen.push(segment);
    b.bindTcp(4242);

    const srcIp = a.routeSourceIp(IP_B);
    const bytes = serializeTcp(
      {
        srcPort: 50000,
        dstPort: 4242,
        seq: 1,
        ack: 0,
        flags: { ...NO_FLAGS, syn: true },
        window: 4096,
        urgent: 0,
        payload: new Uint8Array([5, 6]),
      },
      srcIp,
      Ipv4Address.parse(IP_B),
    );
    const handle = a.sendTcpSegment(IP_B, bytes);
    sim.runUntil(sim.now + 4 * LATENCY_US);

    expect(handle.iface).toBe("eth0");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      iface: "eth0",
      srcIp: IP_A,
      dstIp: IP_B,
      srcPort: 50000,
      dstPort: 4242,
    });
    expect(Array.from(seen[0]?.segment.payload ?? [])).toEqual([5, 6]);
  });

  test("rejects a second bind of the same port and releases on close", () => {
    const { a } = directLink();
    const socket = a.bindTcp(1234);
    expect(socket.port).toBe(1234);
    expect(() => a.bindTcp(1234)).toThrow(/already bound/i);
    socket.close();
    socket.close();
    expect(a.bindTcp(1234).port).toBe(1234);
  });
});

describe("tcp reset and abort (F-55)", () => {
  test("a received RST tears an established connection down", () => {
    const { sim, a, b } = directLink();
    const server = new TcpSocket({ host: b, sim, initialSequence: SERVER_ISN });
    const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
    server.listen(SERVER_PORT);
    client.connect(IP_B, SERVER_PORT);
    sim.runAll();
    expect(client.state).toBe("ESTABLISHED");

    const source = b.routeSourceIp(IP_A);
    const reset = serializeTcp(
      {
        srcPort: SERVER_PORT,
        dstPort: client.localPort ?? 0,
        seq: 0,
        ack: 0,
        flags: { ...NO_FLAGS, rst: true },
        window: 0,
        urgent: 0,
        payload: new Uint8Array(0),
      },
      source,
      Ipv4Address.parse(IP_A),
    );
    b.sendTcpSegment(IP_A, reset);
    sim.runUntil(sim.now + 10 * LATENCY_US);

    expect(client.state).toBe("CLOSED");
    expect(server.state).toBe("ESTABLISHED");
  });

  test("closing a listening socket stops answering for the port", () => {
    const { sim, a, b } = directLink();
    const server = new TcpSocket({ host: b, sim, initialSequence: SERVER_ISN });
    server.listen(SERVER_PORT);
    server.close();
    expect(server.state).toBe("CLOSED");

    const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
    client.connect(IP_B, SERVER_PORT);
    sim.runUntil(sim.now + 10 * LATENCY_US);
    expect(client.state).toBe("CLOSED");
    expect(server.state).toBe("CLOSED");
  });
});

/** Deterministic byte pattern: offset-dependent, so ordering errors show up. */
function patterned(length: number, salt = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (i * 31 + salt * 7 + 11) & 0xff;
  }
  return out;
}

/**
 * Inject one hand-built segment from `from`'s side of the connection, with
 * full control over SEQ and ACK (the socket API assigns them automatically).
 */
function inject(
  from: TcpSocket,
  to: TcpSocket,
  opts: {
    seq: number;
    ack: number;
    payload?: Uint8Array;
    fin?: boolean;
    syn?: boolean;
  },
): void {
  const remoteIp = from.remoteIp ?? "";
  const sourceIp = from.host.routeSourceIp(remoteIp);
  const bytes = serializeTcp(
    {
      srcPort: from.localPort ?? 0,
      dstPort: to.localPort ?? 0,
      seq: opts.seq,
      ack: opts.ack,
      flags: {
        ...NO_FLAGS,
        ack: true,
        fin: opts.fin === true,
        syn: opts.syn === true,
      },
      window: 4096,
      urgent: 0,
      payload: opts.payload ?? new Uint8Array(0),
    },
    sourceIp,
    Ipv4Address.parse(remoteIp),
  );
  from.host.sendTcpSegment(remoteIp, bytes);
}

describe("tcp buffers and cumulative ACKs (F-56)", () => {
  test("echoes a multi-segment payload byte for byte", () => {
    const { sim, bus, client, server } = connected();
    const payload = patterned(3 * DEFAULT_MSS + 17);
    const delivered: Array<Uint8Array> = [];
    server.onData = (data) => {
      delivered.push(data);
      server.send(data);
    };

    client.send(payload);
    sim.runAll();

    // The server got the whole payload, in as many segments as MSS allows.
    expect(delivered).toHaveLength(Math.ceil(payload.length / DEFAULT_MSS));
    expect(server.rcvNxt).toBe(CLIENT_ISN + 1 + payload.length);
    expect(server.read()).toEqual(payload);

    // The echo came back identical, byte by byte.
    const received = client.read();
    expect(received).toHaveLength(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      expect(received[i]).toBe(payload[i]);
    }
    expect(client.rcvNxt).toBe(SERVER_ISN + 1 + payload.length);

    // Every data segment the client sent was acknowledged cumulatively.
    const acks = tcpSegments(bus.drain(), "b").filter(
      (seg) => seg.flags.ack && !seg.flags.syn,
    );
    expect(acks.length).toBeGreaterThanOrEqual(
      Math.ceil(payload.length / DEFAULT_MSS),
    );
    expect(acks.at(-1)?.ack).toBe(CLIENT_ISN + 1 + payload.length);
  });

  test("buffers out-of-order data and delivers it in order", () => {
    const { sim, bus, client, server } = connected();
    const chunks: Array<Uint8Array> = [];
    client.onData = (data) => chunks.push(data);
    const base = (server.iss ?? 0) + 1;
    const first = patterned(DEFAULT_MSS, 1);
    const second = patterned(DEFAULT_MSS, 2);

    // The second segment arrives before the first: nothing is delivered yet.
    inject(server, client, {
      seq: base + DEFAULT_MSS,
      ack: server.sndNxt ?? 0,
      payload: second,
    });
    sim.runUntil(sim.now + 4 * LATENCY_US);
    expect(chunks).toHaveLength(0);
    expect(client.rcvNxt).toBe(base);

    // The gap is filled: both segments are delivered in sequence order.
    inject(server, client, {
      seq: base,
      ack: server.sndNxt ?? 0,
      payload: first,
    });
    sim.runUntil(sim.now + 4 * LATENCY_US);
    expect(client.rcvNxt).toBe(base + 2 * DEFAULT_MSS);
    expect(client.read()).toEqual(
      new Uint8Array([...Array.from(first), ...Array.from(second)]),
    );

    // One ACK per valid segment; the cumulative ACK jumps over the gap.
    const acks = tcpSegments(bus.drain(), "a").filter(
      (seg) => seg.flags.ack && !seg.flags.syn && !seg.flags.fin,
    );
    expect(acks.map((seg) => seg.ack)).toEqual([base, base + 2 * DEFAULT_MSS]);

    // A duplicate is re-acknowledged without being delivered twice.
    inject(server, client, {
      seq: base,
      ack: server.sndNxt ?? 0,
      payload: first,
    });
    sim.runUntil(sim.now + 4 * LATENCY_US);
    expect(client.rcvNxt).toBe(base + 2 * DEFAULT_MSS);
    expect(client.read()).toHaveLength(0);
    const duplicateAck = tcpSegments(bus.drain(), "a").filter(
      (seg) => seg.flags.ack && !seg.flags.syn && !seg.flags.fin,
    );
    expect(duplicateAck.map((seg) => seg.ack)).toEqual([
      base + 2 * DEFAULT_MSS,
    ]);
  });

  test("advances SND.UNA with valid ACKs and respects the send window", () => {
    const { sim, bus, client, server } = connected();
    const payload = patterned(6 * DEFAULT_MSS);
    const start = CLIENT_ISN + 1;

    expect(DEFAULT_SEND_WINDOW).toBe(4 * DEFAULT_MSS);
    client.send(payload);

    // Only the congestion window is in flight right after the handshake (one
    // MSS, hito 5.5); the rest waits in the send buffer.
    expect(client.cwnd).toBe(DEFAULT_MSS);
    expect(client.sndUna).toBe(start);
    expect(client.sndNxt).toBe(start + DEFAULT_MSS);
    const firstBurst = tcpSegments(bus.drain(), "a").filter(
      (seg) => seg.payload.length > 0,
    );
    expect(firstBurst).toHaveLength(1);

    // An ACK beyond SND.NXT is invalid and must leave the window untouched.
    inject(server, client, {
      seq: server.sndNxt ?? 0,
      ack: (client.sndNxt ?? 0) + 1000,
    });
    sim.runUntil(sim.now + LATENCY_US + 1);
    expect(client.sndUna).toBe(start);

    // Real ACKs open the window and the rest of the payload follows.
    sim.runAll();
    expect(server.read()).toEqual(payload);
    expect(client.sndUna).toBe(start + payload.length);
    expect(client.sndNxt).toBe(start + payload.length);
    const allData = tcpSegments(bus.drain(), "a").filter(
      (seg) => seg.payload.length > 0,
    );
    expect(firstBurst.length + allData.length).toBe(
      payload.length / DEFAULT_MSS,
    );
  });

  test("queues the FIN behind data that close() finds in flight", () => {
    const { sim, bus, client, server } = connected();
    const payload = patterned(DEFAULT_MSS + 3);

    client.send(payload);
    client.close();
    expect(client.state).toBe("FIN_WAIT_1");
    sim.runAll();

    // Every byte arrived before the FIN, and the close completed.
    expect(server.read()).toEqual(payload);
    expect(server.state).toBe("CLOSE_WAIT");
    expect(client.state).toBe("FIN_WAIT_2");
    const fromClient = tcpSegments(bus.drain(), "a");
    const data = fromClient.filter((seg) => seg.payload.length > 0);
    const fin = fromClient.find((seg) => seg.flags.fin);
    expect(data).toHaveLength(2);
    // The FIN takes the sequence number right after the last data byte.
    expect(fin?.seq).toBe(CLIENT_ISN + 1 + payload.length);
  });
});

/**
 * A(10.0.0.2) — B(10.0.0.3) with an established connection whose server holds
 * only `capacity` bytes of receive buffer, so the advertised window — not the
 * fixed 4*MSS send window — is what constrains the client.
 */
function flowRig(
  capacity: number,
  probeUs?: number,
): {
  sim: Simulation;
  bus: TraceBus;
  client: TcpSocket;
  server: TcpSocket;
} {
  const { sim, bus, a, b } = directLink();
  const server = new TcpSocket({
    host: b,
    sim,
    initialSequence: SERVER_ISN,
    receiveCapacity: capacity,
  });
  const client = new TcpSocket({
    host: a,
    sim,
    initialSequence: CLIENT_ISN,
    ...(probeUs === undefined ? {} : { zeroWindowProbeUs: probeUs }),
  });
  server.listen(SERVER_PORT);
  client.connect(IP_B, SERVER_PORT);
  sim.runAll();
  bus.drain();
  return { sim, bus, client, server };
}

/** Join the chunks drained from a receiver, in the order they were read. */
function joined(chunks: Array<Uint8Array>): Uint8Array {
  return new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk)));
}

describe("tcp sliding window and flow control (F-57)", () => {
  test("the sender never exceeds the window the receiver advertised", () => {
    const capacity = 2 * DEFAULT_MSS;
    const { sim, bus, client, server } = flowRig(capacity);
    const start = CLIENT_ISN + 1;

    // The SYN carried the receiver's window: its whole (empty) buffer.
    expect(server.rcvWnd).toBe(capacity);
    expect(client.sndWnd).toBe(capacity);

    client.send(patterned(6 * DEFAULT_MSS));

    // The congestion window opens at one MSS, so the first burst is smaller
    // than the peer's window: two MSS can fit in the buffer, four could not.
    expect(client.cwnd).toBe(DEFAULT_MSS);
    expect(client.sndNxt).toBe(start + DEFAULT_MSS);
    const firstBurst = tcpSegments(bus.drain(), "a").filter(
      (seg) => seg.payload.length > 0,
    );
    expect(firstBurst).toHaveLength(1);

    // Slow start widens cwnd, but the peer's window is what caps the flight:
    // the first ACK advertises one MSS of free buffer, so exactly one more
    // segment leaves and fills it.
    sim.runUntil(sim.now + 8 * LATENCY_US);
    expect(client.cwnd).toBeGreaterThanOrEqual(capacity);
    const burst = tcpSegments(bus.drain(), "a").filter(
      (seg) => seg.payload.length > 0,
    );
    expect(burst).toHaveLength(1);
    expect(burst[0]?.payload.length).toBe(DEFAULT_MSS);
    // Filling the peer's buffer closes it and freezes SND.NXT there.
    expect(server.rcvWnd).toBe(0);
    expect(client.sndWnd).toBe(0);
    expect(client.sndUna).toBe(start + capacity);
    expect(client.sndNxt).toBe(start + capacity);

    // A window that never reopens keeps the sender parked: no bytes leak out
    // even after many round trips.
    sim.runUntil(sim.now + 20 * LATENCY_US);
    expect(client.sndNxt).toBe(start + capacity);
  });

  test("advertises zero with a full buffer and reopens on read()", () => {
    const capacity = 2 * DEFAULT_MSS;
    const { sim, bus, client, server } = flowRig(capacity);
    const start = CLIENT_ISN + 1;

    client.send(patterned(4 * DEFAULT_MSS));
    sim.runUntil(sim.now + 8 * LATENCY_US);
    expect(server.rcvWnd).toBe(0);
    // The ACK that filled the buffer is the one that announced the zero window.
    const filled = tcpSegments(bus.drain(), "b");
    expect(filled.at(-1)?.window).toBe(0);
    expect(client.sndWnd).toBe(0);

    // Draining through read() reopens the window and announces it at once.
    expect(server.read()).toHaveLength(capacity);
    expect(server.rcvWnd).toBe(capacity);
    const update = tcpSegments(bus.drain(), "b");
    expect(update).toHaveLength(1);
    expect(update[0]?.window).toBe(capacity);
    expect(update[0]?.ack).toBe(server.rcvNxt ?? 0);
    expect(update[0]?.payload).toHaveLength(0);
    expect(update[0]?.flags.fin).toBe(false);

    // The sender learns the reopened window and sends the rest of the data,
    // which fills the buffer again and closes the window once more.
    sim.runUntil(sim.now + 8 * LATENCY_US);
    expect(client.sndNxt).toBe(start + 4 * DEFAULT_MSS);
    expect(client.sndUna).toBe(start + 4 * DEFAULT_MSS);
    expect(client.sndWnd).toBe(0);
    expect(server.rcvWnd).toBe(0);
    expect(server.read()).toHaveLength(capacity);
    expect(server.rcvNxt).toBe(start + 4 * DEFAULT_MSS);
  });

  test("never shrinks the offered window: its right edge only grows", () => {
    const capacity = 3 * DEFAULT_MSS + 111;
    const { sim, bus, client, server } = flowRig(capacity);

    client.send(patterned(3 * capacity));
    sim.runUntil(sim.now + 8 * LATENCY_US);
    const chunks: Array<Uint8Array> = [server.read()];
    sim.runUntil(sim.now + 8 * LATENCY_US);
    chunks.push(server.read());
    sim.runUntil(sim.now + 8 * LATENCY_US);
    chunks.push(server.read());
    sim.runUntil(sim.now + 8 * LATENCY_US);

    const windows = tcpSegments(bus.drain(), "b")
      .filter((seg) => !seg.flags.syn && !seg.flags.rst)
      .map((seg) => ({ ack: seg.ack, window: seg.window }));
    expect(windows.length).toBeGreaterThan(3);
    // Advertised right edge = ACK + window. A TCP must not move it left: the
    // only allowed decrease is the zero floor when the buffer is full.
    for (let i = 1; i < windows.length; i += 1) {
      const previous = windows[i - 1]?.ack ?? 0;
      const previousWindow = windows[i - 1]?.window ?? 0;
      const current = windows[i]?.ack ?? 0;
      const currentWindow = windows[i]?.window ?? 0;
      expect(current + currentWindow).toBeGreaterThanOrEqual(
        previous + previousWindow,
      );
    }
    expect(joined(chunks)).toHaveLength(3 * capacity);
  });

  test("probes a zero window and resumes when the peer reopens it", () => {
    const capacity = 2 * DEFAULT_MSS;
    const probeUs = 100;
    const { sim, bus, client, server } = flowRig(capacity, probeUs);
    const start = CLIENT_ISN + 1;
    const payload = patterned(4 * DEFAULT_MSS);

    client.send(payload);
    sim.runUntil(sim.now + 6 * LATENCY_US);
    expect(server.rcvWnd).toBe(0);
    expect(client.sndNxt).toBe(start + capacity);
    const stalled = client.sndNxt ?? 0;
    bus.drain();

    // Closed peer window: the sender probes one byte at SND.NXT, on its own
    // fixed interval, without spending sequence space.
    sim.runUntil(sim.now + 4 * probeUs);
    const probes = tcpSegments(bus.drain(), "a").filter(
      (seg) => seg.payload.length === 1,
    );
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(probes.every((seg) => seg.seq === stalled)).toBe(true);
    expect(client.sndNxt).toBe(stalled);
    expect(client.sndUna).toBe(stalled);

    // The probe is outside the zero window, so the receiver drops it and
    // re-acknowledges its closed window instead of buffering the byte.
    expect(server.rcvNxt).toBe(start + capacity);
    expect(server.rcvWnd).toBe(0);

    // Reopening the window lets the transfer resume and finish, byte for byte.
    const chunks: Array<Uint8Array> = [];
    let guard = 0;
    while ((server.rcvNxt ?? 0) !== start + payload.length && guard < 40) {
      guard += 1;
      chunks.push(server.read());
      sim.runUntil(sim.now + 10 * LATENCY_US);
    }
    chunks.push(server.read());
    expect(guard).toBeLessThan(40);
    expect(server.rcvNxt).toBe(start + payload.length);
    expect(joined(chunks)).toEqual(payload);
  });

  test("a slow receiver regulates the sender through SND.NXT", () => {
    const capacity = 2 * DEFAULT_MSS;
    const { sim, client, server } = flowRig(capacity);
    const start = CLIENT_ISN + 1;
    const payload = patterned(6 * DEFAULT_MSS);

    client.send(payload);
    // The congestion window opens at one MSS (hito 5.5), so that is the first
    // burst; the receiver's buffer becomes the constraint once it widens.
    expect(client.sndNxt).toBe(start + DEFAULT_MSS);

    // Without a reader the sender stalls once it has filled the buffer.
    sim.runUntil(sim.now + 10 * LATENCY_US);
    expect(client.sndNxt).toBe(start + capacity);
    expect(server.rcvWnd).toBe(0);

    const chunks: Array<Uint8Array> = [];
    const steps: Array<number> = [(client.sndNxt ?? 0) - start];
    for (let round = 0; round < 6; round += 1) {
      chunks.push(server.read());
      sim.runUntil(sim.now + 6 * LATENCY_US);
      // The sender may never hold more than the receiver advertised.
      expect((client.sndNxt ?? 0) - (client.sndUna ?? 0)).toBeLessThanOrEqual(
        capacity,
      );
      steps.push((client.sndNxt ?? 0) - start);
    }
    chunks.push(server.read());

    // Every read releases at most one buffer's worth of new data: the sender
    // advances in steps, driven by the receiver.
    expect(new Set(steps).size).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1] ?? 0);
      expect((steps[i] ?? 0) - (steps[i - 1] ?? 0)).toBeLessThanOrEqual(
        capacity,
      );
    }
    expect(steps.at(-1)).toBe(payload.length);
    expect(server.rcvNxt).toBe(start + payload.length);
    expect(joined(chunks)).toEqual(payload);
  });
});

/**
 * A(10.0.0.2) — B(10.0.0.3) with an established connection and a wire whose
 * loss model the test can swap mid-flight: `useLossRate(1)` is a dead wire,
 * `useLossRate(0)` a perfect one. Re-plugging only affects frames sent after
 * the call, so switching while the wire is idle gives an exact loss window.
 */
interface WireRig {
  sim: Simulation;
  bus: TraceBus;
  client: TcpSocket;
  server: TcpSocket;
  useLossRate(lossRate: number): void;
}

function wireRig(
  seed: number,
  params: Partial<LinkParams> = {},
  tcp: Partial<TcpSocketOptions> = {},
  open = true,
): WireRig {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  const left = a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 });
  const right = b.addInterface("eth0", { mac: MAC_B, ip: IP_B, mask: MASK_24 });
  let links = 0;
  const plug = (lossRate: number): void => {
    connect(
      new Link(sim, `w${links++}`, { latencyUs: LATENCY_US, lossRate }, bus),
      left,
      right,
    );
  };
  plug(params.lossRate ?? 0);
  // Both sockets trace their congestion state on the same bus as the wire, so
  // a test can read the cwnd sawtooth the UI would plot.
  const server = new TcpSocket({
    host: b,
    sim,
    bus,
    initialSequence: SERVER_ISN,
    ...tcp,
  });
  const client = new TcpSocket({
    host: a,
    sim,
    bus,
    initialSequence: CLIENT_ISN,
    ...tcp,
  });
  server.listen(SERVER_PORT);
  if (open) {
    client.connect(IP_B, SERVER_PORT);
    sim.runAll();
  }
  // Callers assert on post-handshake traffic only: those traces are drained.
  bus.drain();
  return { sim, bus, client, server, useLossRate: plug };
}

describe("tcp retransmission: RTO and fast retransmit (F-58)", () => {
  const START = CLIENT_ISN + 1;

  /**
   * Deterministic search for the scenario the RTO test needs: exactly one data
   * frame is lost, it is not the first one (so it leaves a hole with segments
   * behind it) and it is repaired one full timeout later, i.e. fewer than
   * three duplicate ACKs reached the sender so no fast retransmit fired. The
   * link's `lossRate` decides every drop from the seeded PRNG, so the search
   * always lands on the same seed.
   */
  function seedWithOneLostIntermediateSegment(): number {
    for (let seed = 1; seed <= 1000; seed += 1) {
      const { sim, bus, client } = wireRig(seed, { lossRate: 0.1 });
      if (client.state !== "ESTABLISHED") {
        continue;
      }
      client.send(patterned(6 * DEFAULT_MSS));
      sim.runAll();
      const traces = bus.drain();
      const lost = droppedTcp(traces).filter(
        (frame) => frame.seg.payload.length > 0,
      );
      if (lost.length !== 1) {
        continue;
      }
      const seq = lost[0]?.seg.seq ?? START;
      if (seq === START) {
        continue;
      }
      const attempts = attemptFrames(traces, seq);
      const firstAt = attempts[0]?.t ?? 0;
      if (attempts.length !== 2) {
        continue;
      }
      if ((attempts[1]?.t ?? 0) < firstAt + DEFAULT_RTO_US) {
        continue;
      }
      return seed;
    }
    throw new Error("no seed dropped one intermediate segment on the RTO");
  }

  test("recovers a lost intermediate segment through the RTO", () => {
    const seed = seedWithOneLostIntermediateSegment();
    const { sim, bus, client, server } = wireRig(seed, { lossRate: 0.1 });
    const payload = patterned(6 * DEFAULT_MSS);
    const delivered: Array<Uint8Array> = [];
    server.onData = (data) => delivered.push(data);

    client.send(payload);
    const sentAt = sim.now;
    expect(client.sndUna).toBe(START);
    // One MSS opens the flight (hito 5.5): the rest follows the ACKs.
    expect(client.sndNxt).toBe(START + DEFAULT_MSS);
    sim.runAll();

    const traces = bus.drain();
    const lost = droppedTcp(traces).filter(
      (frame) => frame.seg.payload.length > 0,
    );
    expect(lost).toHaveLength(1);
    const dropped = lost[0];
    const droppedSeq = dropped?.seg.seq ?? START;
    expect(droppedSeq).toBeGreaterThan(START);

    // Fewer than three duplicate ACKs can reach the sender behind that hole,
    // so the recovery is the RTO: the lost bytes go out again one timeout
    // later (base value, no backoff yet) and never before it.
    const attempts = attemptFrames(traces, droppedSeq);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.delivered).toBe(false);
    expect(attempts[1]?.delivered).toBe(true);
    expect(attempts[1]?.t).toBeGreaterThanOrEqual(
      (attempts[0]?.t ?? 0) + DEFAULT_RTO_US,
    );
    expect(attempts[1]?.t).toBeLessThanOrEqual(sentAt + 2 * DEFAULT_RTO_US);
    expect(Array.from(attempts[1]?.seg.payload ?? [])).toEqual(
      Array.from(dropped?.seg.payload ?? []),
    );

    // The retransmission fills the hole: every byte arrives, in order, and the
    // sender's window drains back to SND.UNA === SND.NXT.
    expect(joined(delivered)).toEqual(payload);
    expect(server.read()).toEqual(payload);
    expect(server.rcvNxt).toBe(START + payload.length);
    expect(client.sndUna).toBe(START + payload.length);
    expect(client.sndNxt).toBe(START + payload.length);
    expect(client.state).toBe("ESTABLISHED");
  });

  test("fast retransmits on the third duplicate ACK, before the RTO", () => {
    const { sim, bus, client, server, useLossRate } = wireRig(7);

    // Dead wire: the burst never reaches the peer, so nothing acknowledges it
    // and the RTO clock keeps running while the window stays stalled.
    useLossRate(1);
    const payload = patterned(2 * DEFAULT_MSS);
    client.send(payload);
    const sentAt = sim.now;
    const original = attemptFrames(bus.drain(), START);
    expect(original).toHaveLength(1);
    expect(original[0]?.delivered).toBe(false);
    expect(original[0]?.t).toBe(sentAt);
    const firstBytes = Array.from(original[0]?.seg.payload ?? []);
    expect(firstBytes).toEqual(Array.from(payload.subarray(0, DEFAULT_MSS)));
    expect(client.sndUna).toBe(START);
    // One MSS leaves: that is the whole congestion window right now, and the
    // second segment waits in the send buffer.
    expect(client.sndNxt).toBe(START + DEFAULT_MSS);

    // Restore the wire so the hand-built duplicate ACKs reach the client.
    useLossRate(0);
    const dupAck = (): number => {
      inject(server, client, { seq: server.sndNxt ?? 0, ack: START });
      const arrivesAt = sim.now + LATENCY_US;
      sim.runUntil(arrivesAt);
      return arrivesAt;
    };

    dupAck();
    dupAck();
    // Two duplicates are not enough: nothing is resent and no timeout fired.
    expect(attemptFrames(bus.drain(), START)).toHaveLength(0);
    expect(client.rtoUs).toBe(DEFAULT_RTO_US);
    expect(client.sndUna).toBe(START);

    const thirdAckArrivesAt = dupAck();
    const traces = bus.drain();
    const resent = attemptFrames(traces, START);
    expect(resent).toHaveLength(1);
    expect(resent[0]?.delivered).toBe(true);
    // Immediate: the resend leaves in the very event that carried the third
    // duplicate ACK, a full RTO before the timer would have gone off.
    expect(resent[0]?.t).toBe(thirdAckArrivesAt);
    expect(resent[0]?.t).toBeLessThan(sentAt + DEFAULT_RTO_US);
    // Identical bytes: same sequence number, same payload copy.
    expect(Array.from(resent[0]?.seg.payload ?? [])).toEqual(firstBytes);
    // Reno fast recovery, not Tahoe: the window halves into the inflated one
    // and the RTO is left at its base value (no timeout was needed).
    expect(client.fastRecovery).toBe(true);
    expect(client.ssthresh).toBe(2 * DEFAULT_MSS);
    expect(client.cwnd).toBe(client.ssthresh + 3 * DEFAULT_MSS);
    expect(client.rtoUs).toBe(DEFAULT_RTO_US);

    // The peer fills the hole: the ACK of the resend ends recovery and the
    // queued second segment follows.
    sim.runAll();
    expect(client.fastRecovery).toBe(false);
    expect(client.sndUna).toBe(START + 2 * DEFAULT_MSS);
    expect(server.rcvNxt).toBe(START + 2 * DEFAULT_MSS);
    expect(server.read()).toEqual(patterned(2 * DEFAULT_MSS));
  });

  test("doubles the RTO on consecutive timeouts and resets it on an ACK", () => {
    const { sim, bus, client, server, useLossRate } = wireRig(11);
    const rto = DEFAULT_RTO_US;
    const payload = patterned(DEFAULT_MSS);

    // Dead wire: the retransmissions are lost too, so only the backoff can
    // stretch the intervals between attempts.
    useLossRate(1);
    client.send(payload);
    const sentAt = sim.now;

    sim.runUntil(sentAt + 3 * rto + 1);
    expect(attemptFrames(bus.drain(), START).map((frame) => frame.t)).toEqual([
      sentAt,
      sentAt + rto,
      sentAt + 3 * rto,
    ]);
    expect(client.rtoUs).toBe(4 * rto);

    // A live wire again: the fourth attempt gets through, and the ACK that
    // advances SND.UNA puts the timer back at its base value.
    useLossRate(0);
    sim.runUntil(sentAt + 7 * rto + 4 * LATENCY_US);
    const attempts = attemptFrames(bus.drain(), START);
    expect(attempts.map((frame) => frame.t)).toEqual([sentAt + 7 * rto]);
    expect(attempts[0]?.delivered).toBe(true);
    expect(client.rtoUs).toBe(rto);
    expect(client.sndUna).toBe(START + DEFAULT_MSS);
    expect(server.read()).toEqual(payload);
  });

  test("caps the backoff at maxRtoUs", () => {
    const { sim, bus, client, useLossRate } = wireRig(
      5,
      {},
      { rtoUs: 1_000, maxRtoUs: 3_000 },
    );

    useLossRate(1);
    client.send(patterned(DEFAULT_MSS));
    const sentAt = sim.now;
    sim.runUntil(sentAt + 20_000);

    expect(attemptFrames(bus.drain(), START).map((frame) => frame.t)).toEqual([
      sentAt,
      sentAt + 1_000,
      sentAt + 3_000,
      sentAt + 6_000,
      sentAt + 9_000,
      sentAt + 12_000,
      sentAt + 15_000,
      sentAt + 18_000,
    ]);
    expect(client.rtoUs).toBe(3_000);
    // The shipped default is a ceiling above the base, never below it.
    expect(DEFAULT_MAX_RTO_US).toBeGreaterThan(DEFAULT_RTO_US);
  });

  test("delivers every byte under random loss, seed by seed", () => {
    let lost = 0;
    for (const seed of [3, 17, 29, 43]) {
      const { sim, bus, client, server } = wireRig(seed, { lossRate: 0.05 });
      const payload = patterned(8 * DEFAULT_MSS, seed);
      const delivered: Array<Uint8Array> = [];
      server.onData = (data) => delivered.push(data);

      client.send(payload);
      sim.runAll();
      lost += droppedTcp(bus.drain()).length;

      expect(client.sndUna).toBe(START + payload.length);
      expect(client.sndNxt).toBe(START + payload.length);
      expect(server.rcvNxt).toBe(START + payload.length);
      expect(joined(delivered)).toEqual(payload);
      expect(server.read()).toEqual(payload);
      // Every transfer finished with the clock back at its base value.
      expect(client.rtoUs).toBe(DEFAULT_RTO_US);
    }
    // The runs above really did lose frames, so the integrity check means it.
    expect(lost).toBeGreaterThan(0);
  });
});

describe("tcp retransmission of control segments (F-58)", () => {
  test("resends a lost SYN+ACK and a lost FIN on their own RTO", () => {
    const { sim, bus, client, server, useLossRate } = wireRig(
      19,
      {},
      {},
      false,
    );
    const openedAt = sim.now;

    // The SYN has to resolve ARP first, so it goes out on a good wire — but the
    // wire dies as it leaves, which loses the SYN+ACK it provokes. A listener
    // on the trace bus is the seam: the frame is already scheduled when it
    // fires, so only later sends see the dead wire.
    const stop = bus.subscribe((trace) => {
      if (trace.kind !== "frame_tx" || trace.from !== "a") {
        return;
      }
      if (decodeTcp(trace.frame)?.flags.syn !== true) {
        return;
      }
      useLossRate(1);
      stop();
    });
    client.connect(IP_B, SERVER_PORT);
    expect(client.state).toBe("SYN_SENT");

    sim.runUntil(openedAt + 4 * LATENCY_US);
    expect(client.state).toBe("SYN_SENT");
    expect(server.state).toBe("SYN_RECEIVED");
    const lostSynAck = droppedTcp(bus.drain());
    expect(lostSynAck).toHaveLength(1);
    expect(lostSynAck[0]?.seg.flags.syn).toBe(true);
    expect(lostSynAck[0]?.seg.flags.ack).toBe(true);
    const synAckAt = lostSynAck[0]?.t ?? 0;

    // The server's RTO resends it, and the handshake completes on the retry.
    useLossRate(0);
    sim.runUntil(synAckAt + DEFAULT_RTO_US + 4 * LATENCY_US);
    const synAcks = tcpFrames(bus.drain(), "b").filter(
      (frame) => frame.seg.flags.syn,
    );
    expect(synAcks.map((frame) => frame.t)).toEqual([
      synAckAt + DEFAULT_RTO_US,
    ]);
    expect(synAcks[0]?.seg.seq).toBe(SERVER_ISN);
    expect(client.state).toBe("ESTABLISHED");
    expect(server.state).toBe("ESTABLISHED");

    // Same for the FIN: it spends sequence space like data, so it is kept and
    // resent when the wire eats it.
    useLossRate(1);
    const finAt = sim.now;
    client.close();
    expect(client.state).toBe("FIN_WAIT_1");
    sim.runUntil(finAt + LATENCY_US);
    const lostFin = droppedTcp(bus.drain());
    expect(lostFin).toHaveLength(1);
    expect(lostFin[0]?.seg.flags.fin).toBe(true);

    useLossRate(0);
    sim.runUntil(finAt + DEFAULT_RTO_US + 4 * LATENCY_US);
    const fins = tcpFrames(bus.drain(), "a").filter(
      (frame) => frame.seg.flags.fin,
    );
    expect(fins.map((frame) => frame.t)).toEqual([finAt + DEFAULT_RTO_US]);
    expect(fins[0]?.seg.seq).toBe(CLIENT_ISN + 1);
    expect(server.state).toBe("CLOSE_WAIT");
    expect(client.state).toBe("FIN_WAIT_2");
  });

  test("re-acknowledges a SYN+ACK the peer resent after a lost ACK", () => {
    const { sim, bus, client, server } = wireRig(23);

    // The peer is still in SYN_RECEIVED, so its RTO re-sends the SYN+ACK: the
    // duplicate is answered with the ACK that completes the open.
    inject(server, client, { seq: SERVER_ISN, ack: CLIENT_ISN + 1, syn: true });
    sim.runUntil(sim.now + LATENCY_US);

    const acks = tcpFrames(bus.drain(), "a");
    expect(acks).toHaveLength(1);
    expect(acks[0]?.seg.flags.syn).toBe(false);
    expect(acks[0]?.seg.ack).toBe(SERVER_ISN + 1);
    expect(acks[0]?.seg.payload).toHaveLength(0);
    expect(client.state).toBe("ESTABLISHED");
    expect(client.rcvNxt).toBe(SERVER_ISN + 1);
  });
});

/**
 * Congestion state of one socket, sampled the instant it pushes a `state()`
 * record to the bus. This is the same stream the UI/CLI reads to plot the
 * cwnd sawtooth, so the tests pin both the numbers and the event names.
 */
interface CongestionEvent {
  t: number;
  event: string;
  cwnd: number;
  ssthresh: number;
  detail: string;
}

function recordCongestion(
  bus: TraceBus,
  socket: TcpSocket,
): Array<CongestionEvent> {
  const prefix = `${socket.host.id}:tcp`;
  const events: Array<CongestionEvent> = [];
  bus.subscribe((trace) => {
    if (trace.kind !== "state" || !trace.scope.startsWith(prefix)) {
      return;
    }
    const [event = ""] = trace.detail.split(" ");
    events.push({
      t: trace.t,
      event,
      cwnd: socket.cwnd,
      ssthresh: socket.ssthresh,
      detail: trace.detail,
    });
  });
  return events;
}

describe("tcp congestion control: Reno (F-59)", () => {
  const RTT_US = 2 * LATENCY_US;
  const MSS = DEFAULT_MSS;

  test("slow start doubles cwnd per round trip up to the configured top", () => {
    // The configuration top is well above what the payload needs, so slow
    // start is the only thing shaping the window for four round trips.
    const ceiling = 32 * MSS;
    const { sim, bus, client, server } = wireRig(
      23,
      {},
      { sendWindow: ceiling },
      false,
    );
    const events = recordCongestion(bus, client);
    const start = CLIENT_ISN + 1;
    const payload = patterned(16 * MSS);
    const chunks: Array<Uint8Array> = [];

    // A fresh connection opens at one MSS; the threshold starts at the top.
    client.connect(IP_B, SERVER_PORT);
    sim.runAll();
    expect(client.state).toBe("ESTABLISHED");
    expect(events.map((event) => event.event)).toEqual(["open"]);
    expect(client.cwnd).toBe(MSS);
    expect(client.ssthresh).toBe(ceiling);

    client.send(payload);
    const t0 = sim.now;
    // One MSS of flight, not the 4 MSS of hito 5.3: cwnd is the binding cap.
    expect(client.sndUna).toBe(start);
    expect(client.sndNxt).toBe(start + MSS);

    const rounds: Array<number> = [];
    for (let round = 1; round <= 4; round += 1) {
      sim.runUntil(t0 + round * RTT_US);
      rounds.push(client.cwnd);
      // Every round trip doubles the window, and the flight fits inside it.
      expect((client.sndNxt ?? 0) - (client.sndUna ?? 0)).toBeLessThanOrEqual(
        Math.floor(client.cwnd),
      );
      // Draining keeps the receiver window out of the way: the peer is not
      // the constraint here.
      chunks.push(server.read());
    }
    expect(rounds).toEqual([2, 4, 8, 16].map((count) => count * MSS));
    // Slow start the whole way: the threshold never moved.
    expect(client.ssthresh).toBe(ceiling);
    expect(events.slice(1).every((event) => event.event === "slow_start")).toBe(
      true,
    );
    expect(events[0]?.event).toBe("open");
    expect(events[0]?.cwnd).toBe(MSS);
    // The trace carries the graph-ready numbers the getters expose.
    for (const event of events) {
      expect(event.detail).toContain(`cwnd=${Math.round(event.cwnd)}`);
      expect(event.detail).toContain(`ssthresh=${Math.round(event.ssthresh)}`);
    }

    sim.runAll();
    chunks.push(server.read());
    expect(joined(chunks)).toEqual(payload);
    expect(client.sndUna).toBe(start + payload.length);
    expect(client.sndNxt).toBe(start + payload.length);
  });

  test("switches to additive increase once cwnd reaches ssthresh", () => {
    // The default send window (4 MSS) is also the configured top, so slow
    // start stops there and the growth flattens out.
    const { sim, bus, client, server } = wireRig(29);
    const events = recordCongestion(bus, client);
    const ceiling = DEFAULT_SEND_WINDOW;
    const payload = patterned(40 * MSS);

    client.send(payload);
    const t0 = sim.now;
    expect(client.ssthresh).toBe(ceiling);

    const slowStart: Array<number> = [];
    for (let round = 1; round <= 2; round += 1) {
      sim.runUntil(t0 + round * RTT_US);
      slowStart.push(client.cwnd);
      server.read();
    }
    expect(slowStart).toEqual([2 * MSS, ceiling]);

    // From ssthresh on, one round trip buys about one MSS (AIMD's additive
    // part), never the doubling slow start would produce.
    const steps: Array<number> = [];
    let previous = client.cwnd;
    for (let round = 3; round <= 7; round += 1) {
      sim.runUntil(t0 + round * RTT_US);
      steps.push(client.cwnd - previous);
      previous = client.cwnd;
      server.read();
    }
    expect(steps).toHaveLength(5);
    expect(
      steps.every((step) => step > 0 && step <= 1.5 * MSS),
      `steps ${steps.join(",")}`,
    ).toBe(true);

    const phases = new Set(events.map((event) => event.event));
    expect(phases.has("slow_start")).toBe(true);
    expect(phases.has("congestion_avoidance")).toBe(true);
  });

  test("halves ssthresh and restarts slow start from one MSS on an RTO", () => {
    const ceiling = 32 * MSS;
    const { sim, bus, client, server, useLossRate } = wireRig(
      13,
      {},
      { sendWindow: ceiling },
    );
    const events = recordCongestion(bus, client);
    const payload = patterned(32 * MSS);
    const rto = DEFAULT_RTO_US;

    client.send(payload);
    const t0 = sim.now;
    sim.runUntil(t0 + 2 * RTT_US);
    expect(client.cwnd).toBe(4 * MSS);

    // Kill the wire: the burst the client hands to the link keeps its fate,
    // but the ACKs it provokes die on the dead link, so cwnd freezes here and
    // nothing the sender emits afterwards is ever acknowledged.
    useLossRate(1);
    sim.runUntil(t0 + 10 * RTT_US);
    const beforeTimeout = client.cwnd;
    expect(beforeTimeout).toBe(4 * MSS);
    expect(client.ssthresh).toBe(ceiling);
    expect(events.some((event) => event.event === "timeout")).toBe(false);

    // The first timeout halves the threshold and drops to one MSS: back to
    // slow start, and the timer backs off.
    sim.runUntil(t0 + 10 * RTT_US + rto);
    const timeoutIndex = events.findIndex((event) => event.event === "timeout");
    expect(timeoutIndex).toBeGreaterThan(0);
    expect(events[timeoutIndex]?.cwnd).toBe(MSS);
    expect(client.cwnd).toBe(MSS);
    expect(client.ssthresh).toBe(
      Math.max(2 * MSS, Math.floor(beforeTimeout / 2)),
    );
    expect(client.rtoUs).toBe(2 * rto);

    // A live wire again: the retransmission at the next timeout restarts the
    // transfer, slow start climbs from one MSS and every byte arrives.
    useLossRate(0);
    sim.runAll();
    expect(
      events
        .slice(timeoutIndex + 1)
        .some(
          (event) => event.event === "slow_start" && event.cwnd === 2 * MSS,
        ),
    ).toBe(true);
    expect(server.read()).toEqual(payload);
    expect(client.sndUna).toBe(CLIENT_ISN + 1 + payload.length);
  });

  test("enters fast recovery on the third dup ACK and deflates on new data", () => {
    const ceiling = 32 * MSS;
    const { sim, bus, client, server, useLossRate } = wireRig(
      7,
      {},
      { sendWindow: ceiling },
    );
    const events = recordCongestion(bus, client);
    const start = CLIENT_ISN + 1;

    // Warm up on a good wire: three round trips of slow start leave cwnd at
    // 8 MSS with eight segments in flight and one still queued.
    client.send(patterned(16 * MSS));
    const t0 = sim.now;
    sim.runUntil(t0 + 3 * RTT_US);
    expect(client.cwnd).toBe(8 * MSS);
    expect(client.ssthresh).toBe(ceiling);
    expect(client.sndUna).toBe(start + 7 * MSS);
    expect(client.sndNxt).toBe(start + 15 * MSS);

    // Dead wire from here on: the frames already handed to the link keep their
    // fate but their ACKs die, so cwnd only moves on the ACKs this test hands
    // in, exactly like T4's fast retransmit rig.
    useLossRate(1);
    sim.runUntil(t0 + 5 * RTT_US);
    expect(client.cwnd).toBe(8 * MSS);
    expect(client.fastRecovery).toBe(false);

    const dupAck = (): void => {
      inject(server, client, { seq: server.sndNxt ?? 0, ack: start + 7 * MSS });
      sim.runUntil(sim.now + LATENCY_US);
    };

    // Bring the wire back so the hand-built duplicate ACKs reach the client.
    useLossRate(0);

    // Two duplicates are noise: the window does not move.
    dupAck();
    dupAck();
    expect(client.cwnd).toBe(8 * MSS);
    expect(client.fastRecovery).toBe(false);

    // The third one is a loss signal: ssthresh = cwnd/2, the window is
    // inflated by three MSS and the head segment is resent.
    const halved = Math.floor((8 * MSS) / 2);
    dupAck();
    expect(client.fastRecovery).toBe(true);
    expect(client.ssthresh).toBe(Math.max(2 * MSS, halved));
    expect(client.cwnd).toBe(client.ssthresh + 3 * MSS);
    // Reno, not Tahoe: no timeout, no backoff, the clock is still at its base.
    expect(client.rtoUs).toBe(DEFAULT_RTO_US);
    expect(events.some((event) => event.event === "timeout")).toBe(false);

    // The resend is already on the live wire, but its ACK must not race the
    // hand-injected duplicates: it dies on a dead wire for exactly that trip.
    useLossRate(1);
    sim.runUntil(sim.now + 2 * LATENCY_US);
    useLossRate(0);

    // Every further duplicate ACK inflates the window by one more MSS.
    dupAck();
    expect(client.cwnd).toBe(client.ssthresh + 4 * MSS);
    dupAck();
    expect(client.cwnd).toBe(client.ssthresh + 5 * MSS);

    // The ACK that covers new data ends recovery: deflate to ssthresh and go
    // back to congestion avoidance.
    inject(server, client, { seq: server.sndNxt ?? 0, ack: start + 8 * MSS });
    sim.runUntil(sim.now + LATENCY_US);
    expect(client.fastRecovery).toBe(false);
    expect(client.cwnd).toBe(client.ssthresh);
    expect(client.rtoUs).toBe(DEFAULT_RTO_US);

    const names = events.map((event) => event.event);
    expect(names).toContain("fast_recovery");
    expect(names).toContain("fast_recovery_inflate");
    expect(names).toContain("fast_recovery_exit");
    expect(names).not.toContain("timeout");
  });

  test("draws a sawtooth under loss and still delivers every byte", () => {
    const ceiling = 64 * MSS;
    const { sim, bus, client, server } = wireRig(
      5,
      { lossRate: 0.1 },
      { sendWindow: ceiling },
    );
    const events = recordCongestion(bus, client);
    const payload = patterned(40 * MSS, 5);

    client.send(payload);
    sim.runAll();

    // The payload survives the losses, byte for byte and in order.
    expect(server.read()).toEqual(payload);
    expect(client.sndUna).toBe(CLIENT_ISN + 1 + payload.length);
    expect(client.sndNxt).toBe(CLIENT_ISN + 1 + payload.length);

    // The window rises, collapses, and rises again: the sawtooth the UI plots.
    const falls: Array<number> = [];
    for (let index = 1; index < events.length; index += 1) {
      const before = events[index - 1] as CongestionEvent;
      const after = events[index] as CongestionEvent;
      if (after.cwnd < before.cwnd) {
        falls.push(index);
      }
    }
    expect(falls.length).toBeGreaterThanOrEqual(2);
    for (const index of falls) {
      const before = events[index - 1] as CongestionEvent;
      const after = events[index] as CongestionEvent;
      if (after.event === "timeout") {
        expect(after.cwnd).toBe(MSS);
        expect(after.ssthresh).toBe(
          Math.max(2 * MSS, Math.floor(before.cwnd / 2)),
        );
        continue;
      }
      if (after.event === "fast_recovery") {
        expect(after.ssthresh).toBe(
          Math.max(2 * MSS, Math.floor(before.cwnd / 2)),
        );
        expect(after.cwnd).toBe(after.ssthresh + 3 * MSS);
        continue;
      }
      // Any other fall is the deflate that ends fast recovery.
      expect(after.event).toBe("fast_recovery_exit");
      expect(after.cwnd).toBe(after.ssthresh);
    }
    // Slow start runs again after a collapse, so the tooth climbs back.
    const firstFall = falls[0] as number;
    expect(
      events.slice(firstFall).some((event) => event.event === "slow_start"),
    ).toBe(true);
    // And between two collapses the window really climbs: a sawtooth, not a
    // window that only ever shrinks.
    const secondFall = falls[1] as number;
    const afterFirstCollapse = events[firstFall] as CongestionEvent;
    expect(
      events
        .slice(firstFall, secondFall)
        .some((event) => event.cwnd > afterFirstCollapse.cwnd),
    ).toBe(true);
  });

  test("the window in flight is min(cwnd, SND.WND, sendWindow)", () => {
    const flight = (socket: TcpSocket): number =>
      ((socket.sndNxt ?? 0) - (socket.sndUna ?? 0)) >>> 0;

    // cwnd is the binding cap right after the handshake, well under both the
    // peer's buffer and the configured top.
    const fresh = wireRig(37, {}, { sendWindow: 32 * MSS });
    fresh.client.send(patterned(8 * MSS));
    expect(fresh.client.cwnd).toBe(MSS);
    expect(fresh.client.sndWnd).toBeGreaterThan(8 * MSS);
    expect(fresh.client.sendWindow).toBe(32 * MSS);
    expect(flight(fresh.client)).toBe(MSS);

    // The peer's advertised window wins when it is the smallest: the peer
    // holds 2 MSS, so nothing beyond them ever leaves while cwnd keeps
    // climbing.
    const peerLimited = wireRig(
      41,
      {},
      { sendWindow: 32 * MSS, receiveCapacity: 2 * MSS },
    );
    const peerStart = CLIENT_ISN + 1;
    peerLimited.client.send(patterned(32 * MSS));
    peerLimited.sim.runUntil(peerLimited.sim.now + 8 * RTT_US);
    expect(peerLimited.client.cwnd).toBeGreaterThan(2 * MSS);
    expect((peerLimited.client.sndNxt ?? 0) - peerStart).toBe(2 * MSS);

    // The configured top wins when it is the smallest: cwnd grows past it in
    // congestion avoidance but the flight never exceeds it.
    const configLimited = wireRig(43, {}, { sendWindow: 2 * MSS });
    configLimited.client.send(patterned(32 * MSS));
    configLimited.sim.runUntil(configLimited.sim.now + 8 * RTT_US);
    expect(configLimited.client.cwnd).toBeGreaterThan(2 * MSS);
    expect(flight(configLimited.client)).toBe(2 * MSS);
  });

  test("clamps every burst to cwnd and transfers the payload intact", () => {
    const ceiling = 32 * MSS;
    const { sim, bus, client, server } = wireRig(
      9,
      {},
      { sendWindow: ceiling },
    );
    const payload = patterned(16 * MSS, 9);
    const samples: Array<{ flight: number; window: number }> = [];
    // Sample every data segment as it goes out: cwnd (and the two ceilings)
    // must already cover the flight that includes it.
    bus.subscribe((trace) => {
      if (trace.kind !== "frame_tx" || trace.from !== "a") {
        return;
      }
      const seg = decodeTcp(trace.frame);
      if (seg === undefined || seg.payload.length === 0) {
        return;
      }
      samples.push({
        flight: ((client.sndNxt ?? 0) - (client.sndUna ?? 0)) >>> 0,
        window: Math.min(
          Math.floor(client.cwnd),
          client.sndWnd ?? 0,
          client.sendWindow,
        ),
      });
    });

    const chunks: Array<Uint8Array> = [];
    client.send(payload);
    for (let round = 0; round < 20; round += 1) {
      sim.runUntil(sim.now + RTT_US);
      chunks.push(server.read());
    }

    expect(samples).toHaveLength(16);
    for (const sample of samples) {
      expect(sample.flight).toBeLessThanOrEqual(sample.window);
    }
    expect(joined(chunks)).toEqual(payload);
    expect(client.sndUna).toBe(CLIENT_ISN + 1 + payload.length);
  });
});

/**
 * Accept queue (F-61). A listening socket with `backlog > 1` stays in LISTEN
 * and forks one child per handshake into `pendingAccepts`; `backlog === 1`
 * keeps the historical single-connection path and queues the listener itself.
 * A SYN that finds no room is discarded (never answered with a RST), so the
 * peer retries on its own RTO.
 */
describe("tcp accept queue (F-61)", () => {
  const ACCEPT_PORT = 8080;

  test("keeps the listener in LISTEN and queues one ESTABLISHED child per connection", () => {
    const { sim, a, b } = directLink(51);
    const listener = new TcpSocket({ host: b, sim, backlog: 2 });
    const accepted: Array<TcpSocket> = [];
    listener.onAccept = (socket) => accepted.push(socket);
    listener.listen(ACCEPT_PORT);
    expect(listener.accept()).toBeUndefined();

    const firstClient = new TcpSocket({ host: a, sim, initialSequence: 3000 });
    const secondClient = new TcpSocket({ host: a, sim, initialSequence: 4000 });
    firstClient.connect(IP_B, ACCEPT_PORT, { localPort: 30001 });
    secondClient.connect(IP_B, ACCEPT_PORT, { localPort: 30002 });
    sim.runAll();

    expect(listener.state).toBe("LISTEN");
    const queued = listener.pendingAccepts;
    expect(queued).toHaveLength(2);
    for (const socket of queued) {
      expect(socket.state).toBe("ESTABLISHED");
      expect(socket.localPort).toBe(ACCEPT_PORT);
      expect(socket.remoteIp).toBe(IP_A);
    }
    expect(queued.map((socket) => socket.remotePort).sort()).toEqual([
      30001, 30002,
    ]);
    // `onAccept` is the notification seam and sees the same children.
    expect(accepted).toEqual([...queued]);

    // accept() dequeues FIFO: the oldest connection first, never twice.
    expect(listener.accept()).toBe(queued[0]);
    expect(listener.accept()).toBe(queued[1]);
    expect(listener.accept()).toBeUndefined();
    expect(listener.pendingAccepts).toHaveLength(0);
    expect(listener.state).toBe("LISTEN");
  });

  test("delivers payload carried by the ACK that completes the handshake", () => {
    const { sim, a, b } = directLink(61);
    const server = new TcpSocket({ host: b, sim, initialSequence: SERVER_ISN });
    const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
    const received: Array<Uint8Array> = [];
    server.onData = (data) => received.push(data);
    server.listen(SERVER_PORT);
    // An application that sends as soon as it sees ESTABLISHED puts its first
    // bytes on the wire ahead of the bare ACK of the SYN+ACK: the server must
    // deliver them while it completes its own open, not drop them.
    client.onStateChange = (state) => {
      if (state === "ESTABLISHED") {
        client.send(new Uint8Array([7, 8, 9]));
      }
    };
    client.connect(IP_B, SERVER_PORT);
    // Well before the RTO: the bytes must arrive on the first attempt, not be
    // repaired a second later by the retransmission timer.
    sim.runUntil(sim.now + 10 * LATENCY_US);

    expect(client.state).toBe("ESTABLISHED");
    expect(server.state).toBe("ESTABLISHED");
    expect(joined(received)).toEqual(new Uint8Array([7, 8, 9]));
    expect(server.read()).toEqual(new Uint8Array([7, 8, 9]));
    expect(server.rcvNxt).toBe(CLIENT_ISN + 1 + 3);
    expect(client.sndUna).toBe(CLIENT_ISN + 1 + 3);
  });

  test("delivers payload to the accepted child, never to the listener", () => {
    const { sim, a, b } = directLink(53);
    const listener = new TcpSocket({ host: b, sim, backlog: 2 });
    let listenerBytes = 0;
    listener.onData = (data) => {
      listenerBytes += data.length;
    };
    listener.listen(ACCEPT_PORT);
    const client = new TcpSocket({ host: a, sim, initialSequence: 3000 });
    client.connect(IP_B, ACCEPT_PORT, { localPort: 30001 });
    sim.runAll();

    const accepted = listener.accept();
    expect(accepted).toBeDefined();
    if (accepted === undefined) {
      return;
    }
    const received: Array<Uint8Array> = [];
    accepted.onData = (data) => received.push(data);
    const payload = patterned(2 * DEFAULT_MSS, 3);
    client.send(payload);
    sim.runAll();

    expect(joined(received)).toEqual(payload);
    expect(accepted.read()).toEqual(payload);
    expect(listenerBytes).toBe(0);
  });

  test("accepts a connection whose peer already sent its FIN", () => {
    const { sim, a, b } = directLink(63);
    const listener = new TcpSocket({ host: b, sim, backlog: 2 });
    listener.listen(ACCEPT_PORT);
    const client = new TcpSocket({ host: a, sim, initialSequence: 3000 });
    const payload = new Uint8Array([1, 2, 3]);
    client.connect(IP_B, ACCEPT_PORT, { localPort: 30001 });
    sim.runAll();
    client.send(payload);
    client.close();
    sim.runAll();

    expect(client.state).toBe("FIN_WAIT_2");
    const accepted = listener.accept();
    expect(accepted).toBeDefined();
    if (accepted === undefined) {
      return;
    }
    // Half-closed but readable: the data sent before the FIN is still there.
    expect(accepted.state).toBe("CLOSE_WAIT");
    expect(accepted.read()).toEqual(payload);
    accepted.close();
    sim.runAll();
    expect(accepted.state).toBe("CLOSED");
  });

  test("discards a SYN when the backlog is full, without answering a RST", () => {
    const { sim, bus, a, b } = directLink(55);
    const listener = new TcpSocket({ host: b, sim, backlog: 2 });
    listener.listen(ACCEPT_PORT);
    const clients = [30001, 30002, 30003].map((localPort) => {
      const client = new TcpSocket({ host: a, sim });
      client.connect(IP_B, ACCEPT_PORT, { localPort });
      return client;
    });
    sim.runUntil(sim.now + 10 * LATENCY_US);

    expect(listener.state).toBe("LISTEN");
    expect(listener.pendingAccepts).toHaveLength(2);
    expect(clients[2]?.state).toBe("SYN_SENT");

    const traces = bus.drain();
    const resets = traces.filter(
      (trace) =>
        trace.kind === "frame_tx" && decodeTcp(trace.frame)?.flags.rst === true,
    );
    expect(resets).toHaveLength(0);

    // The rejected peer retries on its own RTO and is dropped again.
    sim.runUntil(sim.now + DEFAULT_RTO_US);
    expect(listener.pendingAccepts).toHaveLength(2);
    expect(clients[2]?.state).toBe("SYN_SENT");
  });

  test("backlog 1 keeps the historical single connection and accepts itself", () => {
    const { sim, a, b } = directLink(57);
    const server = new TcpSocket({ host: b, sim, initialSequence: SERVER_ISN });
    const client = new TcpSocket({ host: a, sim, initialSequence: CLIENT_ISN });
    server.listen(SERVER_PORT);
    expect(server.accept()).toBeUndefined();
    const notified: Array<TcpSocket> = [];
    server.onAccept = (socket) => notified.push(socket);
    client.connect(IP_B, SERVER_PORT);
    sim.runAll();

    expect(server.state).toBe("ESTABLISHED");
    expect(server.pendingAccepts).toEqual([server]);
    expect(notified).toEqual([server]);
    expect(server.accept()).toBe(server);
    expect(server.accept()).toBeUndefined();
  });

  test("publishes live sockets on the host and withdraws them on release", () => {
    const { sim, a, b } = directLink(59);
    const listener = new TcpSocket({ host: b, sim, backlog: 2 });
    const client = new TcpSocket({ host: a, sim, initialSequence: 3000 });
    expect(b.tcpSockets).toHaveLength(0);
    listener.listen(ACCEPT_PORT);
    expect(b.tcpSockets).toEqual([listener]);
    client.connect(IP_B, ACCEPT_PORT, { localPort: 30001 });
    expect(a.tcpSockets).toEqual([client]);
    sim.runAll();
    expect(b.tcpSockets).toHaveLength(2);

    const accepted = listener.accept();
    expect(accepted).toBeDefined();
    if (accepted === undefined) {
      return;
    }
    expect(b.tcpSockets).toContain(accepted);

    client.close();
    sim.runUntil(sim.now + 4 * LATENCY_US);
    expect(accepted.state).toBe("CLOSE_WAIT");
    accepted.close();
    sim.runUntil(sim.now + 8 * LATENCY_US);
    expect(accepted.state).toBe("CLOSED");
    expect(b.tcpSockets).toEqual([listener]);

    // The socket that closed first parks in TIME_WAIT and leaves on expiry.
    expect(client.state).toBe("TIME_WAIT");
    sim.runUntil(sim.now + DEFAULT_TIME_WAIT_US);
    expect(client.state).toBe("CLOSED");
    expect(a.tcpSockets).toHaveLength(0);
  });
});
