import { describe, expect, test } from "bun:test";
import { Simulation } from "../src/sim";

function scenario(seed: number): Array<string> {
  const sim = new Simulation(seed);
  const log: Array<string> = [];
  sim.schedule(10, (s) => {
    log.push(`a@${s.now}:${s.random.next().toFixed(6)}`);
    s.schedule(5, (s2) => {
      log.push(`c@${s2.now}`);
    });
  });
  sim.schedule(10, (s) => {
    log.push(`b@${s.now}:${s.random.next().toFixed(6)}`);
  });
  sim.schedule(3, (s) => {
    log.push(`first@${s.now}`);
  });
  sim.runAll();
  return log;
}

describe("Simulation clock and event queue", () => {
  test("starts at zero with nothing pending", () => {
    const sim = new Simulation(1);
    expect(sim.now).toBe(0);
    expect(sim.pendingEvents).toBe(0);
    expect(sim.step()).toBe(false);
    expect(sim.now).toBe(0);
  });

  test("runs events in time order", () => {
    const sim = new Simulation(1);
    const order: Array<string> = [];
    sim.schedule(30, () => order.push("late"));
    sim.schedule(10, () => order.push("early"));
    sim.schedule(20, () => order.push("mid"));
    sim.runAll();
    expect(order).toEqual(["early", "mid", "late"]);
    expect(sim.now).toBe(30);
  });

  test("breaks timestamp ties in schedule (FIFO) order", () => {
    const sim = new Simulation(1);
    const order: Array<string> = [];
    sim.schedule(10, () => order.push("first-scheduled"));
    sim.schedule(10, () => order.push("second-scheduled"));
    sim.runAll();
    expect(order).toEqual(["first-scheduled", "second-scheduled"]);
  });

  test("zero-delay events run after the current event", () => {
    const sim = new Simulation(1);
    const order: Array<string> = [];
    sim.schedule(5, (s) => {
      order.push("outer");
      s.schedule(0, () => order.push("inner"));
    });
    sim.schedule(5, () => order.push("sibling"));
    sim.runAll();
    expect(order).toEqual(["outer", "sibling", "inner"]);
  });

  test("events scheduled from inside events see the current time", () => {
    const sim = new Simulation(1);
    const seen: Array<number> = [];
    sim.schedule(10, (s) => {
      seen.push(s.now);
      s.schedule(5, (s2) => seen.push(s2.now));
    });
    sim.runAll();
    expect(seen).toEqual([10, 15]);
  });

  test("rejects negative, NaN or infinite delays", () => {
    const sim = new Simulation(1);
    expect(() => sim.schedule(-1, () => {})).toThrow(RangeError);
    expect(() => sim.schedule(Number.NaN, () => {})).toThrow(RangeError);
    expect(() => sim.schedule(Infinity, () => {})).toThrow(RangeError);
  });

  test("step() advances one event at a time", () => {
    const sim = new Simulation(1);
    sim.schedule(10, () => {});
    sim.schedule(20, () => {});
    expect(sim.step()).toBe(true);
    expect(sim.now).toBe(10);
    expect(sim.pendingEvents).toBe(1);
    expect(sim.step()).toBe(true);
    expect(sim.now).toBe(20);
    expect(sim.step()).toBe(false);
  });

  test("runUntil() stops at the horizon and pins now to it", () => {
    const sim = new Simulation(1);
    const ran: Array<string> = [];
    sim.schedule(10, () => ran.push("a"));
    sim.schedule(20, () => ran.push("b"));
    sim.runUntil(15);
    expect(ran).toEqual(["a"]);
    expect(sim.now).toBe(15);
    expect(sim.pendingEvents).toBe(1);
    sim.runUntil(25);
    expect(ran).toEqual(["a", "b"]);
    expect(sim.now).toBe(25);
  });

  test("runUntil() rejects going backwards", () => {
    const sim = new Simulation(1);
    sim.schedule(10, () => {});
    sim.runUntil(15);
    expect(() => sim.runUntil(14)).toThrow(RangeError);
  });

  test("cancel() prevents a pending event, exactly once", () => {
    const sim = new Simulation(1);
    let fired = false;
    const handle = sim.schedule(10, () => {
      fired = true;
    });
    expect(sim.pendingEvents).toBe(1);
    expect(handle.cancel()).toBe(true);
    expect(handle.cancel()).toBe(false);
    expect(sim.pendingEvents).toBe(0);
    sim.runAll();
    expect(fired).toBe(false);
  });

  test("cancel() after firing reports false", () => {
    const sim = new Simulation(1);
    const handle = sim.schedule(10, () => {});
    sim.runAll();
    expect(handle.cancel()).toBe(false);
  });

  test("runAll() guards against infinite event loops", () => {
    const sim = new Simulation(1);
    sim.schedule(1, (s) => {
      s.schedule(1, function loop(ss) {
        ss.schedule(1, loop);
      });
    });
    expect(() => sim.runAll(100)).toThrow(/100/);
  });

  test("same seed reproduces the same run, bit for bit", () => {
    expect(scenario(42)).toEqual(scenario(42));
  });

  test("different seeds diverge the run", () => {
    expect(scenario(42)).not.toEqual(scenario(43));
  });
});
