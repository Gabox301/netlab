/**
 * Build a virtual network from a `Scenario` and run it to `until`.
 *
 * Node creation order follows the JSON: automatic MACs (`02:…`) draw from
 * `sim.random`, so reordering `nodes` changes auto-MACs. Prefer explicit
 * `mac` fields for reproducible fixtures.
 */

import {
  connect,
  Host,
  Hub,
  Link,
  type MacTableEntry,
  type NetworkInterface,
  Simulation,
  Switch,
  type Trace,
  TraceBus,
} from "@netlab/core";
import {
  DEFAULT_UNTIL_US,
  decodePayload,
  parseDurationToUs,
  parseEtherType,
  type Scenario,
} from "./scenario";

export interface RunOverrides {
  seed?: number;
  untilUs?: number;
}

export interface RunResult {
  traces: Array<Trace>;
  macTables: Record<string, Array<MacTableEntry>>;
  processed: number;
  finalTime: number;
  seed: number;
  untilUs: number;
}

/** Execute a scenario and drain its traces. Throws on bad references. */
export function runScenario(
  scenario: Scenario,
  overrides: RunOverrides = {},
): RunResult {
  const seed = overrides.seed ?? scenario.seed ?? 0;
  const untilUs =
    overrides.untilUs ?? parseDurationToUs(scenario.until, DEFAULT_UNTIL_US);
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const hosts = new Map<string, Host>();
  const switches = new Map<string, Switch>();
  const ifaces = new Map<string, NetworkInterface>();

  const ifaceKey = (node: string, iface: string): string => `${node}:${iface}`;

  for (const node of scenario.nodes) {
    if (node.type === "host") {
      const host = new Host(sim, node.id, bus, node.hostOpts ?? {});
      for (const def of node.interfaces) {
        const iface = host.addInterface(def.name, {
          ...(def.mac === undefined ? {} : { mac: def.mac }),
          ...(def.ip === undefined ? {} : { ip: def.ip }),
        });
        ifaces.set(ifaceKey(node.id, def.name), iface);
      }
      hosts.set(node.id, host);
    } else if (node.type === "switch") {
      const sw = new Switch(
        sim,
        node.id,
        bus,
        node.agingTimeUs === undefined ? {} : { agingTimeUs: node.agingTimeUs },
      );
      for (const port of node.ports) {
        const iface = sw.addPort(port.name, port.mac);
        ifaces.set(ifaceKey(node.id, port.name), iface);
      }
      switches.set(node.id, sw);
    } else {
      const hub = new Hub(sim, node.id, bus);
      for (const port of node.ports) {
        const iface = hub.addPort(port.name, port.mac);
        ifaces.set(ifaceKey(node.id, port.name), iface);
      }
      // Hubs have no MAC table; keep them out of `macTables`.
      void hosts;
    }
  }

  for (const link of scenario.links) {
    const a = ifaces.get(ifaceKey(link.a.node, link.a.iface));
    const b = ifaces.get(ifaceKey(link.b.node, link.b.iface));
    if (a === undefined) {
      throw new Error(
        `link ${JSON.stringify(link.id)}: unknown interface ${link.a.node}:${link.a.iface}`,
      );
    }
    if (b === undefined) {
      throw new Error(
        `link ${JSON.stringify(link.id)}: unknown interface ${link.b.node}:${link.b.iface}`,
      );
    }
    connect(new Link(sim, link.id, link.params, bus), a, b);
  }

  scenario.actions.forEach((action, index) => {
    const path = `actions[${index}]`;
    const host = hosts.get(action.host);
    if (host === undefined) {
      throw new Error(
        `${path}: unknown host ${JSON.stringify(action.host)} (actions target hosts only)`,
      );
    }
    const atUs = parseDurationToUs(action.at ?? 0, 0, `${path}.at`);
    const etherType = parseEtherType(action.etherType, `${path}.etherType`);
    const payload = decodePayload(
      action.payload,
      action.payloadEncoding,
      `${path}.payload`,
    );
    const destIp = action.destIp;
    const iface = action.iface;
    sim.scheduleAt(atUs, () => {
      host.sendTo(iface, destIp, etherType, payload);
    });
  });

  const processed = sim.runUntil(untilUs);
  const traces = bus.drain();
  const macTables: Record<string, Array<MacTableEntry>> = {};
  for (const [id, sw] of [...switches.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    macTables[id] = sw.getMacTable();
  }
  return {
    traces,
    macTables,
    processed,
    finalTime: sim.now,
    seed,
    untilUs,
  };
}
