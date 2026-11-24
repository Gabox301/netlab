import { describe, expect, test } from "bun:test";
import { Link, type LinkParams, type Port } from "../src/link";
import { Simulation } from "../src/sim";
import { TraceBus } from "../src/trace";

const BASE_PARAMS: LinkParams = {
  latencyUs: 10,
};

function setup(params: Partial<LinkParams> = {}, seed = 1) {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const link = new Link(sim, "link0", { ...BASE_PARAMS, ...params }, bus);
  const receivedA: Array<Uint8Array> = [];
  const receivedB: Array<Uint8Array> = [];
  const portA: Port = { receive: (f) => receivedA.push(f) };
  const portB: Port = { receive: (f) => receivedB.push(f) };
  link.attach(portA, portB);
  return { sim, bus, link, receivedA, receivedB };
}

function hamming(a: Uint8Array, b: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (a[i] as number) ^ (b[i] as number);
    while (x !== 0) {
      bits += x & 1;
      x >>>= 1;
    }
  }
  return bits;
}

describe("Link delivery", () => {
  test("delivers after latency with tx/rx traces", () => {
    const { sim, bus, link, receivedB } = setup();
    link.send("a", new Uint8Array([0xde, 0xad]));
    expect(receivedB.length).toBe(0);
    sim.runUntil(9);
    expect(receivedB.length).toBe(0);
    sim.runUntil(10);
    expect(receivedB.length).toBe(1);
    expect(receivedB[0]).toEqual(new Uint8Array([0xde, 0xad]));

    const traces = bus.drain();
    expect(traces.length).toBe(2);
    expect(traces[0]).toMatchObject({
      t: 0,
      kind: "frame_tx",
      link: "link0",
      from: "a",
    });
    expect(traces[1]).toMatchObject({
      t: 10,
      kind: "frame_rx",
      link: "link0",
      to: "b",
    });
  });

  test("delivers both directions independently", () => {
    const { sim, link, receivedA, receivedB } = setup();
    link.send("a", new Uint8Array([0x01]));
    link.send("b", new Uint8Array([0x02]));
    sim.runAll();
    expect(receivedB[0]).toEqual(new Uint8Array([0x01]));
    expect(receivedA[0]).toEqual(new Uint8Array([0x02]));
  });

  test("throws when sending on a detached link", () => {
    const sim = new Simulation(1);
    const link = new Link(sim, "l", BASE_PARAMS, new TraceBus());
    expect(() => link.send("a", new Uint8Array([0x01]))).toThrow(/attach/);
  });

  test("snapshots the frame: later sender mutation is invisible", () => {
    const { sim, link, receivedB } = setup();
    const buf = new Uint8Array([0x01, 0x02]);
    link.send("a", buf);
    buf[0] = 0xff;
    sim.runAll();
    expect(receivedB[0]).toEqual(new Uint8Array([0x01, 0x02]));
  });
});

