/**
 * Devices and L2 integration: interfaces (MAC filtering, counters),
 * switch learning/forwarding, hub repeating, and the host ARP cache with
 * its pending queue. Time only advances through the simulation clock: no
 * promises, no wall-clock waits.
 */

import { describe, expect, test } from "bun:test";
import { Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  parseArp,
  parseEthernet,
  serializeArp,
  serializeEthernet,
} from "@netlab/protocols";
import { connect, Device, type NetworkInterface } from "../src/devices";
import { Host, type HostOptions } from "../src/host";
import { Link } from "../src/link";
import { Simulation } from "../src/sim";
import { Hub, Switch, type SwitchOptions } from "../src/switch";
import { type EndpointId, type Trace, TraceBus } from "../src/trace";

const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const MAC_C = "02:00:00:00:00:0c";
const MAC_NOBODY = "02:00:00:00:00:99";
const MAC_GROUP = "01:00:5e:00:00:fb";
const ZERO_MAC = MacAddress.parse("00:00:00:00:00:00");

const IP_A = "10.0.0.1";
const IP_B = "10.0.0.2";
const IP_C = "10.0.0.3";
const IP_NOBODY = "10.0.0.9";

const LATENCY_US = 10;

function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

/** 46-byte payload: exactly the Ethernet minimum, so nothing gets padded. */
function payload(text: string): Uint8Array {
  return asciiBytes(text.padEnd(46, "."));
}

function makeLink(
  sim: Simulation,
  bus: TraceBus,
  id: string,
  latencyUs = LATENCY_US,
): Link {
  return new Link(sim, id, { latencyUs }, bus);
}

/** A frame one station put on the wire. */
interface WireTx {
  t: number;
  frame: Uint8Array;
}

/** Frames one station transmitted on one link (switch repeats excluded). */
function transmitted(
  traces: Array<Trace>,
  link: string,
  from: EndpointId,
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

/** ARP frames on the wire, decoded. */
interface ArpTx {
  t: number;
  oper: number;
  senderIp: string;
  targetIp: string;
}

function arpTxs(wire: Array<WireTx>): Array<ArpTx> {
  const out: Array<ArpTx> = [];
  for (const { t, frame } of wire) {
    const eth = parseEthernet(frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_ARP) {
      continue;
    }
    const arp = parseArp(eth.value.payload);
    if (!arp.ok) {
      continue;
    }
    out.push({
      t,
      oper: arp.value.oper,
      senderIp: arp.value.senderIp.toString(),
      targetIp: arp.value.targetIp.toString(),
    });
  }
  return out;
}

/** Frames on the wire carrying `etherType`. */
function etherTypeCounts(wire: Array<WireTx>, etherType: number): number {
  let count = 0;
  for (const { frame } of wire) {
    const eth = parseEthernet(frame);
    if (eth.ok && eth.value.etherType === etherType) {
      count += 1;
    }
  }
  return count;
}

function logTraces(
  traces: Array<Trace>,
): Array<Extract<Trace, { kind: "log" }>> {
  return traces.flatMap((trace) => (trace.kind === "log" ? [trace] : []));
}

interface Received {
  iface: string;
  etherType: number;
  bytes: Uint8Array;
}

function recordPayloads(host: Host): Array<Received> {
  const received: Array<Received> = [];
  host.onPayload = (iface, etherType, bytes) => {
    received.push({ iface: iface.name, etherType, bytes });
  };
  return received;
}

/** Minimal device that records whatever reaches `onFrame()`. */
class Tap extends Device {
  readonly seen: Array<Uint8Array> = [];

  onFrame(_iface: NetworkInterface, frame: Uint8Array): void {
    this.seen.push(frame);
  }

  port(name: string, mac?: string): NetworkInterface {
    return this.addInterface(name, mac === undefined ? {} : { mac });
  }
}

function twoHostSwitch(
  hostOptions: HostOptions = {},
  switchOptions: SwitchOptions = {},
) {
  const sim = new Simulation(7);
  const bus = new TraceBus();
  const sw = new Switch(sim, "sw1", bus, switchOptions);
  const a = new Host(sim, "a", bus, hostOptions);
  const b = new Host(sim, "b", bus, hostOptions);
  connect(
    makeLink(sim, bus, "l1"),
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A }),
    sw.addPort("p1"),
  );
  connect(
    makeLink(sim, bus, "l2"),
    b.addInterface("eth0", { mac: MAC_B, ip: IP_B }),
    sw.addPort("p2"),
  );
  return { sim, bus, sw, a, b };
}

