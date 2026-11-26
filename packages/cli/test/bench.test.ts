import { describe, expect, test } from "bun:test";
import { measureOnce, runBench, runBenchWorkloads } from "../src/bench";

describe("bench workloads", () => {
  test("tiny flood is deterministic in events and bytes", async () => {
    const a = await measureOnce("flood", 20);
    const b = await measureOnce("flood", 20);
    expect(a.events).toBeGreaterThan(0);
    expect(a.events).toBe(b.events);
    expect(a.txBytes).toBe(b.txBytes);
    expect(a.txBytes).toBeGreaterThan(0);
    expect(a.eventsPerSec).toBeGreaterThan(0);
    expect(a.simMbps).toBeGreaterThanOrEqual(0);
    expect(a.rssMb).toBeGreaterThan(0);
  });

  test("bulk moves more bytes than flood for same frames", async () => {
    const flood = await measureOnce("flood", 20);
    const bulk = await measureOnce("bulk", 20);
    expect(bulk.txBytes).toBeGreaterThan(flood.txBytes);
    expect(bulk.events).toBeGreaterThan(0);
  });

  test("runBenchWorkloads returns flood + bulk averaged over repeat", async () => {
    const results = await runBenchWorkloads("tiny", 2);
    expect(results).toHaveLength(2);
    expect(results[0]?.workload).toBe("flood");
    expect(results[1]?.workload).toBe("bulk");
    for (const r of results) {
      expect(r.frames).toBe(20);
      expect(r.events).toBeGreaterThan(0);
    }
  });

  test("runBench rejects bad flags with exit 2", async () => {
    const code = await runBench(["--size", "huge"]);
    expect(code).toBe(2);
  });
});
