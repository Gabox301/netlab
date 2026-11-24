import { describe, expect, test } from "bun:test";
import { type Trace, TraceBus } from "../src/trace";

describe("TraceBus", () => {
  test("replays emissions in order via drain()", () => {
    const bus = new TraceBus();
    const traces: Array<Trace> = [
      { t: 0, kind: "log", scope: "test", level: "info", message: "a" },
      { t: 5, kind: "log", scope: "test", level: "info", message: "b" },
    ];
    for (const t of traces) {
      bus.emit(t);
    }
    expect(bus.length).toBe(2);
    expect(bus.drain()).toEqual(traces);
    expect(bus.length).toBe(0);
    expect(bus.drain()).toEqual([]);
  });

  test("fans out to subscribers and supports unsubscribe", () => {
    const bus = new TraceBus();
    const seenA: Array<Trace> = [];
    const seenB: Array<Trace> = [];
    const off = bus.subscribe((t) => seenA.push(t));
    bus.subscribe((t) => seenB.push(t));
    const t: Trace = {
      t: 1,
      kind: "log",
      scope: "s",
      level: "info",
      message: "x",
    };
    const t2: Trace = {
      t: 2,
      kind: "log",
      scope: "s",
      level: "info",
      message: "y",
    };
    bus.emit(t);
    off();
    bus.emit(t2);
    expect(seenA).toEqual([t]);
    expect(seenB).toEqual([t, t2]);
  });
});
