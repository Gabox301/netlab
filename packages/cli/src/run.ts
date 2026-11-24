/**
 * Build a virtual network from a `Scenario` and run it to `until`.
 *
 * Node creation order follows the JSON: automatic MACs (`02:…`) draw from
 * `sim.random`, so reordering `nodes` changes auto-MACs. Prefer explicit
 * `mac` fields for reproducible fixtures.
 *
 * Shell actions run at their virtual time through real `Shell` instances:
 * the probe bodies execute synchronously inside the scheduled event, so
 * the transcripts line up with the traces. The function is async only to
 * flush the (already resolved) shell promises after the run.
 */

import {
  connect,
  Host,
  Hub,
  Link,
  type MacTableEntry,
  type NetworkInterface,
  type RouteEntry,
  Router,
  Simulation,
  Switch,
  type Trace,
  TraceBus,
} from "@netlab/core";
import { Shell } from "@netlab/shell";
import {
  DEFAULT_UNTIL_US,
  decodePayload,
  parseDurationToUs,
  parseEtherType,
  type Scenario,
  type ScenarioAction,
} from "./scenario";

/** Virtual spacing between ping requests. */
const DEFAULT_PING_INTERVAL_US = 1_000_000;

export interface RunOverrides {
  seed?: number;
  untilUs?: number;
}

export interface ShellTranscript {
  host: string;
  command: string;
  lines?: Array<string>;
  error?: string;
}

export interface RouterTableRow {
  destination: string;
  gateway: string | undefined;
  iface: string;
  metric: number;
  kind: string;
}

export interface RunResult {
  traces: Array<Trace>;
  macTables: Record<string, Array<MacTableEntry>>;
  routes: Record<string, Array<RouterTableRow>>;
  shellTranscripts: Array<ShellTranscript>;
  processed: number;
  finalTime: number;
  seed: number;
  untilUs: number;
}

function toTableRow(entry: RouteEntry): RouterTableRow {
  return {
    destination: entry.destination.toString(),
    gateway: entry.gateway?.toString(),
    iface: entry.iface,
    metric: entry.metric,
    kind: entry.kind,
  };
}

/** Execute a scenario and drain its traces. Throws on bad references. */
export async function runScenario(
  scenario: Scenario,
  overrides: RunOverrides = {},
): Promise<RunResult> {
  const seed = overrides.seed ?? scenario.seed ?? 0;
  const untilUs =
    overrides.untilUs ?? parseDurationToUs(scenario.until, DEFAULT_UNTIL_US);
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const hosts = new Map<string, Host>();
  const switches = new Map<string, Switch>();
  const routers = new Map<string, Router>();
  const shells = new Map<string, Shell>();
  const ifaces = new Map<string, NetworkInterface>();
  const pending: Array<Promise<ShellTranscript>> = [];

  const ifaceKey = (node: string, iface: string): string => `${node}:${iface}`;

  for (const node of scenario.nodes) {
    if (node.type === "host") {
      const host = new Host(sim, node.id, bus, node.hostOpts ?? {});
      for (const def of node.interfaces) {
        const iface = host.addInterface(def.name, {
          ...(def.mac === undefined ? {} : { mac: def.mac }),
          ...(def.ip === undefined ? {} : { ip: def.ip }),
          ...(def.mask === undefined ? {} : { mask: def.mask }),
          ...(def.prefixLength === undefined
            ? {}
            : { prefixLength: def.prefixLength }),
          ...(def.gateway === undefined ? {} : { gateway: def.gateway }),
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
    } else if (node.type === "router") {
      const router = new Router(sim, node.id, bus);
      for (const def of node.interfaces) {
        const iface = router.addPort(def.name, {
          ...(def.mac === undefined ? {} : { mac: def.mac }),
          ip: def.ip,
          ...(def.mask === undefined ? {} : { mask: def.mask }),
          ...(def.prefixLength === undefined
            ? {}
            : { prefixLength: def.prefixLength }),
          ...(def.mtu === undefined ? {} : { mtu: def.mtu }),
        });
        ifaces.set(ifaceKey(node.id, def.name), iface);
      }
      for (const route of node.routes ?? []) {
        if (route.destination === "0.0.0.0/0" && route.gateway !== undefined) {
          router.addDefaultRoute(route.gateway, route.iface, route.metric ?? 0);
        } else {
          router.addRoute({
            destination: route.destination,
            ...(route.gateway === undefined ? {} : { gateway: route.gateway }),
            iface: route.iface,
            ...(route.metric === undefined ? {} : { metric: route.metric }),
          });
        }
      }
      routers.set(node.id, router);
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

  const hostOf = (path: string, id: string): Host => {
    const host = hosts.get(id);
    if (host === undefined) {
      throw new Error(
        `${path}: unknown host ${JSON.stringify(id)} (actions target hosts only)`,
      );
    }
    return host;
  };

  const runAction = (action: ScenarioAction, index: number): void => {
    const path = `actions[${index}]`;
    const atUs = parseDurationToUs(action.at ?? 0, 0, `${path}.at`);
    if ("exec" in action) {
      const host = hostOf(path, action.host);
      let shell = shells.get(action.host);
      if (shell === undefined) {
        shell = new Shell({ host, sim });
        shells.set(action.host, shell);
      }
      const command = action.exec;
      const owner = action.host;
      sim.scheduleAt(atUs, () => {
        pending.push(
          (shell as Shell).exec(command).then(
            (lines) => ({ host: owner, command, lines }),
            (error: unknown) => ({
              host: owner,
              command,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      });
      return;
    }
    if ("ping" in action) {
      const host = hostOf(path, action.host);
      const count = action.ping.count ?? 4;
      const intervalUs = parseDurationToUs(
        action.ping.interval ?? DEFAULT_PING_INTERVAL_US,
        0,
        `${path}.ping.interval`,
      );
      const size = action.ping.size ?? 56;
      const ttl = action.ping.ttl ?? 64;
      const dontFragment = action.ping.dontFragment ?? false;
      const destIp = action.destIp;
      const iface = action.iface === undefined ? {} : { iface: action.iface };
      for (let i = 0; i < count; i++) {
        const sequence = i;
        sim.scheduleAt(atUs + i * intervalUs, () => {
          host.sendPing(destIp, {
            size,
            ttl,
            dontFragment,
            sequence,
            ...iface,
          });
        });
      }
      return;
    }
    const host = hostOf(path, action.host);
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
  };
  scenario.actions.forEach(runAction);

  const processed = sim.runUntil(untilUs);
  const shellTranscripts = await Promise.all(pending);
  const traces = bus.drain();
  const macTables: Record<string, Array<MacTableEntry>> = {};
  for (const [id, sw] of [...switches.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    macTables[id] = sw.getMacTable();
  }
  const routes: Record<string, Array<RouterTableRow>> = {};
  for (const [id, router] of [...routers.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    routes[id] = router.getRouteTable().map(toTableRow);
  }
  return {
    traces,
    macTables,
    routes,
    shellTranscripts,
    processed,
    finalTime: sim.now,
    seed,
    untilUs,
  };
}
