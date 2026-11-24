/**
 * Switch VLANs (F-17, S1/S2/S3/S5): access and trunk ports, 802.1Q tagging
 * on egress, native VLAN, per-VLAN learning and isolation.
 *
 * Wire assertions decode the tag by hand (offsets 12..17) so the tests check
 * the bytes an actual switch would emit, not the round-trip of the codec
 * under test. `parseEthernet()` still refuses `0x8100`; that anchor is used
 * here to prove a trunk really emitted a tag.
 */

import { describe, expect, test } from "bun:test";
import { MacAddress } from "@netlab/bytes";
import { ETHERTYPE_IPV4, parseEthernet } from "@netlab/protocols";
import { connect, Device, type NetworkInterface } from "../src/devices";
import { Host } from "../src/host";
import { Link } from "../src/link";
import { Simulation } from "../src/sim";
import { Switch, type VlanPortConfig } from "../src/switch";
import { type Trace, TraceBus } from "../src/trace";

const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const MAC_C = "02:00:00:00:00:0c";
const BROADCAST = MacAddress.BROADCAST;

/** Documented default VLAN of an access port. */
const ACCESS_VLAN_DEFAULT = 1;

const HEADER_LENGTH = 14;
const TAGGED_HEADER_LENGTH = 18;

/** 46-byte payload: exactly the Ethernet minimum, so nothing gets padded. */
function payload(text: string): Uint8Array {
  const bytes = new Uint8Array(46);
  for (let i = 0; i < 46; i++) {
    bytes[i] = i < text.length ? text.charCodeAt(i) : 0x2e;
  }
  return bytes;
}

/** Inner EtherType plus payload. */
function body(etherType: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (etherType >> 8) & 0xff;
  out[1] = etherType & 0xff;
  out.set(bytes, 2);
  return out;
}

/** TPID + TCI followed by `rest`: one tag layer, hand-built. */
function tagBlock(
  pcp: number,
  dei: number,
  vid: number,
  rest: Uint8Array,
): Uint8Array {
  const tci = ((pcp & 0x07) << 13) | ((dei & 0x01) << 12) | (vid & 0x0fff);
  const out = new Uint8Array(4 + rest.length);
  out[0] = 0x81;
  out[1] = 0x00;
  out[2] = (tci >> 8) & 0xff;
  out[3] = tci & 0xff;
  out.set(rest, 4);
  return out;
}

/** dst + src followed by `rest`. */
function macFrame(
  dst: MacAddress,
  src: MacAddress,
  rest: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(12 + rest.length);
  out.set(dst.toBytes(), 0);
  out.set(src.toBytes(), 6);
  out.set(rest, 12);
  return out;
}

/** Untagged IPv4 frame of exactly 60 bytes. */
function plainFrame(
  dst: MacAddress,
  src: MacAddress,
  text: string,
): Uint8Array {
  return macFrame(dst, src, body(ETHERTYPE_IPV4, payload(text)));
}

/** Single-tag IPv4 frame of exactly 64 bytes. */
function taggedFrame(
  dst: MacAddress,
  src: MacAddress,
  pcp: number,
  dei: number,
  vid: number,
  text: string,
): Uint8Array {
  return macFrame(
    dst,
    src,
    tagBlock(pcp, dei, vid, body(ETHERTYPE_IPV4, payload(text))),
  );
}

/** Two tags: the outer one is the VLAN, the inner one is payload (no QinQ). */
function doubleTaggedFrame(
  dst: MacAddress,
  src: MacAddress,
  outerVid: number,
  innerVid: number,
  text: string,
): Uint8Array {
  return macFrame(
    dst,
    src,
    tagBlock(
      0,
      0,
      outerVid,
      tagBlock(0, 0, innerVid, body(ETHERTYPE_IPV4, payload(text))),
    ),
  );
}

function mac(text: string): MacAddress {
  return MacAddress.parse(text);
}

/** True when the wire frame starts its payload with an 802.1Q tag. */
function isTaggedOnWire(wire: Uint8Array): boolean {
  return wire[12] === 0x81 && wire[13] === 0x00;
}

function wireTci(wire: Uint8Array): number | undefined {
  if (!isTaggedOnWire(wire)) {
    return undefined;
  }
  return ((wire[14] as number) << 8) | (wire[15] as number);
}

function wireVid(wire: Uint8Array): number | undefined {
  const tci = wireTci(wire);
  return tci === undefined ? undefined : tci & 0x0fff;
}

