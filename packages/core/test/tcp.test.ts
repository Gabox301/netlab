/**
 * TCP machine (F-54/55): three-way handshake, simultaneous open, four-way
 * close with TIME_WAIT expiry, RST for closed ports and a handshake through
 * a router.
 *
 * Every run is deterministic: explicit MACs, explicit ISNs and the
 * simulation clock driven by `runAll()` (no timers left) or `runUntil()`
 * (TIME_WAIT still armed).
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
import { Link } from "../src/link";
import { Router } from "../src/route";
import { Simulation } from "../src/sim";
import { DEFAULT_TIME_WAIT_US, TcpSocket, type TcpState } from "../src/tcp";
import { type Trace, TraceBus } from "../src/trace";

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

/** TCP segments `from` put on the wire, decoded from the frame traces. */
function tcpSegments(traces: Array<Trace>, from: "a" | "b"): Array<TcpSegment> {
  const out: Array<TcpSegment> = [];
  for (const trace of traces) {
    if (trace.kind !== "frame_tx" || trace.from !== from) {
      continue;
    }
    const eth = parseEthernet(trace.frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_IPV4) {
      continue;
    }
    const ip = parseIpv4(eth.value.payload);
    if (!ip.ok || ip.value.header.protocol !== IPV4_PROTOCOL_TCP) {
      continue;
    }
    const seg = parseTcp(ip.value.payload, {
      src: ip.value.header.src,
      dst: ip.value.header.dst,
    });
    if (seg.ok) {
      out.push(seg.value);
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
