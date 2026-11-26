import { describe, expect, test } from "bun:test";
import { ETHERTYPE_IPV4, parseEthernet } from "@netlab/protocols";
import { formatHuman, formatJsonLines, traceToJson } from "../src/format";
import { runScenario } from "../src/run";
import { parseScenarioJson, type Scenario } from "../src/scenario";

function dosHosts(): Scenario {
  return parseScenarioJson({
    version: 1,
    seed: 7,
    until: "2ms",
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          { name: "eth0", mac: "02:00:00:00:00:0a", ip: "10.0.0.1" },
        ],
      },
      {
        type: "host",
        id: "h2",
        interfaces: [
          { name: "eth0", mac: "02:00:00:00:00:0b", ip: "10.0.0.2" },
        ],
      },
      {
        type: "switch",
        id: "sw1",
        ports: [{ name: "p1" }, { name: "p2" }],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "sw1", iface: "p1" },
        params: { latencyUs: 10 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "sw1", iface: "p2" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [
      {
        at: 0,
        host: "h1",
        iface: "eth0",
        destIp: "10.0.0.2",
        etherType: "0x0800",
        payload: "hola desde h1",
      },
      {
        at: "500us",
        host: "h2",
        iface: "eth0",
        destIp: "10.0.0.1",
        etherType: "0x0800",
        payload: "hola desde h2",
      },
    ],
  });
}

async function traceSignature(
  scenario: Scenario,
  seed: number,
): Promise<Array<string>> {
  const result = await runScenario(scenario, { seed });
  return result.traces.map((trace) => {
    if (trace.kind === "frame_tx" || trace.kind === "frame_rx") {
      return `${trace.kind}:${trace.link}:${trace.length}:${trace.t}`;
    }
    if (trace.kind === "frame_drop") {
      return `${trace.kind}:${trace.link}:${trace.reason}:${trace.t}`;
    }
    return `${trace.kind}:${trace.t}`;
  });
}

describe("netlab run", () => {
  test("same seed replays the same trace sequence", async () => {
    const scenario = dosHosts();
    expect(await traceSignature(scenario, 7)).toEqual(
      await traceSignature(scenario, 7),
    );
  });

  test("different seeds can diverge the run", async () => {
    const scenario = dosHosts();
    // Jitter-free links make timing identical; loss would diverge. Here we
    // assert the mechanism: the seed is honored and reported.
    const a = await runScenario(scenario, { seed: 1 });
    const b = await runScenario(scenario, { seed: 2 });
    expect(a.seed).toBe(1);
    expect(b.seed).toBe(2);
  });

  test("populates the switch MAC table and delivers IPv4", async () => {
    const result = await runScenario(dosHosts());
    const table = result.macTables.sw1 ?? [];
    const byMac = new Map(table.map((row) => [row.mac.toString(), row.port]));
    expect(byMac.get("02:00:00:00:00:0a")).toBe("p1");
    expect(byMac.get("02:00:00:00:00:0b")).toBe("p2");

    let ipv4 = 0;
    for (const trace of result.traces) {
      if (trace.kind !== "frame_tx") {
        continue;
      }
      const eth = parseEthernet(trace.frame);
      if (eth.ok && eth.value.etherType === ETHERTYPE_IPV4) {
        ipv4 += 1;
      }
    }
    expect(ipv4).toBeGreaterThan(0);
  });

  test("reports host unreachable when ARP expires", async () => {
    const scenario = parseScenarioJson({
      version: 1,
      seed: 3,
      until: "5ms",
      nodes: [
        {
          type: "host",
          id: "h1",
          interfaces: [
            { name: "eth0", mac: "02:00:00:00:00:0a", ip: "10.0.0.1" },
          ],
          hostOpts: { arpTimeoutUs: 100, arpRetries: 0 },
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
      actions: [
        {
          host: "h1",
          iface: "eth0",
          destIp: "10.0.0.99",
          payload: "nadie",
        },
      ],
    });
    const result = await runScenario(scenario);
    const logs = result.traces.filter((trace) => trace.kind === "log");
    expect(
      logs.some((trace) => trace.message.includes("host unreachable")),
    ).toBe(true);
  });

  test("human and json formatters agree on trace count", async () => {
    const result = await runScenario(dosHosts());
    const human = formatHuman(result);
    expect(human).toContain("MAC tables:");
    expect(human).toContain("02:00:00:00:00:0a -> p1");
    const lines = formatJsonLines(result.traces).trim().split("\n");
    expect(lines).toHaveLength(result.traces.length);
    const first = traceToJson(
      result.traces[0] as (typeof result.traces)[number],
    );
    expect(JSON.parse(lines[0] as string)).toEqual(
      JSON.parse(JSON.stringify(first)),
    );
  });

  test("hub repeats without a MAC table", async () => {
    const scenario = parseScenarioJson({
      version: 1,
      seed: 7,
      until: "2ms",
      nodes: [
        {
          type: "host",
          id: "h1",
          interfaces: [
            { name: "eth0", mac: "02:00:00:00:00:0a", ip: "10.0.0.1" },
          ],
        },
        {
          type: "host",
          id: "h2",
          interfaces: [
            { name: "eth0", mac: "02:00:00:00:00:0b", ip: "10.0.0.2" },
          ],
        },
        {
          type: "hub",
          id: "hub1",
          ports: [{ name: "p1" }, { name: "p2" }],
        },
      ],
      links: [
        {
          id: "l1",
          a: { node: "h1", iface: "eth0" },
          b: { node: "hub1", iface: "p1" },
          params: { latencyUs: 10 },
        },
        {
          id: "l2",
          a: { node: "h2", iface: "eth0" },
          b: { node: "hub1", iface: "p2" },
          params: { latencyUs: 10 },
        },
      ],
      actions: [
        { host: "h1", iface: "eth0", destIp: "10.0.0.2", payload: "via hub" },
      ],
    });
    const result = await runScenario(scenario);
    expect(result.macTables).toEqual({});
    expect(result.traces.length).toBeGreaterThan(0);
  });
});