function wirePcp(wire: Uint8Array): number | undefined {
  const tci = wireTci(wire);
  return tci === undefined ? undefined : (tci >> 13) & 0x07;
}

function wireDei(wire: Uint8Array): number | undefined {
  const tci = wireTci(wire);
  return tci === undefined ? undefined : (tci >> 12) & 0x01;
}

/** Offset where the inner EtherType starts (14 untagged, 18 tagged). */
function innerOffset(wire: Uint8Array): number {
  return isTaggedOnWire(wire) ? TAGGED_HEADER_LENGTH : HEADER_LENGTH;
}

function wireEtherType(wire: Uint8Array): number {
  // The EtherType ends exactly where the payload starts.
  const at = innerOffset(wire) - 2;
  return ((wire[at] as number) << 8) | (wire[at + 1] as number);
}

function wirePayload(wire: Uint8Array): Uint8Array {
  return wire.subarray(innerOffset(wire));
}

/** Minimal station: sends raw frames and records everything it receives. */
class Station extends Device {
  readonly seen: Array<Uint8Array> = [];

  onFrame(_iface: NetworkInterface, frame: Uint8Array): void {
    this.seen.push(frame);
  }

  port(name: string, address: string): NetworkInterface {
    return this.addInterface(name, { mac: address });
  }

  send(iface: string, frame: Uint8Array): void {
    this.getInterface(iface).send(frame);
  }
}

interface Lab {
  sim: Simulation;
  bus: TraceBus;
  sw: Switch;
}

function lab(seed = 3): Lab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  return { sim, bus, sw: new Switch(sim, "sw1", bus) };
}

/** Create a station and wire its `eth0` to switch port `port`. */
function attach(
  l: Lab,
  id: string,
  address: string,
  port: string,
  vlan?: VlanPortConfig,
): Station {
  const station = new Station(l.sim, id, l.bus);
  const link = new Link(l.sim, `l-${id}`, { latencyUs: 1 }, l.bus);
  const switchPort =
    vlan === undefined
      ? l.sw.addPort(port)
      : l.sw.addPort(port, undefined, vlan);
  connect(link, station.port("eth0", address), switchPort);
  return station;
}

function onlyFrame(station: Station): Uint8Array {
  const [frame] = station.seen;
  if (frame === undefined) {
    throw new Error(`${station.id}: expected one frame, saw none`);
  }
  return frame;
}

function logTraces(
  traces: Array<Trace>,
): Array<Extract<Trace, { kind: "log" }>> {
  return traces.flatMap((trace) => (trace.kind === "log" ? [trace] : []));
}

function macTable(sw: Switch): Array<[string, string, number]> {
  return sw
    .getMacTable()
    .map((row): [string, string, number] => [
      row.mac.toString(),
      row.port,
      row.vlan,
    ]);
}

describe("Switch VLAN defaults", () => {
  test("defaults every port to access VLAN 1 and forwards untagged as F-14 did", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1");
    const b = attach(l, "b", MAC_B, "p2");
    const c = attach(l, "c", MAC_C, "p3");

    const wire = plainFrame(BROADCAST, mac(MAC_A), "default");
    a.send("eth0", wire);
    l.sim.runAll();

    expect(b.seen.length).toBe(1);
    expect(c.seen.length).toBe(1);
    // Access egress is byte-identical to what went in: no tag was added.
    expect(onlyFrame(b)).toEqual(wire);
    expect(isTaggedOnWire(onlyFrame(b))).toBe(false);
    expect(parseEthernet(onlyFrame(b)).ok).toBe(true);
    expect(macTable(l.sw)).toEqual([[MAC_A, "p1", ACCESS_VLAN_DEFAULT]]);
  });
});