function threeHostSwitch(
  hostOptions: HostOptions = {},
  switchOptions: SwitchOptions = {},
) {
  const sim = new Simulation(9);
  const bus = new TraceBus();
  const sw = new Switch(sim, "sw1", bus, switchOptions);
  const a = new Host(sim, "a", bus, hostOptions);
  const b = new Host(sim, "b", bus, hostOptions);
  const c = new Host(sim, "c", bus, hostOptions);
  connect(
    makeLink(sim, bus, "l1"),
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A }),
    sw.addPort("p1"),
  );
  connect(
    makeLink(sim, bus, "l2"),
    b.addInterface("eth0", { mac: MAC_B, ip: IP_B }),
    sw.addPort("p2"),
  );
  connect(
    makeLink(sim, bus, "l3"),
    c.addInterface("eth0", { mac: MAC_C, ip: IP_C }),
    sw.addPort("p3"),
  );
  return { sim, bus, sw, a, b, c };
}

describe("Device and NetworkInterface", () => {
  test("invents a locally administered MAC from the simulation PRNG", () => {
    const tap = new Tap(new Simulation(5), "tap0", new TraceBus());
    const first = tap.port("eth0");
    const second = tap.port("eth1");

    expect(first.mac.toString().startsWith("02:")).toBe(true);
    expect(first.mac.isUnicast()).toBe(true);
    expect(second.mac.toString()).not.toBe(first.mac.toString());

    // Same seed, same invented addresses: replay stays bit-identical.
    const twin = new Tap(new Simulation(5), "tap0", new TraceBus());
    expect(twin.port("eth0").mac.toString()).toBe(first.mac.toString());
  });

  test("starts every counter at zero", () => {
    const tap = new Tap(new Simulation(1), "tap0", new TraceBus());
    const port = tap.port("eth0", MAC_A);
    expect(port.mac.toString()).toBe(MAC_A);
    expect(port.up).toBe(true);
    expect(port.counters).toEqual({
      rxFrames: 0,
      rxBytes: 0,
      txFrames: 0,
      txBytes: 0,
      rxErrors: 0,
      rxDropped: 0,
    });
  });

  test("receive() counts the frame even when the interface is down", () => {
    const tap = new Tap(new Simulation(1), "tap0", new TraceBus());
    const port = tap.port("eth0", MAC_A);
    port.up = false;
    port.receive(new Uint8Array(60));
    expect(port.counters.rxFrames).toBe(1);
    expect(port.counters.rxBytes).toBe(60);
    expect(tap.seen.length).toBe(0);

    port.up = true;
    port.receive(new Uint8Array(60));
    expect(port.counters.rxFrames).toBe(2);
    expect(tap.seen.length).toBe(1);
  });

  test("send() refuses a down or detached interface", () => {
    const tap = new Tap(new Simulation(1), "tap0", new TraceBus());
    const port = tap.port("eth0", MAC_A);
    const frame = new Uint8Array(60);

    expect(() => port.send(frame)).toThrow(/attach/i);
    port.up = false;
    expect(() => port.send(frame)).toThrow(/down/i);
    expect(port.counters.txFrames).toBe(0);
  });

  test("getInterface() throws on an unknown name", () => {
    const tap = new Tap(new Simulation(1), "tap0", new TraceBus());
    expect(() => tap.getInterface("eth1")).toThrow(/eth1/);
  });

  test("connect() wires both ends and moves frames both ways", () => {
    const sim = new Simulation(2);
    const bus = new TraceBus();
    const link = makeLink(sim, bus, "l0");
    const sender = new Tap(sim, "sender", bus);
    const receiver = new Tap(sim, "receiver", bus);
    const near = sender.port("eth0", MAC_A);
    const far = receiver.port("eth0", MAC_B);

    connect(link, near, far);
    expect(near.attached).toBe(true);
    expect(far.attached).toBe(true);

    near.send(new Uint8Array([1, 2, 3]));
    expect(near.counters.txFrames).toBe(1);
    expect(near.counters.txBytes).toBe(3);
    sim.runAll();
    expect(receiver.seen.length).toBe(1);
    expect(far.counters.rxFrames).toBe(1);
    expect(far.counters.rxBytes).toBe(3);
  });
});

