import { describe, expect, test } from "bun:test";
import { Mulberry32 } from "../src/prng";

describe("Mulberry32", () => {
  test("same seed reproduces the same sequence", () => {
    const a = new Mulberry32(42);
    const b = new Mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  test("outputs stay in [0, 1)", () => {
    const rng = new Mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("different seeds diverge", () => {
    const a = new Mulberry32(1);
    const b = new Mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  test("consecutive draws advance the state", () => {
    const rng = new Mulberry32(99);
    const first = rng.next();
    const second = rng.next();
    expect(second).not.toBe(first);
  });

  test("seeds coerce to uint32", () => {
    const a = new Mulberry32(-1);
    const b = new Mulberry32(0xffffffff);
    expect(a.next()).toBe(b.next());
  });
});