describe("Switch access ports", () => {
  test("isolates broadcasts inside each access VLAN", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { vlan: 10 });
    const b = attach(l, "b", MAC_B, "p2", { vlan: 10 });
    const c = attach(l, "c", MAC_C, "p3", { vlan: 20 });

    a.send("eth0", plainFrame(BROADCAST, mac(MAC_A), "vlan10"));
    l.sim.runAll();

    expect(b.seen.length).toBe(1);
    expect(c.seen.length).toBe(0);
    expect(wirePayload(onlyFrame(b))).toEqual(payload("vlan10"));
    expect(isTaggedOnWire(onlyFrame(b))).toBe(false);

    c.send("eth0", plainFrame(BROADCAST, mac(MAC_C), "vlan20"));
    l.sim.runAll();

    // Neither VLAN sees the other's broadcast.
    expect(a.seen.length).toBe(0);
    expect(b.seen.length).toBe(1);
    expect(macTable(l.sw)).toEqual([
      [MAC_A, "p1", 10],
      [MAC_C, "p3", 20],
    ]);
  });

  test("never forwards unicast to ports of another VLAN", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { vlan: 10 });
    const b = attach(l, "b", MAC_B, "p2", { vlan: 20 });
    const c = attach(l, "c", MAC_C, "p3", { vlan: 20 });

    // Learn MAC_A in VLAN 10 only.
    a.send("eth0", plainFrame(BROADCAST, mac(MAC_A), "learn-10"));
    l.sim.runAll();
    expect(b.seen.length).toBe(0);
    expect(c.seen.length).toBe(0);

    // In VLAN 20 that MAC is unknown: flood there, never into VLAN 10.
    b.send("eth0", plainFrame(mac(MAC_A), mac(MAC_B), "cross-vlan"));
    l.sim.runAll();

    expect(c.seen.length).toBe(1);
    expect(a.seen.length).toBe(0);
  });
});

