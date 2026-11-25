/** CLI wiring: `netlab run` shells get the subnet trainer injected. */
import { describe, expect, test } from "bun:test";
import { runScenario } from "../src/run";
import type { Scenario } from "../src/scenario";

function scenarioWith(commands: Array<string>): Scenario {
  return {
    version: 1,
    seed: 7,
    until: "2ms",
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          { name: "eth0", mac: "02:00:00:00:00:0a", ip: "10.0.0.2/24" },
        ],
      },
      {
        type: "switch",
        id: "sw1",
        ports: [{ name: "p1" }],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "sw1", iface: "p1" },
        params: { latencyUs: 10 },
      },
    ],
    actions: commands.map((exec) => ({ host: "h1", exec })),
  } as unknown as Scenario;
}

describe("subnet trainer wiring in runScenario", () => {
  test("subnet new works through a scenario shell", async () => {
    const run = await runScenario(scenarioWith(["subnet new cidr"]));
    const lines = run.shellTranscripts[0]?.lines ?? [];
    expect(lines.some((line) => line.includes("subnet answer"))).toBe(true);
  });

  test("subnet answer without new reports a typed error, not unsupported", async () => {
    const run = await runScenario(scenarioWith(["subnet answer 1.2.3.0/24"]));
    expect(run.shellTranscripts[0]?.error).toMatch(/no pending drill/);
  });
});
