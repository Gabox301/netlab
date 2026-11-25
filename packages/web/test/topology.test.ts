import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseScenarioJson,
  parseScenarioText,
  runScenario,
  type Scenario,
} from "@netlab/cli";
import {
  addLink,
  addNode,
  applyLinkPreset,
  canConnect,
  emptyTopology,
  exampleTopology,
  LINK_PRESET_IDS,
  LINK_PRESETS,
  removeInterface,
  renameInterface,
  renameNode,
  scenarioToTopology,
  type Topology,
  topologyFromJson,
  topologyToScenario,
  topologyToScenarioJson,
} from "../src/lib/topology";

function fixture(name: string): Scenario {
  const url = new URL(`../../cli/fixtures/${name}`, import.meta.url);
  return parseScenarioText(readFileSync(url, "utf8"), name);
}

/** Drop MACs: the editor synthesizes them for imported ports that omit one. */
function stripMacs(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, child) => (key === "mac" ? undefined : child)),
  );
}

/**
 * Canonical scenario for round-trip comparison: no MACs and no fused
 * `ip/prefix` (the editor edits address and prefix as separate fields).
 */
function canonical(scenario: Scenario): unknown {
  const copy = JSON.parse(JSON.stringify(scenario)) as Scenario;
  for (const node of copy.nodes) {
    if (node.type !== "host" && node.type !== "router") {
      continue;
    }
    for (const iface of node.interfaces) {
      const ip = iface.ip;
      if (ip === undefined) {
        continue;
      }
      const slash = ip.indexOf("/");
      if (slash < 0) {
        continue;
      }
      iface.ip = ip.slice(0, slash);
      if (iface.prefixLength === undefined) {
        iface.prefixLength = Number.parseInt(ip.slice(slash + 1), 10);
      }
    }
  }
  return stripMacs(copy);
}

function withNodes(
  topology: Topology,
  kinds: Array<"host" | "switch" | "router">,
): Topology {
  return kinds.reduce((current, kind, index) => {
    return addNode(current, kind, 120 + index * 200, 120).topology;
  }, topology);
}

describe("cable validation (S2)", () => {
  test("rejects both ends on the same interface", () => {
    const topology = emptyTopology();
    const check = canConnect(
      topology,
      { node: "h1", iface: "eth0" },
      { node: "h1", iface: "eth0" },
    );
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.reason).toMatch(/no existe el dispositivo/);

    const withHost = addNode(topology, "host", 100, 100).topology;
    const same = canConnect(
      withHost,
      { node: "h1", iface: "eth0" },
      { node: "h1", iface: "eth0" },
    );
    expect(same.ok).toBe(false);
    expect(same.ok ? "" : same.reason).toMatch(/consigo misma/);
  });

  test("rejects an interface that already carries a cable", () => {
    const topology = exampleTopology();
    const check = canConnect(
      topology,
      { node: "h1", iface: "eth0" },
      { node: "r1", iface: "p1" },
    );
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.reason).toMatch(/ya está conectada/);
    expect(() =>
      addLink(
        topology,
        { node: "h1", iface: "eth0" },
        { node: "r1", iface: "p1" },
      ),
    ).toThrow(/ya está conectada/);
  });

  test("rejects cabling a device to itself", () => {
    const topology = exampleTopology();
    const check = canConnect(
      topology,
      { node: "r1", iface: "p2" },
      { node: "r1", iface: "p1" },
    );
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.reason).toMatch(/dos interfaces/);
  });

  test("rejects host-to-host and accepts host-to-port", () => {
    const topology = withNodes(emptyTopology(), ["host", "host"]);
    const rejected = canConnect(
      topology,
      { node: "h1", iface: "eth0" },
      { node: "h2", iface: "eth0" },
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? "" : rejected.reason).toMatch(/switch, router o hub/);

    const mixed = withNodes(emptyTopology(), ["host", "switch"]);
    const accepted = canConnect(
      mixed,
      { node: "h1", iface: "eth0" },
      { node: "sw1", iface: "p1" },
    );
    expect(accepted.ok).toBe(true);
  });

  test("accepts switch-to-switch for a trunk link", () => {
    const topology = withNodes(emptyTopology(), ["switch", "switch"]);
    const check = canConnect(
      topology,
      { node: "sw1", iface: "p1" },
      { node: "sw2", iface: "p1" },
    );
    expect(check.ok).toBe(true);
    const linked = addLink(
      topology,
      { node: "sw1", iface: "p1" },
      { node: "sw2", iface: "p1" },
    );
    expect(linked.id).toBe("l1");
    expect(linked.topology.links[0]?.params.latencyUs).toBe(10);
  });
});