describe("Interface MAC filtering and parse errors", () => {
  test("counts malformed frames as errors and foreign MACs as drops", () => {
    const host = new Host(new Simulation(3), "h", new TraceBus());
    const port = host.addInterface("eth0", { mac: MAC_A, ip: IP_A });
    const received = recordPayloads(host);

    port.receive(new Uint8Array([1, 2, 3]));
    expect(port.counters.rxErrors).toBe(1);

    const foreign = serializeEthernet(
      {
        dst: MacAddress.parse(MAC_B),
        src: MacAddress.parse(MAC_C),
        etherType: ETHERTYPE_IPV4,
      },
      payload("not-for-me"),
    );
    port.receive(foreign);
    expect(port.counters.rxDropped).toBe(1);
    expect(received.length).toBe(0);
    expect(port.counters.rxFrames).toBe(2);
  });

  test("accepts own unicast, joined multicast and promiscuous mode", () => {
    const { sim, a, b, c } = threeHostSwitch();
    const atB = recordPayloads(b);
    const atC = recordPayloads(c);
    b.getInterface("eth0").multicastGroups.push(MacAddress.parse(MAC_GROUP));

    a.sendRaw(
      "eth0",
      MacAddress.parse(MAC_GROUP),
      ETHERTYPE_IPV4,
      payload("group"),
    );
    sim.runAll();
    expect(atB.length).toBe(1);
    expect(atB[0]?.etherType).toBe(ETHERTYPE_IPV4);
    expect(atC.length).toBe(0);
    expect(c.getInterface("eth0").counters.rxDropped).toBe(1);

    c.getInterface("eth0").promiscuous = true;
    a.sendRaw(
      "eth0",
      MacAddress.parse(MAC_NOBODY),
      ETHERTYPE_IPV4,
      payload("sniffed"),
    );
    sim.runAll();
    expect(atC.length).toBe(1);
    expect(atC[0]?.bytes).toEqual(payload("sniffed"));
  });
});

describe("Host ARP resolution", () => {
  test("resolves through a switch and delivers the payload both ways", () => {
    const { sim, bus, sw, a, b } = twoHostSwitch();
    const atB = recordPayloads(b);
    const atA = recordPayloads(a);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("ping"));
    sim.runAll();

    expect(atB.length).toBe(1);
    expect(atB[0]?.iface).toBe("eth0");
    expect(atB[0]?.etherType).toBe(ETHERTYPE_IPV4);
    expect(atB[0]?.bytes).toEqual(payload("ping"));
    expect(atA.length).toBe(0);

    // Both caches are populated: A from the reply, B from the request.
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);
    expect(b.arpLookup("eth0", IP_A)?.toString()).toBe(MAC_A);

    // Counters: A sent request + payload and received the reply; B the reverse.
    expect(a.getInterface("eth0").counters).toMatchObject({
      rxFrames: 1,
      txFrames: 2,
      rxErrors: 0,
      rxDropped: 0,
    });
    expect(b.getInterface("eth0").counters).toMatchObject({
      rxFrames: 2,
      txFrames: 1,
    });
    expect(sw.getInterface("p1").counters).toMatchObject({
      rxFrames: 2,
      txFrames: 1,
    });
    expect(sw.getInterface("p2").counters).toMatchObject({
      rxFrames: 1,
      txFrames: 2,
    });

    // The MAC table learned both ends, sorted by MAC.
    expect(
      sw.getMacTable().map((entry) => [entry.mac.toString(), entry.port]),
    ).toEqual([
      [MAC_A, "p1"],
      [MAC_B, "p2"],
    ]);

    // One request, RFC 826 shaped: broadcast at L2, zero target MAC inside.
    const fromA = transmitted(bus.drain(), "l1", "a");
    const requests = arpTxs(fromA).filter((tx) => tx.oper === ARP_OP_REQUEST);
    expect(requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ senderIp: IP_A, targetIp: IP_B });

    const firstTx = fromA[0];
    if (firstTx === undefined) {
      throw new Error("expected a frame_tx trace from a on l1");
    }
    const eth = parseEthernet(firstTx.frame);
    if (!eth.ok) {
      throw new Error(`request frame did not parse: ${eth.error.message}`);
    }
    expect(eth.value.dst.toString()).toBe("ff:ff:ff:ff:ff:ff");
    expect(eth.value.src.toString()).toBe(MAC_A);
    const arp = parseArp(eth.value.payload);
    if (!arp.ok) {
      throw new Error(`request ARP did not parse: ${arp.error.message}`);
    }
    expect(arp.value.targetMac.toString()).toBe(ZERO_MAC.toString());
  });

  test("a cache hit on the second send emits no new ARP request", () => {
    const { sim, bus, a, b } = twoHostSwitch();
    const atB = recordPayloads(b);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("first"));
    sim.runAll();
    expect(
      etherTypeCounts(transmitted(bus.drain(), "l1", "a"), ETHERTYPE_ARP),
    ).toBe(1);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("second"));
    sim.runAll();
    expect(
      etherTypeCounts(transmitted(bus.drain(), "l1", "a"), ETHERTYPE_ARP),
    ).toBe(0);
    expect(atB.length).toBe(2);
    expect(atB[1]?.bytes).toEqual(payload("second"));
  });

  test("sendTo() without a source address throws; setAddress() fixes it", () => {
    const sim = new Simulation(11);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", { mac: MAC_A }),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B }),
    );

    expect(() =>
      a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("late")),
    ).toThrow(/IPv4/);
    a.setAddress("eth0", IP_A);
    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("late"));
    sim.runAll();
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);
  });

  test("sendRaw() skips ARP entirely", () => {
    const { sim, bus, a, b } = twoHostSwitch();
    const atB = recordPayloads(b);
    a.sendRaw("eth0", MacAddress.parse(MAC_B), ETHERTYPE_IPV4, payload("raw"));
    sim.runAll();
    expect(
      etherTypeCounts(transmitted(bus.drain(), "l1", "a"), ETHERTYPE_ARP),
    ).toBe(0);
    expect(atB.length).toBe(1);
  });
});