describe("Link impairments", () => {
  test("jitter spreads arrivals within [latency, latency+jitter]", () => {
    const run = (seed: number): Array<number> => {
      const { sim, bus, link } = setup({ jitterUs: 10 }, seed);
      for (let i = 0; i < 5; i++) {
        link.send("a", new Uint8Array([i]));
      }
      sim.runAll();
      return bus
        .drain()
        .filter((t) => t.kind === "frame_rx")
        .map((t) => t.t);
    };
    const arrivals = run(7);
    expect(arrivals.length).toBe(5);
    for (const t of arrivals) {
      expect(t).toBeGreaterThanOrEqual(10);
      expect(t).toBeLessThanOrEqual(20);
    }
    // Same seed => identical arrival pattern (draws are deterministic).
    expect(run(7)).toEqual(arrivals);
  });

  test("lossRate 1 drops everything with reason", () => {
    const { sim, bus, link, receivedB } = setup({ lossRate: 1 });
    link.send("a", new Uint8Array([0x01]));
    link.send("a", new Uint8Array([0x02]));
    sim.runAll();
    expect(receivedB.length).toBe(0);
    const drops = bus.drain().filter((t) => t.kind === "frame_drop");
    expect(drops.length).toBe(2);
    expect(drops[0]).toMatchObject({ reason: "loss" });
  });

  test("lossRate 0 delivers everything", () => {
    const { sim, link, receivedB } = setup({ lossRate: 0 });
    for (let i = 0; i < 10; i++) {
      link.send("a", new Uint8Array([i]));
    }
    sim.runAll();
    expect(receivedB.length).toBe(10);
  });

  test("burst mode: p=1 sinks every frame, p=0 delivers all", () => {
    const sunk = setup({
      lossRate: 0,
      burst: { pGoodToBad: 1, pBadToGood: 0 },
    });
    sunk.link.send("a", new Uint8Array([0x01]));
    sunk.link.send("a", new Uint8Array([0x02]));
    sunk.sim.runAll();
    expect(sunk.receivedB.length).toBe(0);

    const clean = setup({
      lossRate: 0,
      burst: { pGoodToBad: 0, pBadToGood: 0 },
    });
    clean.link.send("a", new Uint8Array([0x01]));
    clean.sim.runAll();
    expect(clean.receivedB.length).toBe(1);
  });

  test("duplicateRate 1 delivers two copies", () => {
    const { sim, bus, link, receivedB } = setup({ duplicateRate: 1 });
    link.send("a", new Uint8Array([0xaa]));
    sim.runAll();
    expect(receivedB.length).toBe(2);
    expect(receivedB[0]).toEqual(receivedB[1]);
    const rx = bus.drain().filter((t) => t.kind === "frame_rx");
    expect(rx.length).toBe(2);
  });

  test("reorder can invert arrivals of close frames", () => {
    // Seed locked: frame1 (t=0) takes the reorder penalty, frame2 (t=5)
    // does not, so frame2 lands first (15 < 20).
    const { sim, link, receivedB } = setup({ reorderRate: 0.5 }, 8);
    link.send("a", new Uint8Array([0x01]));
    sim.runUntil(5);
    link.send("a", new Uint8Array([0x02]));
    sim.runAll();
    expect(Array.from(receivedB, (f) => f[0])).toEqual([0x02, 0x01]);
  });

  test("corruptRate 1 flips exactly one bit", () => {
    const { sim, link, receivedB } = setup({ corruptRate: 1 });
    const sent = new Uint8Array([0xaa, 0x55, 0x00, 0xff]);
    link.send("a", sent);
    sim.runAll();
    expect(receivedB.length).toBe(1);
    expect((receivedB[0] as Uint8Array).length).toBe(4);
    expect(hamming(sent, receivedB[0] as Uint8Array)).toBe(1);
  });

  test("down link drops at send; mid-flight frames die on delivery", () => {
    const ctx = setup();
    ctx.link.up = false;
    ctx.link.send("a", new Uint8Array([0x01]));
    ctx.sim.runAll();
    expect(ctx.receivedB.length).toBe(0);
    expect(
      ctx.bus.drain().filter((t) => t.kind === "frame_drop")[0],
    ).toMatchObject({ reason: "link_down" });

    const ctx2 = setup();
    ctx2.link.send("a", new Uint8Array([0x02]));
    ctx2.link.up = false;
    ctx2.sim.runAll();
    expect(ctx2.receivedB.length).toBe(0);
    expect(
      ctx2.bus.drain().filter((t) => t.kind === "frame_drop")[0],
    ).toMatchObject({ reason: "link_down" });

    ctx2.link.up = true;
    ctx2.link.send("a", new Uint8Array([0x03]));
    ctx2.sim.runAll();
    expect(ctx2.receivedB.length).toBe(1);
  });

  test("mtuExceeded drops oversize frames", () => {
    const { sim, bus, link, receivedB } = setup({ mtuBytes: 4 });
    link.send("a", new Uint8Array([1, 2, 3, 4, 5]));
    link.send("a", new Uint8Array([1, 2, 3, 4]));
    sim.runAll();
    expect(receivedB.length).toBe(1);
    expect(bus.drain().filter((t) => t.kind === "frame_drop")[0]).toMatchObject(
      { reason: "mtu_exceeded" },
    );
  });

  test("bandwidth serializes back-to-back frames", () => {
    // 800_000 bps = 10us per byte. 2-byte frames take 20us each.
    const { sim, link } = setup({ latencyUs: 0, bandwidthBps: 800_000 });
    const at: Array<number> = [];
    const rec: Port = {
      receive: () => at.push(sim.now),
    };
    const snd: Port = { receive: () => {} };
    link.attach(snd, rec);
    link.send("a", new Uint8Array([0x01, 0x02]));
    link.send("a", new Uint8Array([0x03, 0x04]));
    sim.runAll();
    expect(at).toEqual([20, 40]);
  });

  test("queueLimit drops when the buffer is full", () => {
    const { sim, bus, link, receivedB } = setup({
      latencyUs: 0,
      bandwidthBps: 800_000,
      queueLimit: 1,
    });
    link.send("a", new Uint8Array([0x01, 0x02]));
    link.send("a", new Uint8Array([0x03, 0x04]));
    sim.runAll();
    expect(receivedB.length).toBe(1);
    expect(bus.drain().filter((t) => t.kind === "frame_drop")[0]).toMatchObject(
      { reason: "queue_full" },
    );
  });
});

describe("Link params validation", () => {
  test("rejects out-of-range impairment params", () => {
    const sim = new Simulation(1);
    const bus = new TraceBus();
    const bad: Array<Partial<LinkParams>> = [
      { latencyUs: -1 },
      { jitterUs: -1 },
      { lossRate: 2 },
      { lossRate: -0.1 },
      { reorderRate: 1.5 },
      { duplicateRate: Number.NaN },
      { corruptRate: Infinity },
      { bandwidthBps: 0 },
      { mtuBytes: 0 },
      { queueLimit: 0 },
    ];
    for (const p of bad) {
      expect(
        () => new Link(sim, "l", { ...BASE_PARAMS, ...p }, bus),
        JSON.stringify(p),
      ).toThrow(RangeError);
    }
  });

  test("same seed reproduces the same impaired run", () => {
    const run = (seed: number): Array<string> => {
      const { sim, link, receivedB } = setup(
        { jitterUs: 5, lossRate: 0.3, duplicateRate: 0.2 },
        seed,
      );
      for (let i = 0; i < 20; i++) {
        link.send("a", new Uint8Array([i]));
      }
      sim.runAll();
      return receivedB.map((f) => Array.from(f).join(","));
    };
    expect(run(11)).toEqual(run(11));
  });
});