describe("editor structure", () => {
  test("adds devices with their default interfaces and unique MACs", () => {
    const host = addNode(emptyTopology(), "host", 10, 20);
    expect(host.name).toBe("h1");
    const node = host.topology.nodes[0];
    expect(node?.interfaces.map((iface) => iface.name)).toEqual(["eth0"]);

    const router = addNode(host.topology, "router", 200, 20);
    expect(router.name).toBe("r1");
    const routerNode = router.topology.nodes[1];
    expect(routerNode?.interfaces.map((iface) => iface.name)).toEqual([
      "p0",
      "p1",
    ]);
    const macs = router.topology.nodes.flatMap((entry) =>
      entry.interfaces.map((iface) => iface.mac),
    );
    expect(new Set(macs).size).toBe(macs.length);
  });

  test("renames cascade to links, routes and actions", () => {
    const renamedNode = renameNode(exampleTopology(), "h1", "h9");
    expect(renamedNode.nodes[0]?.name).toBe("h9");
    expect(renamedNode.links[0]?.a).toEqual({ node: "h9", iface: "eth0" });
    expect(renamedNode.actions[0]?.host).toBe("h9");
    expect(() => renameNode(exampleTopology(), "h1", "h2")).toThrow(
      /ya existe/,
    );

    const renamedIface = renameInterface(exampleTopology(), "r1", "p0", "wan");
    expect(renamedIface.links[0]?.b).toEqual({ node: "r1", iface: "wan" });
    expect(() => renameInterface(exampleTopology(), "r1", "p0", "p1")).toThrow(
      /ya tiene una interfaz/,
    );

    const removed = removeInterface(exampleTopology(), "r1", "p0");
    expect(removed.links.map((link) => link.id)).toEqual(["l2", "l3"]);
  });
});

describe("scenario export (S4)", () => {
  test("example topology exports a valid v1 scenario", () => {
    const { scenario, json } = topologyToScenarioJson(exampleTopology());
    expect(scenario.version).toBe(1);
    expect(scenario.seed).toBe(11);
    expect(scenario.nodes.map((node) => node.id)).toEqual([
      "h1",
      "r1",
      "h2",
      "h3",
    ]);
    expect(scenario.links).toHaveLength(3);
    expect(scenario.actions).toHaveLength(1);
    expect(scenario.actions[0]).toMatchObject({
      host: "h1",
      destIp: "10.0.2.2",
    });
    expect(json).toContain('"version": 1');
    expect(parseScenarioJson(JSON.parse(json))).toEqual(scenario);
  });

  test("exported example runs in the CLI runner without edits", async () => {
    const { scenario } = topologyToScenarioJson(exampleTopology());
    const result = await runScenario(scenario);
    expect(result.processed).toBeGreaterThan(0);
    expect(result.finalTime).toBeGreaterThan(0);
    expect(result.traces.length).toBeGreaterThan(0);
    const forwarded = result.traces.filter(
      (trace) => trace.kind === "frame_tx",
    );
    expect(forwarded.length).toBeGreaterThan(0);
  });

  test("rejects a router port without an IP", () => {
    const topology = exampleTopology();
    const router = topology.nodes.find((node) => node.name === "r1");
    const port = router?.interfaces[0];
    if (port === undefined) {
      throw new Error("fixture r1 missing");
    }
    port.ip = "";
    expect(() => topologyToScenarioJson(topology)).toThrow(/ip/);
  });

  test("rejects a host mask without an IP", () => {
    const topology = exampleTopology();
    const host = topology.nodes.find((node) => node.name === "h1");
    const iface = host?.interfaces[0];
    if (iface === undefined) {
      throw new Error("fixture h1 missing");
    }
    iface.ip = "";
    expect(() => topologyToScenarioJson(topology)).toThrow(/requieren una IP/);
  });

  test("rejects actions that target a missing host", () => {
    const topology = exampleTopology();
    topology.actions[0] = {
      at: 0,
      host: "ghost",
      destIp: "10.0.0.2",
      ping: { count: 1 },
    };
    expect(() => topologyToScenario(topology)).toThrow(/ghost/);
  });
});