describe("Host pending queue and timeouts", () => {
  test("queues frames sent before resolution and flushes them in order", () => {
    const { sim, a, b } = twoHostSwitch();
    const atB = recordPayloads(b);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("first"));
    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("second"));

    // Request at 0, reply reaches A at 40, both payloads queue on link l1.
    sim.runUntil(41);
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);
    // Two frames in flight; the ARP retry timer was cancelled on resolution.
    expect(sim.pendingEvents).toBe(2);

    sim.runAll();
    expect(atB.length).toBe(2);
    expect(atB[0]?.bytes).toEqual(payload("first"));
    expect(atB[1]?.bytes).toEqual(payload("second"));
  });

  test("drops frames beyond arpQueueLimit", () => {
    const { sim, a, b } = twoHostSwitch({ arpQueueLimit: 2 });
    const atB = recordPayloads(b);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("one"));
    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("two"));
    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("three"));
    sim.runAll();

    expect(atB.length).toBe(2);
    expect(atB[1]?.bytes).toEqual(payload("two"));
  });

  test("an unanswered IP costs exactly arpRetries + 1 requests, then drops", () => {
    const sim = new Simulation(13);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus, { arpTimeoutUs: 1000, arpRetries: 2 });
    const b = new Host(sim, "b", bus);
    connect(
      makeLink(sim, bus, "l0"),
      a.addInterface("eth0", { mac: MAC_A, ip: IP_A }),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B }),
    );

    a.sendTo("eth0", IP_NOBODY, ETHERTYPE_IPV4, payload("lost"));
    sim.runAll();

    const traces = bus.drain();
    const fromA = transmitted(traces, "l0", "a");
    const requests = arpTxs(fromA).filter(
      (tx) => tx.oper === ARP_OP_REQUEST && tx.targetIp === IP_NOBODY,
    );
    expect(requests.map((tx) => tx.t)).toEqual([0, 1000, 2000]);
    expect(requests.every((tx) => tx.senderIp === IP_A)).toBe(true);

    // The payload never left and the cache holds nothing for that IP.
    expect(etherTypeCounts(fromA, ETHERTYPE_IPV4)).toBe(0);
    expect(a.arpLookup("eth0", IP_NOBODY)).toBeUndefined();
    expect(
      logTraces(traces).some((log) => /unreachable/i.test(log.message)),
    ).toBe(true);

    // B saw all three requests but answered none (none was for it).
    expect(b.getInterface("eth0").counters.rxFrames).toBe(3);
    expect(arpTxs(fromA).length).toBe(3);

    // The purged entry means the next attempt starts a brand new resolution.
    a.sendTo("eth0", IP_NOBODY, ETHERTYPE_IPV4, payload("lost-again"));
    expect(arpTxs(transmitted(bus.drain(), "l0", "a")).length).toBe(1);
  });

  test("arpLookup() hides entries past their TTL", () => {
    const { sim, a } = twoHostSwitch({ arpTtlUs: 1000 });
    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("ttl"));
    sim.runAll();
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);

    sim.runUntil(sim.now + 1000);
    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();
  });
});

