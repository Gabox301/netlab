import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseScenarioText, runScenario, type Scenario } from "@netlab/cli";
import {
  buildTemplate,
  TEMPLATE_IDS,
  TEMPLATES,
  type TemplateId,
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
 * Canonical scenario for comparison: no MACs and no fused `ip/prefix`
 * (the editor edits address and prefix as separate fields).
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

const MIRRORED: Array<{ id: TemplateId; file: string }> = [
  { id: "lan-simple", file: "dos-hosts-switch.json" },
  { id: "dos-subredes", file: "dos-subredes.json" },
  { id: "vlan-aislamiento", file: "vlan-aislamiento.json" },
];

describe("templates (F-86)", () => {
  test("ships the four roadmap templates", () => {
    expect(TEMPLATE_IDS).toEqual([
      "lan-simple",
      "dos-subredes",
      "vlan-aislamiento",
      "dmz",
    ]);
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATES[id].label.trim()).not.toBe("");
      expect(TEMPLATES[id].description.trim()).not.toBe("");
    }
  });

  for (const { id, file } of MIRRORED) {
    test(`${id} matches its fixture canonically`, () => {
      const { scenario } = topologyToScenarioJson(buildTemplate(id));
      expect(canonical(scenario)).toEqual(canonical(fixture(file)));
    });
  }

  for (const id of TEMPLATE_IDS) {
    test(`${id} exports valid v1 and runs`, async () => {
      const { scenario } = topologyToScenarioJson(buildTemplate(id));
      const result = await runScenario(scenario);
      expect(result.processed).toBeGreaterThan(0);
    });
  }

  test("dmz crosses zones through the router", async () => {
    const { scenario } = topologyToScenarioJson(buildTemplate("dmz"));
    const result = await runScenario(scenario);
    const delivered = result.traces.filter(
      (trace) => trace.kind === "frame_rx",
    );
    expect(delivered.length).toBeGreaterThan(0);
  });

  test("templates place distinct nodes on the canvas", () => {
    for (const id of TEMPLATE_IDS) {
      const topology = buildTemplate(id);
      const names = topology.nodes.map((node) => node.name);
      expect(new Set(names).size).toBe(names.length);
      for (const node of topology.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.x).toBeLessThanOrEqual(1440);
        expect(node.y).toBeLessThanOrEqual(900);
      }
      for (const link of topology.links) {
        for (const end of [link.a, link.b] as const) {
          const node = topology.nodes.find((n) => n.name === end.node);
          expect(node?.interfaces.map((i) => i.name)).toContain(end.iface);
        }
      }
    }
  });

  test("unknown template throws before touching the canvas", () => {
    expect(() => buildTemplate("nube" as TemplateId)).toThrow(
      /plantilla desconocida/,
    );
  });
});