describe("scenario import and round-trip (S4)", () => {
  test("rejects a non-v1 file before touching the canvas", () => {
    expect(() =>
      topologyFromJson('{"version":2,"nodes":[],"links":[],"actions":[]}'),
    ).toThrow(/version/);
    expect(() => topologyFromJson("{ nope")).toThrow(/JSON inválido/);
  });

  test("rebuilds nodes, cables and positions from vlan-aislamiento", () => {
    const rebuilt = scenarioToTopology(fixture("vlan-aislamiento.json"));
    expect(rebuilt.nodes.map((node) => node.name)).toEqual([
      "h1",
      "sw1",
      "sw2",
      "h2",
      "h3",
    ]);
    expect(rebuilt.links.map((link) => link.id)).toEqual([
      "l1",
      "l2",
      "l3",
      "l4",
    ]);
    const positions = new Set(
      rebuilt.nodes.map((node) => `${node.x},${node.y}`),
    );
    expect(positions.size).toBe(rebuilt.nodes.length);
    const sw1 = rebuilt.nodes.find((node) => node.name === "sw1");
    const p2 = sw1?.interfaces.find((iface) => iface.name === "p2");
    expect(p2?.vlan).toMatchObject({ mode: "access", vlan: "20" });
    const p3 = sw1?.interfaces.find((iface) => iface.name === "p3");
    expect(p3?.vlan).toMatchObject({ mode: "trunk", allowed: "10,20" });
  });

  for (const name of [
    "dos-subredes.json",
    "dos-hosts-switch.json",
    "vlan-aislamiento.json",
  ]) {
    test(`round-trip ${name}: import -> export -> parse -> run`, async () => {
      const original = fixture(name);
      const rebuilt = scenarioToTopology(original);
      expect(rebuilt.nodes).toHaveLength(original.nodes.length);
      expect(rebuilt.links).toHaveLength(original.links.length);
      expect(rebuilt.actions).toHaveLength(original.actions.length);

      const reexported = parseScenarioJson(topologyToScenario(rebuilt));
      expect(canonical(reexported)).toEqual(canonical(original));

      const result = await runScenario(reexported);
      expect(result.processed).toBeGreaterThan(0);
    });
  }
});

