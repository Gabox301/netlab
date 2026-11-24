import { describe, expect, test } from "bun:test";
import { parseEthernet } from "@netlab/protocols";
import { formatHuman } from "../src/format";
import { runScenario } from "../src/run";
import { parseScenarioJson, type Scenario } from "../src/scenario";

function twoSubnets(): Scenario {
  return parseScenarioJson({
    version: 1,
    seed: 11,
    until: "5s",
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:0a",
            ip: "10.0.0.2",
            mask: "255.255.255.0",
            gateway: "10.0.0.1",
          },
        ],
      },
      {
        type: "router",
        id: "r1",
        interfaces: [
          { name: "p0", ip: "10.0.0.1/24" },
          { name: "p1", ip: "10.0.1.1/24" },
        ],
      },
      {
        type: "host",
        id: "h2",
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:0b",
            ip: "10.0.1.2",
            mask: "255.255.255.0",
            gateway: "10.0.1.1",
          },
        ],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "r1", iface: "p0" },
        params: { latencyUs: 10 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "r1", iface: "p1" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [
      { at: 0, host: "h1", exec: "traceroute 10.0.1.2" },
      {
        at: "5ms",
        host: "h1",
        destIp: "10.0.1.2",
        ping: { count: 2, size: 32, interval: "1ms" },
      },
    ],
  });
}

describe("two subnets through a router", () => {
  test("parses router nodes with connected interfaces", () => {
    const scenario = twoSubnets();
    const router = scenario.nodes.find((node) => node.id === "r1");
    expect(router?.type).toBe("router");
  });

  test("rejects routes without a destination", () => {
    expect(() =>
      parseScenarioJson({
        version: 1,
        nodes: [
          {
            type: "router",
            id: "r1",
            interfaces: [{ name: "p0", ip: "10.0.0.1/24" }],
            routes: [{ iface: "p0" }],
          },
        ],
        links: [],
        actions: [],
      }),
    ).toThrow(/destination/);
  });

  test("echo crosses the router and traceroute shows every hop", async () => {
    const result = await runScenario(twoSubnets());
    expect(result.routes["r1"]?.length).toBe(2);
    expect(result.shellTranscripts).toHaveLength(1);
    const trace = result.shellTranscripts[0] as {
      lines: Array<string>;
    };
    const text = trace.lines.join("\n");
    expect(text).toContain("10.0.0.1");
    expect(text).toContain("10.0.1.2");

    let echoReplies = 0;
    for (const item of result.traces) {
      if (item.kind !== "frame_tx") {
        continue;
      }
      const eth = parseEthernet(item.frame);
      if (eth.ok && eth.value.etherType === 0x0800) {
        echoReplies += 1;
      }
    }
    expect(echoReplies).toBeGreaterThan(0);
    const human = formatHuman(result);
    expect(human).toContain("Routing tables:");
    expect(human).toContain("10.0.0.1");
  });

  test("same seed replays the same trace sequence", async () => {
    const signature = (seed: number): Promise<Array<string>> =>
      runScenario(twoSubnets(), { seed }).then((result) =>
        result.traces.map((trace) => {
          if (trace.kind === "frame_tx" || trace.kind === "frame_rx") {
            return `${trace.kind}:${trace.link}:${trace.length}:${trace.t}`;
          }
          if (trace.kind === "frame_drop") {
            return `${trace.kind}:${trace.link}:${trace.reason}:${trace.t}`;
          }
          return `${trace.kind}:${trace.t}`;
        }),
      );
    expect(await signature(11)).toEqual(await signature(11));
  });
});