describe("Switch trunk ports", () => {
  test("carries several VLANs between trunks, preserving PCP and DEI", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { mode: "trunk", allowed: [10, 20] });
    const b = attach(l, "b", MAC_B, "p2", { mode: "trunk", allowed: [10, 20] });
    const c = attach(l, "c", MAC_C, "p3", { vlan: 20 });

    a.send("eth0", taggedFrame(BROADCAST, mac(MAC_A), 3, 1, 20, "tagged"));
    l.sim.runAll();

    // Trunk -> trunk: one tag, same VID, priority bits echoed.
    expect(b.seen.length).toBe(1);
    const atB = onlyFrame(b);
    expect(isTaggedOnWire(atB)).toBe(true);
    expect(wireVid(atB)).toBe(20);
    expect(wirePcp(atB)).toBe(3);
    expect(wireDei(atB)).toBe(1);
    expect(wireEtherType(atB)).toBe(ETHERTYPE_IPV4);
    expect(wirePayload(atB)).toEqual(payload("tagged"));
    expect(atB.length).toBe(64);
    // Anchor: the strict parser still refuses what the trunk just emitted.
    expect(parseEthernet(atB).ok).toBe(false);

    // Trunk -> access VLAN 20: de-tagged.
    expect(c.seen.length).toBe(1);
    expect(isTaggedOnWire(onlyFrame(c))).toBe(false);
    expect(wirePayload(onlyFrame(c))).toEqual(payload("tagged"));

    // VLAN 10 does not leak into access VLAN 20.
    b.send("eth0", taggedFrame(BROADCAST, mac(MAC_B), 0, 0, 10, "other"));
    l.sim.runAll();
    expect(c.seen.length).toBe(1);
  });

  test("leaves native VLAN frames untagged in both directions", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", {
      mode: "trunk",
      allowed: [10, 30],
      native: 30,
    });
    const b = attach(l, "b", MAC_B, "p2", { vlan: 30 });
    const c = attach(l, "c", MAC_C, "p3", { vlan: 10 });

    // Untagged ingress is classified into the native VLAN.
    a.send("eth0", plainFrame(BROADCAST, mac(MAC_A), "native-in"));
    l.sim.runAll();
    expect(b.seen.length).toBe(1);
    expect(c.seen.length).toBe(0);
    expect(isTaggedOnWire(onlyFrame(b))).toBe(false);
    expect(macTable(l.sw)).toEqual([[MAC_A, "p1", 30]]);

    // A tagged frame in the native VLAN is admitted and leaves untagged.
    a.send("eth0", taggedFrame(BROADCAST, mac(MAC_A), 2, 0, 30, "native-tag"));
    l.sim.runAll();
    expect(b.seen.length).toBe(2);
    expect(isTaggedOnWire(b.seen[1] as Uint8Array)).toBe(false);
    expect(wirePayload(b.seen[1] as Uint8Array)).toEqual(payload("native-tag"));

    // ... while a non-native VLAN reaches its access port de-tagged too.
    a.send("eth0", taggedFrame(BROADCAST, mac(MAC_A), 0, 0, 10, "vlan10"));
    l.sim.runAll();
    expect(c.seen.length).toBe(1);
    expect(isTaggedOnWire(onlyFrame(c))).toBe(false);
  });

  test("drops a tagged frame whose VID the trunk does not carry", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { mode: "trunk", allowed: [10] });
    const b = attach(l, "b", MAC_B, "p2", { vlan: 10 });

    a.send("eth0", taggedFrame(BROADCAST, mac(MAC_A), 0, 0, 20, "nope"));
    l.sim.runAll();

    expect(b.seen.length).toBe(0);
    expect(macTable(l.sw)).toEqual([]);
    const port = l.sw.getInterface("p1");
    expect(port.counters.rxFrames).toBe(1);
    expect(port.counters.rxDropped).toBe(1);
    expect(port.counters.rxErrors).toBe(0);

    const logs = logTraces(l.bus.drain());
    expect(logs.some((log) => /VID 20/.test(log.message))).toBe(true);
  });

  test("drops untagged ingress on a trunk without a native VLAN", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { mode: "trunk", allowed: [10] });
    const b = attach(l, "b", MAC_B, "p2", { vlan: 10 });

    a.send("eth0", plainFrame(BROADCAST, mac(MAC_A), "untagged"));
    l.sim.runAll();

    expect(b.seen.length).toBe(0);
    expect(l.sw.getInterface("p1").counters.rxDropped).toBe(1);
    expect(
      logTraces(l.bus.drain()).some((log) => /native/i.test(log.message)),
    ).toBe(true);
  });

  test("drops VID 0 and VID 4095 even on a trunk that carries everything", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { mode: "trunk" });
    const b = attach(l, "b", MAC_B, "p2", { mode: "trunk", allowed: [10] });

    a.send("eth0", taggedFrame(BROADCAST, mac(MAC_A), 0, 0, 0, "priority"));
    a.send("eth0", taggedFrame(BROADCAST, mac(MAC_A), 0, 0, 4095, "reserved"));
    l.sim.runAll();

    expect(b.seen.length).toBe(0);
    expect(macTable(l.sw)).toEqual([]);
    expect(l.sw.getInterface("p1").counters.rxDropped).toBe(2);
  });

  test("drops a tagged frame on an access port with the F-14 error counter", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { vlan: 10 });
    const b = attach(l, "b", MAC_B, "p2", { vlan: 10 });

    a.send("eth0", taggedFrame(BROADCAST, mac(MAC_A), 0, 0, 10, "tagged"));
    l.sim.runAll();

    expect(b.seen.length).toBe(0);
    // Before VLANs the strict parser refused 0x8100 with rxErrors. An access
    // port still cannot classify a tag, so that counter does not change.
    const port = l.sw.getInterface("p1");
    expect(port.counters.rxErrors).toBe(1);
    expect(port.counters.rxDropped).toBe(0);
    expect(
      logTraces(l.bus.drain()).some((log) => /access/i.test(log.message)),
    ).toBe(true);
  });

  test("reads one tag only: a second tag stays payload", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { mode: "trunk", allowed: [10, 20] });
    const b = attach(l, "b", MAC_B, "p2", { mode: "trunk", allowed: [10, 20] });
    const c = attach(l, "c", MAC_C, "p3", { vlan: 20 });

    // Outer tag 20 is the VLAN; the inner tag says 10 and means nothing.
    const wire = doubleTaggedFrame(BROADCAST, mac(MAC_A), 20, 10, "qinq");
    a.send("eth0", wire);
    l.sim.runAll();

    // Trunk egress re-emits the frame byte for byte: one VID, one tag added.
    expect(onlyFrame(b)).toEqual(wire);

    // Access 20 strips the tag it consumed. The second tag was never
    // interpreted, so it is still on the wire in the same position.
    const atC = onlyFrame(c);
    expect(atC.length).toBe(64);
    expect(wireVid(atC)).toBe(10);
    expect(wireEtherType(atC)).toBe(ETHERTYPE_IPV4);
    expect(wirePayload(atC)).toEqual(payload("qinq"));
    expect(atC.subarray(12)).toEqual(
      tagBlock(0, 0, 10, body(ETHERTYPE_IPV4, payload("qinq"))),
    );
  });
});