describe("link presets (F-83)", () => {
  test("ships the four roadmap profiles with core field names", () => {
    expect(LINK_PRESET_IDS).toEqual([
      "lan-ideal",
      "wifi-inestable",
      "satelite",
      "wan-congestionada",
    ]);
    expect(LINK_PRESETS["lan-ideal"]?.label).toBe("LAN ideal");
    expect(LINK_PRESETS["wifi-inestable"]?.label).toBe("WiFi inestable");
    expect(LINK_PRESETS.satelite.label).toBe("Satélite");
    expect(LINK_PRESETS["wan-congestionada"]?.label).toBe(
      "Enlace WAN congestionado",
    );
    // Core names, never the roadmap prose names.
    const dumped = JSON.stringify(LINK_PRESETS);
    expect(dumped).not.toContain("burstLoss");
    expect(dumped).not.toContain('"mtu"');
    expect(LINK_PRESETS["wifi-inestable"]?.params.burst).toMatchObject({
      pGoodToBad: 0.02,
      pBadToGood: 0.4,
    });
    expect(
      LINK_PRESETS["wan-congestionada"]?.params.bandwidthBps,
    ).toBeGreaterThan(0);
  });

  test("applyLinkPreset replaces params but keeps endpoints", () => {
    const base = exampleTopology();
    const before = base.links[0];
    if (before === undefined) {
      throw new Error("fixture sin cables");
    }
    const next = applyLinkPreset(base, before.id, "satelite");
    const after = next.links.find((link) => link.id === before.id);
    expect(after?.a).toEqual(before.a);
    expect(after?.b).toEqual(before.b);
    expect(after?.params.latencyUs).toBe(250_000);
    // The wifi burst clone never leaks back into the preset table.
    const wifi = applyLinkPreset(base, before.id, "wifi-inestable");
    const wifiLink = wifi.links[0];
    if (wifiLink?.params.burst !== undefined) {
      wifiLink.params.burst.pGoodToBad = 0.9;
    }
    expect(LINK_PRESETS["wifi-inestable"]?.params.burst).toMatchObject({
      pGoodToBad: 0.02,
    });
  });

  test("exported presets pass the CLI gate and run", async () => {
    const topology = applyLinkPreset(exampleTopology(), "l1", "lan-ideal");
    const { scenario } = topologyToScenarioJson(topology);
    expect(scenario.links[0]?.params.latencyUs).toBe(10);
    const result = await runScenario(scenario);
    expect(result.processed).toBeGreaterThan(0);
  });

  test("wifi and wan presets survive export -> parse -> import", () => {
    for (const preset of ["wifi-inestable", "wan-congestionada"] as const) {
      const topology = applyLinkPreset(exampleTopology(), "l1", preset);
      const { scenario } = topologyToScenarioJson(topology);
      const parsed = parseScenarioJson(JSON.parse(JSON.stringify(scenario)));
      const rebuilt = scenarioToTopology(parsed);
      expect(rebuilt.links[0]?.params).toEqual(
        applyLinkPreset(exampleTopology(), "l1", preset).links[0]?.params,
      );
    }
  });

  test("export still rejects a negative latency", () => {
    const topology = exampleTopology();
    const link = topology.links[0];
    if (link === undefined) {
      throw new Error("fixture sin cables");
    }
    link.params.latencyUs = -1;
    expect(() => topologyToScenario(topology)).toThrow(/latencyUs/);
  });

  test("export rejects out-of-range impairments before the CLI gate", () => {
    const cases: Array<[string, (params: Record<string, unknown>) => void]> = [
      [
        "lossRate",
        (params) => {
          params.lossRate = 2;
        },
      ],
      [
        "jitterUs",
        (params) => {
          params.jitterUs = -1;
        },
      ],
      [
        "reorderRate",
        (params) => {
          params.reorderRate = 1.5;
        },
      ],
      [
        "bandwidthBps",
        (params) => {
          params.bandwidthBps = 0;
        },
      ],
      [
        "mtuBytes",
        (params) => {
          params.mtuBytes = 0;
        },
      ],
      [
        "queueLimit",
        (params) => {
          params.queueLimit = 0;
        },
      ],
      [
        "burst.pBadToGood",
        (params) => {
          params.burst = { pGoodToBad: 0.02, pBadToGood: 2 };
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const topology = exampleTopology();
      const link = topology.links[0];
      if (link === undefined) {
        throw new Error("fixture sin cables");
      }
      mutate(link.params as unknown as Record<string, unknown>);
      expect(() => topologyToScenario(topology), name).toThrow(
        new RegExp(name.replace(/\..*$/, "")),
      );
    }
  });
});