describe("ARP cache hygiene", () => {
  test("a gratuitous announcement rewrites an existing entry", () => {
    const { sim, a, b, c } = threeHostSwitch();
    const atB = recordPayloads(b);
    const atC = recordPayloads(c);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("legit"));
    sim.runAll();
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);

    // C claims B's address with its own MAC (gratuitous, RFC 5227 style).
    c.sendRaw(
      "eth0",
      MacAddress.BROADCAST,
      ETHERTYPE_ARP,
      serializeArp({
        oper: ARP_OP_REQUEST,
        senderMac: MacAddress.parse(MAC_C),
        senderIp: Ipv4Address.parse(IP_B),
        targetMac: ZERO_MAC,
        targetIp: Ipv4Address.parse(IP_B),
      }),
    );
    sim.runAll();
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_C);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("hijacked"));
    sim.runAll();
    expect(atB.length).toBe(1);
    expect(atC.length).toBe(1);
    expect(atC[0]?.bytes).toEqual(payload("hijacked"));
  });

  test("a conflict with an own address logs and does not poison the cache", () => {
    const { sim, bus, a, c } = threeHostSwitch();
    const before = a.getInterface("eth0").counters.txFrames;

    c.sendRaw(
      "eth0",
      MacAddress.BROADCAST,
      ETHERTYPE_ARP,
      serializeArp({
        oper: ARP_OP_REQUEST,
        senderMac: MacAddress.parse(MAC_C),
        senderIp: Ipv4Address.parse(IP_A),
        targetMac: ZERO_MAC,
        targetIp: Ipv4Address.parse(IP_A),
      }),
    );
    sim.runAll();

    const logs = logTraces(bus.drain());
    expect(logs.some((log) => /conflict/i.test(log.message))).toBe(true);
    expect(logs.some((log) => log.scope.includes("a"))).toBe(true);
    expect(a.arpLookup("eth0", IP_A)).toBeUndefined();
    // No defensive reply: the conflicting announcement is only reported.
    expect(a.getInterface("eth0").counters.txFrames).toBe(before);
  });

  test("an unsolicited reply resolves its own address only", () => {
    const { sim, bus, a, b } = twoHostSwitch();
    const atB = recordPayloads(b);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("queued"));
    // While A waits, B announces a different address out of the blue.
    b.sendRaw(
      "eth0",
      MacAddress.parse(MAC_A),
      ETHERTYPE_ARP,
      serializeArp({
        oper: ARP_OP_REPLY,
        senderMac: MacAddress.parse(MAC_B),
        senderIp: Ipv4Address.parse(IP_C),
        targetMac: MacAddress.parse(MAC_A),
        targetIp: Ipv4Address.parse(IP_A),
      }),
    );

    sim.runUntil(21);
    expect(a.arpLookup("eth0", IP_C)?.toString()).toBe(MAC_B);
    expect(a.arpLookup("eth0", IP_B)).toBeUndefined();

    sim.runAll();
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);
    expect(atB.length).toBe(1);
    expect(
      arpTxs(transmitted(bus.drain(), "l1", "a")).filter(
        (tx) => tx.oper === ARP_OP_REQUEST && tx.targetIp === IP_B,
      ).length,
    ).toBe(1);
  });
});