describe("Switch VLAN learning", () => {
  test("learns the same MAC separately in each VLAN", () => {
    const l = lab();
    const a = attach(l, "a", MAC_A, "p1", { vlan: 10 });
    const b = attach(l, "b", MAC_A, "p2", { vlan: 20 });
    const c = attach(l, "c", MAC_C, "p3", { vlan: 10 });

    a.send("eth0", plainFrame(BROADCAST, mac(MAC_A), "learn-a"));
    b.send("eth0", plainFrame(BROADCAST, mac(MAC_A), "learn-b"));
    l.sim.runAll();

    expect(macTable(l.sw)).toEqual([
      [MAC_A, "p1", 10],
      [MAC_A, "p2", 20],
    ]);

    // VLAN 10 unicast reaches p1...
    c.send("eth0", plainFrame(mac(MAC_A), mac(MAC_C), "to-a"));
    l.sim.runAll();
    expect(a.seen.length).toBe(1);
    expect(wirePayload(onlyFrame(a))).toEqual(payload("to-a"));

    // ... while the same MAC inside VLAN 20 resolves to p2, its own port: the
    // frame is filtered there and never crosses into VLAN 10.
    b.send("eth0", plainFrame(mac(MAC_A), mac(MAC_A), "self"));
    l.sim.runAll();
    expect(a.seen.length).toBe(1);
    expect(b.seen.length).toBe(0);
  });
});

describe("Switch VLAN configuration", () => {
  test("rejects unusable VLAN settings with RangeError", () => {
    const l = lab();

    expect(() => l.sw.addPort("p1", undefined, { vlan: 0 })).toThrow(
      RangeError,
    );
    expect(() => l.sw.addPort("p1", undefined, { vlan: 4095 })).toThrow(
      RangeError,
    );
    expect(() => l.sw.addPort("p1", undefined, { vlan: 4096 })).toThrow(
      RangeError,
    );
    expect(() =>
      l.sw.addPort("p1", undefined, { mode: "trunk", allowed: [0] }),
    ).toThrow(RangeError);
    expect(() =>
      l.sw.addPort("p1", undefined, { mode: "trunk", allowed: [] }),
    ).toThrow(RangeError);
    // A native VLAN outside `allowed` would carry untagged frames nowhere.
    expect(() =>
      l.sw.addPort("p1", undefined, {
        mode: "trunk",
        allowed: [10],
        native: 20,
      }),
    ).toThrow(RangeError);
    // Mixing access and trunk keywords is a configuration bug.
    expect(() =>
      l.sw.addPort("p1", undefined, { mode: "access", allowed: [10] }),
    ).toThrow(RangeError);
    expect(() =>
      l.sw.addPort("p1", undefined, { mode: "trunk", vlan: 10 }),
    ).toThrow(RangeError);

    // Rejected configurations leave no half-created port behind.
    expect(l.sw.interfaces.length).toBe(0);
  });
});

describe("Frame immutability (S5)", () => {
  test("re-tagging serializes copies and never mutates the received frame", () => {
    const l = lab();
    attach(l, "a", MAC_A, "p1", { mode: "trunk", allowed: [10] });
    attach(l, "b", MAC_B, "p2", { vlan: 10 });

    const wire = taggedFrame(BROADCAST, mac(MAC_A), 2, 0, 10, "immutable");
    const before = wire.slice();
    l.bus.drain();

    // Deliver synchronously so the switch work happens before any event runs.
    l.sw.getInterface("p1").receive(wire);

    const tx = l.bus
      .drain()
      .flatMap((trace) => (trace.kind === "frame_tx" ? [trace] : []));
    expect(tx.length).toBe(1);
    const egress = tx[0]?.frame;
    if (egress === undefined) {
      throw new Error("expected the switch to transmit the frame");
    }

    // A copy left the switch, de-tagged to 14 + 46 bytes.
    expect(egress).not.toBe(wire);
    expect(egress.length).toBe(60);
    expect(isTaggedOnWire(egress)).toBe(false);
    // The received frame is untouched, now and after the egress copy is used.
    expect(wire).toEqual(before);
    egress[0] = 0xff;
    expect(wire).toEqual(before);
  });
});

describe("Endpoint boundary (S2)", () => {
  test("a host still refuses tagged frames, and accepts the untagged twin", () => {
    const sim = new Simulation(11);
    const bus = new TraceBus();
    const host = new Host(sim, "h1", bus);
    const iface = host.addInterface("eth0", { mac: MAC_A, ip: "10.0.0.1" });
    const received: Array<Uint8Array> = [];
    host.onPayload = (_iface, _etherType, bytes) => {
      received.push(bytes);
    };

    iface.receive(taggedFrame(mac(MAC_A), mac(MAC_B), 0, 0, 10, "tagged"));
    expect(iface.counters.rxErrors).toBe(1);
    expect(iface.counters.rxDropped).toBe(0);
    expect(received.length).toBe(0);

    iface.receive(plainFrame(mac(MAC_A), mac(MAC_B), "untagged"));
    expect(iface.counters.rxErrors).toBe(1);
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(payload("untagged"));
  });
});
