import { describe, expect, test } from "bun:test";
import { runScenario } from "@netlab/cli";
import {
  addInterface,
  addLink,
  addNode,
  canConnect,
  emptyTopology,
  scenarioToTopology,
  type Topology,
  topologyToScenarioJson,
} from "../src/lib/topology";

function lanWithServer(): Topology {
  let current = emptyTopology();
  current = {
    ...addNode(current, "switch", 370, 200).topology,
    until: "5ms",
  };
  const h1 = addNode(current, "host", 120, 200);
  current = h1.topology;
  const srv = addNode(current, "server", 620, 200);
  current = srv.topology;
  const h1Iface = current.nodes.find((n) => n.name === "h1")?.interfaces[0];
  const srvIface = current.nodes.find((n) => n.name === "srv1")?.interfaces[0];
  if (h1Iface === undefined || srvIface === undefined) {
    throw new Error("fixture sin interfaces");
  }
  h1Iface.ip = "10.0.0.2";
  h1Iface.mask = "255.255.255.0";
  srvIface.ip = "10.0.0.3";
  srvIface.mask = "255.255.255.0";
  current = addLink(
    current,
    { node: "h1", iface: "eth0" },
    { node: "sw1", iface: "p1" },
  ).topology;
  current = addLink(
    current,
    { node: "srv1", iface: "eth0" },
    { node: "sw1", iface: "p2" },
  ).topology;
  current = {
    ...current,
    actions: [
      {
        at: 0,
        host: "h1",
        destIp: "10.0.0.3",
        ping: { count: 1, size: 32, interval: "1ms" },
      },
    ],
  };
  return current;
}

describe("server (dibujable)", () => {
  test("adds servers with eth0 and srv names", () => {
    const first = addNode(emptyTopology(), "server", 10, 20);
    expect(first.name).toBe("srv1");
    expect(
      first.topology.nodes[0]?.interfaces.map((iface) => iface.name),
    ).toEqual(["eth0"]);
    const second = addNode(first.topology, "server", 30, 40);
    expect(second.name).toBe("srv2");
  });

  test("extra server interfaces use eth names", () => {
    const srv = addNode(emptyTopology(), "server", 10, 20);
    const added = addInterface(srv.topology, "srv1");
    expect(added.name).toBe("eth1");
  });

  test("wires like a host: switch ok, host and server rejected", () => {
    let current = addNode(emptyTopology(), "switch", 10, 20).topology;
    current = addNode(current, "server", 30, 40).topology;
    current = addNode(current, "host", 50, 60).topology;
    expect(
      canConnect(
        current,
        { node: "srv1", iface: "eth0" },
        { node: "sw1", iface: "p1" },
      ).ok,
    ).toBe(true);
    const srvSrv = canConnect(
      current,
      { node: "srv1", iface: "eth0" },
      { node: "srv1", iface: "eth0" },
    );
    expect(srvSrv.ok).toBe(false);
    const mixed = canConnect(
      current,
      { node: "srv1", iface: "eth0" },
      { node: "h1", iface: "eth0" },
    );
    expect(mixed.ok ? "" : mixed.reason).toMatch(/switch, router o hub/);
  });

  test("exports as a v1 host and answers pings", async () => {
    const { scenario } = topologyToScenarioJson(lanWithServer());
    expect(scenario.nodes.find((node) => node.id === "srv1")?.type).toBe(
      "host",
    );
    const result = await runScenario(scenario);
    expect(
      result.traces.filter((trace) => trace.kind === "frame_rx").length,
    ).toBeGreaterThan(0);
  });

  test("import restores a server as a host (v1 has no server type)", () => {
    const { scenario } = topologyToScenarioJson(lanWithServer());
    const rebuilt = scenarioToTopology(JSON.parse(JSON.stringify(scenario)));
    expect(rebuilt.nodes.find((node) => node.name === "srv1")?.kind).toBe(
      "host",
    );
  });
});