describe("Switch learning and forwarding", () => {
  test("floods unknown unicast everywhere but the ingress port", () => {
    const { sim, sw, a, b, c } = threeHostSwitch();
    const atB = recordPayloads(b);
    const atC = recordPayloads(c);

    a.sendRaw(
      "eth0",
      MacAddress.parse(MAC_NOBODY),
      ETHERTYPE_IPV4,
      payload("anyone"),
    );
    sim.runAll();

    expect(b.getInterface("eth0").counters.rxFrames).toBe(1);
    expect(c.getInterface("eth0").counters.rxFrames).toBe(1);
    expect(a.getInterface("eth0").counters.rxFrames).toBe(0);
    // Reached the interfaces, but the MAC filter refused it: no payload.
    expect(b.getInterface("eth0").counters.rxDropped).toBe(1);
    expect(atB.length).toBe(0);
    expect(atC.length).toBe(0);
    // Learning came from the source address alone.
    expect(
      sw.getMacTable().map((entry) => [entry.mac.toString(), entry.port]),
    ).toEqual([[MAC_A, "p1"]]);
  });

  test("forwards known unicast only to the learned port", () => {
    const { sim, a, b, c } = threeHostSwitch();
    const atB = recordPayloads(b);
    const atC = recordPayloads(c);

    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("unicast"));
    sim.runAll();

    // C only ever saw the broadcast request; the reply and payload were unicast.
    expect(c.getInterface("eth0").counters.rxFrames).toBe(1);
    expect(b.getInterface("eth0").counters.rxFrames).toBe(2);
    expect(atB.length).toBe(1);
    expect(atC.length).toBe(0);
  });

  test("ages entries out after agingTimeUs", () => {
    const { sim, sw, a } = twoHostSwitch({}, { agingTimeUs: 1000 });
    a.sendRaw(
      "eth0",
      MacAddress.parse(MAC_B),
      ETHERTYPE_IPV4,
      payload("learn"),
    );
    sim.runAll();

    const table = sw.getMacTable();
    expect(table.map((entry) => [entry.mac.toString(), entry.port])).toEqual([
      [MAC_A, "p1"],
    ]);
    // Learned on arrival at t=10, so it dies at t=1010.
    expect(table[0]?.expiresAt).toBe(1010);

    sim.runUntil(1010);
    expect(sw.getMacTable()).toEqual([]);
  });

  test("drops a frame whose learned port is detached, and says so", () => {
    const { sim, bus, sw, a, b } = twoHostSwitch();
    // Learn both ends first.
    a.sendRaw(
      "eth0",
      MacAddress.parse(MAC_B),
      ETHERTYPE_IPV4,
      payload("hello"),
    );
    b.sendRaw("eth0", MacAddress.parse(MAC_A), ETHERTYPE_IPV4, payload("hi"));
    sim.runAll();
    expect(sw.getMacTable().length).toBe(2);

    sw.getInterface("p2").detachLink();
    bus.drain();
    a.sendRaw("eth0", MacAddress.parse(MAC_B), ETHERTYPE_IPV4, payload("gone"));
    sim.runAll();

    const logs = logTraces(bus.drain());
    expect(logs.some((log) => /p2/.test(log.message))).toBe(true);
    expect(sw.getMacTable().length).toBe(2);
  });
});

describe("Hub", () => {
  test("repeats raw frames to every other port, and only those", () => {
    const sim = new Simulation(21);
    const bus = new TraceBus();
    const hub = new Hub(sim, "hub0", bus);
    const a = new Host(sim, "a", bus);
    const b = new Host(sim, "b", bus);
    const c = new Host(sim, "c", bus);
    connect(
      makeLink(sim, bus, "l1"),
      a.addInterface("eth0", { mac: MAC_A, ip: IP_A }),
      hub.addPort("h1"),
    );
    connect(
      makeLink(sim, bus, "l2"),
      b.addInterface("eth0", { mac: MAC_B, ip: IP_B }),
      hub.addPort("h2"),
    );
    connect(
      makeLink(sim, bus, "l3"),
      c.addInterface("eth0", { mac: MAC_C, ip: IP_C }),
      hub.addPort("h3"),
    );
    const atB = recordPayloads(b);
    const atC = recordPayloads(c);

    a.sendRaw("eth0", MacAddress.parse(MAC_B), ETHERTYPE_IPV4, payload("hub"));
    sim.runAll();

    expect(atB.length).toBe(1);
    expect(atB[0]?.bytes).toEqual(payload("hub"));
    // A hub has no MAC table: C sees the frame and filters it in software.
    expect(c.getInterface("eth0").counters.rxFrames).toBe(1);
    expect(atC.length).toBe(0);
    expect(a.getInterface("eth0").counters.rxFrames).toBe(0);

    // No parsing at all: even a runt leaves every other port.
    a.getInterface("eth0").send(new Uint8Array([1, 2, 3]));
    sim.runAll();
    expect(b.getInterface("eth0").counters.rxFrames).toBe(2);
    expect(c.getInterface("eth0").counters.rxFrames).toBe(2);
    expect(b.getInterface("eth0").counters.rxErrors).toBe(1);
  });
});

describe("Interface state", () => {
  test("sendTo() and sendRaw() throw on a down port", () => {
    const { sim, a } = twoHostSwitch();
    a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("up"));
    sim.runAll();
    expect(a.arpLookup("eth0", IP_B)?.toString()).toBe(MAC_B);

    a.getInterface("eth0").up = false;
    expect(() =>
      a.sendTo("eth0", IP_B, ETHERTYPE_IPV4, payload("down")),
    ).toThrow(/down/i);
    expect(() =>
      a.sendRaw(
        "eth0",
        MacAddress.parse(MAC_B),
        ETHERTYPE_IPV4,
        payload("down"),
      ),
    ).toThrow(/down/i);
  });
});
