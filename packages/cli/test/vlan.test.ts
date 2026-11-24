import { describe, expect, test } from "bun:test";
import { ETHERTYPE_IPV4, parseEthernet, parseIpv4 } from "@netlab/protocols";
import { formatHuman } from "../src/format";
import { runScenario } from "../src/run";
import { parseScenarioJson, type Scenario } from "../src/scenario";

function twoVlans(): Scenario {
  const net = (suffix: string): string => `10.0.0.${suffix}`;
  return parseScenarioJson({
    version: 1,
    seed: 5,
    until: "2s",
    nodes: [
      {
        type: "host",
        id: "h1",
        hostOpts: { arpTimeoutUs: 200_000, arpRetries: 1 },
        interfaces: [{ name: "eth0", ip: net("2"), mask: "255.255.255.0" }],
      },
      {
        type: "switch",
        id: "sw1",
        ports: [
          { name: "p1", vlan: { mode: "access", vlan: 10 } },
          { name: "p2", vlan: { mode: "access", vlan: 20 } },
          { name: "p3", vlan: { mode: "trunk", allowed: [10, 20] } },
        ],
      },
      {
        type: "switch",
        id: "sw2",
        ports: [
          { name: "p1", vlan: { mode: "trunk", allowed: [10, 20] } },
          { name: "p2", vlan: { mode: "access", vlan: 10 } },
        ],
      },
      {
        type: "host",
        id: "h2",
        hostOpts: { arpTimeoutUs: 200_000, arpRetries: 1 },
        interfaces: [{ name: "eth0", ip: net("3"), mask: "255.255.255.0" }],
      },
      {
        type: "host",
        id: "h3",
        interfaces: [{ name: "eth0", ip: net("4"), mask: "255.255.255.0" }],
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
      {
        id: "l3",
        a: { node: "sw1", iface: "p3" },
        b: { node: "sw2", iface: "p1" },
        params: { latencyUs: 10 },
      },
      {
        id: "l4",
        a: { node: "h3", iface: "eth0" },
        b: { node: "sw2", iface: "p2" },
        params: { latencyUs: 10 },
      },
    ],
    actions: [
      {
        at: 0,
        host: "h1",
        destIp: net("4"),
        ping: { count: 1, size: 8, interval: "1ms" },
      },
      {
        at: "1s",
        host: "h1",
        destIp: net("3"),
        ping: { count: 1, size: 8, interval: "1ms" },
      },
    ],
  });
}

/** Destination IPs of IPv4 frames seen on the wire. */
async function ipv4Destinations(scenario: Scenario): Promise<Array<string>> {
  const result = await runScenario(scenario);
  const out: Array<string> = [];
  for (const trace of result.traces) {
    if (trace.kind !== "frame_tx") {
      continue;
    }
    const eth = parseEthernet(trace.frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_IPV4) {
      continue;
    }
    const ip = parseIpv4(eth.value.payload);
    if (ip.ok) {
      out.push(ip.value.header.dst.toString());
    }
  }
  return out;
}

describe("VLAN isolation through a trunk", () => {
  test("parses access and trunk port configs", () => {
    const scenario = twoVlans();
    const sw1 = scenario.nodes.find((node) => node.id === "sw1");
    expect(sw1?.type).toBe("switch");
    if (sw1?.type !== "switch") {
      throw new Error("fixture must define sw1 as a switch");
    }
    expect(sw1.ports).toHaveLength(3);
  });

  test("rejects a VLAN id outside 1..4094", () => {
    expect(() =>
      parseScenarioJson({
        version: 1,
        nodes: [
          {
            type: "switch",
            id: "sw1",
            ports: [{ name: "p1", vlan: { mode: "access", vlan: 5000 } }],
          },
        ],
        links: [],
        actions: [],
      }),
    ).toThrow(/vlan/i);
  });

  test("rejects trunk settings on an access port", () => {
    expect(() =>
      parseScenarioJson({
        version: 1,
        nodes: [
          {
            type: "switch",
            id: "sw1",
            ports: [{ name: "p1", vlan: { mode: "access", allowed: [10] } }],
          },
        ],
        links: [],
        actions: [],
      }),
    ).toThrow(/trunk/i);
  });

  test("same-VLAN ping crosses the trunk, cross-VLAN stays isolated", async () => {
    const dsts = await ipv4Destinations(twoVlans());
    expect(dsts).toContain("10.0.0.4");
    expect(dsts).not.toContain("10.0.0.3");
  });

  test("unanswered ARP in the other VLAN reports host unreachable", async () => {
    const result = await runScenario(twoVlans());
    const logs = result.traces.filter((trace) => trace.kind === "log");
    expect(
      logs.some((trace) => trace.message.includes("host unreachable")),
    ).toBe(true);
  });

  test("MAC tables carry the VLAN id", async () => {
    const result = await runScenario(twoVlans());
    const rows = result.macTables["sw1"] ?? [];
    const vlans = new Set(rows.map((row) => row.vlan));
    expect(vlans.has(10)).toBe(true);
    const human = formatHuman(result);
    expect(human).toContain("vlan 10");
  });
});
