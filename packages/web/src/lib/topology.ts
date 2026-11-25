/**
 * Editor topology model and its bridge to the CLI scenario v1.
 *
 * The editor keeps the network in memory; everything here is pure (no DOM),
 * so the canvas, `bun test` and the static build share the same rules.
 *
 * Export path: `topologyToScenario()` builds the schema object, then
 * `topologyToScenarioJson()` runs the CLI's own `parseScenarioJson()` gate
 * before returning the text. The extra checks in this module cover what the
 * schema accepts but `netlab run` cannot build (a host mask without an IP, a
 * router port without a prefix, dangling references), so a downloaded file
 * runs without manual edits.
 *
 * Import path: `topologyFromJson()` parses and validates with the same
 * `parseScenarioJson()`, then `scenarioToTopology()` rebuilds nodes, cables
 * and actions. Scenario JSON stays the source of truth: the editor never
 * invents behavior the CLI cannot express.
 *
 * The CLI package is not a web dependency (it is not browser code), so the
 * pure schema module is imported by relative path. It only imports a type, so
 * this does not pull the runner into the client bundle.
 */

import {
  parseScenarioJson,
  SCENARIO_VERSION,
  type Scenario,
  type ScenarioAction,
  type ScenarioHostOpts,
  type ScenarioInterfaceDef,
  type ScenarioLink,
  type ScenarioNode,
  type ScenarioPortDef,
  type ScenarioRouteDef,
  type ScenarioRouterPortDef,
  type ScenarioVlanPortConfig,
} from "@netlab/cli";
import type { LinkParams } from "@netlab/core";

export type {
  Scenario,
  ScenarioAction,
  ScenarioPingAction,
} from "@netlab/cli";

export const CANVAS_WIDTH = 1440;
export const CANVAS_HEIGHT = 900;
export const NODE_WIDTH = 132;
export const NODE_HEIGHT = 68;

/** Link latency used by new cables; matches the CLI fixtures. */
export const DEFAULT_LATENCY_US = 10;

export type LinkPresetId =
  | "lan-ideal"
  | "wifi-inestable"
  | "satelite"
  | "wan-congestionada";

export interface LinkPreset {
  id: LinkPresetId;
  label: string;
  hint: string;
  params: LinkParams;
}

/**
 * F-83 presets with core field names (`burst`, `mtuBytes`; the roadmap
 * calls them `burstLoss`, `mtu`). Values are engineering-plausible
 * defaults, not measurements: LAN ideal zeroes impairments; WiFi models
 * bursty loss with jitter and reorder; satélite is propagation-dominated;
 * WAN congestionada caps bandwidth with a short queue so frames drop
 * with `queue_full` under load.
 */
export const LINK_PRESETS: Record<LinkPresetId, LinkPreset> = {
  "lan-ideal": {
    id: "lan-ideal",
    label: "LAN ideal",
    hint: "Sin impairments: latencia mínima, cero pérdida.",
    params: {
      latencyUs: 10,
      jitterUs: 0,
      lossRate: 0,
      reorderRate: 0,
      duplicateRate: 0,
      corruptRate: 0,
    },
  },
  "wifi-inestable": {
    id: "wifi-inestable",
    label: "WiFi inestable",
    hint: "Pérdida en ráfagas + jitter y reorden.",
    params: {
      latencyUs: 5000,
      jitterUs: 2000,
      burst: { pGoodToBad: 0.02, pBadToGood: 0.4 },
      reorderRate: 0.01,
      duplicateRate: 0.005,
      corruptRate: 0.002,
    },
  },
  satelite: {
    id: "satelite",
    label: "Satélite",
    hint: "Propagación alta, pérdida leve.",
    params: {
      latencyUs: 250_000,
      jitterUs: 10_000,
      lossRate: 0.005,
      reorderRate: 0,
      duplicateRate: 0,
      corruptRate: 0.001,
    },
  },
  "wan-congestionada": {
    id: "wan-congestionada",
    label: "Enlace WAN congestionado",
    hint: "Ancho limitado + cola corta: pierde por cola llena.",
    params: {
      latencyUs: 30_000,
      jitterUs: 5000,
      lossRate: 0.01,
      reorderRate: 0.005,
      duplicateRate: 0.002,
      corruptRate: 0.001,
      bandwidthBps: 10_000_000,
      mtuBytes: 1500,
      queueLimit: 10,
    },
  },
};

export const LINK_PRESET_IDS: ReadonlyArray<LinkPresetId> = [
  "lan-ideal",
  "wifi-inestable",
  "satelite",
  "wan-congestionada",
];

/** Replace a cable's params with a preset copy; keeps id and endpoints. */
export function applyLinkPreset(
  topology: Topology,
  linkId: string,
  presetId: LinkPresetId,
): Topology {
  const preset = LINK_PRESETS[presetId];
  if (preset === undefined) {
    throw new Error(`preset desconocido "${presetId}"`);
  }
  let found = false;
  const links = topology.links.map((link) => {
    if (link.id !== linkId) {
      return link;
    }
    found = true;
    const params: LinkParams = { ...preset.params };
    if (preset.params.burst !== undefined) {
      params.burst = { ...preset.params.burst };
    }
    return { ...link, a: { ...link.a }, b: { ...link.b }, params };
  });
  if (!found) {
    throw new Error(`no existe el cable "${linkId}"`);
  }
  return { ...topology, links };
}

/* ------------------------------------------------------------------------- */
/* History (F-84): undo/redo over whole-topology snapshots.                  */
/* ------------------------------------------------------------------------- */

/**
 * Undo/redo over whole-topology snapshots.
 *
 * Several editor handlers mutate `topology` in place (drag, text fields,
 * link params), so snapshots are deep-cloned on the way in and on the way
 * out: holding a reference never observes a later edit. `structuredClone`
 * (not JSON) keeps `undefined` keys and refuses the unserializable
 * `Infinity` the core uses as its queue default — the editor only ever
 * stores `undefined` for "unset".
 */
export interface TopologyHistory {
  past: Array<Topology>;
  future: Array<Topology>;
}

/** Max undo steps kept; older snapshots drop off the front. */
export const HISTORY_LIMIT = 100;

export function createHistory(): TopologyHistory {
  return { past: [], future: [] };
}

/** Record the pre-mutation snapshot; any redo stack is discarded. */
export function historyPush(
  history: TopologyHistory,
  snapshot: Topology,
  limit: number = HISTORY_LIMIT,
): TopologyHistory {
  const past = [...history.past, structuredClone(snapshot)];
  while (past.length > limit) {
    past.shift();
  }
  return { past, future: [] };
}

/** Step back; the live state moves to the redo stack. Null when empty. */
export function historyUndo(
  history: TopologyHistory,
  current: Topology,
): { history: TopologyHistory; snapshot: Topology } | null {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) {
    return null;
  }
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [structuredClone(current), ...history.future],
    },
    snapshot: structuredClone(previous),
  };
}

/** Step forward; the live state moves back to the undo stack. Null when empty. */
export function historyRedo(
  history: TopologyHistory,
  current: Topology,
): { history: TopologyHistory; snapshot: Topology } | null {
  const next = history.future[0];
  if (next === undefined) {
    return null;
  }
  return {
    history: {
      past: [...history.past, structuredClone(current)],
      future: history.future.slice(1),
    },
    snapshot: structuredClone(next),
  };
}

export function canUndoHistory(history: TopologyHistory): boolean {
  return history.past.length > 0;
}

export function canRedoHistory(history: TopologyHistory): boolean {
  return history.future.length > 0;
}

/* ------------------------------------------------------------------------- */
/* Duplicate (F-84): copy/paste nodes with their internal cables.            */
/* ------------------------------------------------------------------------- */

export interface DuplicateResult {
  topology: Topology;
  /** Fresh names, in the order requested. */
  names: Array<string>;
  /** Fresh cable ids for the kept internal cables. */
  linkIds: Array<string>;
}

/**
 * Duplicate nodes by name, with their internal cables.
 *
 * Fresh names come from `addNode` (never collides) and fresh MACs from
 * `nextMac` over the live set (never reused); positions shift by (dx, dy).
 * Only cables with both endpoints inside the duplicated set are kept, with
 * endpoints remapped and params cloned. Everything else — IPs, routes,
 * VLANs, impairments — travels verbatim, including duplicates.
 */
export function duplicateNodes(
  topology: Topology,
  names: Array<string>,
  dx = 32,
  dy = 32,
): DuplicateResult {
  let current = topology;
  const nameMap = new Map<string, string>();
  const freshNames: Array<string> = [];
  for (const name of names) {
    const src = current.nodes.find((node) => node.name === name);
    if (src === undefined) {
      throw new Error(`no existe el dispositivo "${name}"`);
    }
    const placed = addNode(current, src.kind, src.x + dx, src.y + dy);
    current = placed.topology;
    const macs = allMacs(current);
    const clone: TopologyNode = structuredClone(src);
    clone.name = placed.name;
    const at = current.nodes.find((node) => node.name === placed.name);
    clone.x = at?.x ?? src.x + dx;
    clone.y = at?.y ?? src.y + dy;
    for (const iface of clone.interfaces) {
      const mac = nextMac(macs);
      macs.add(mac);
      iface.mac = mac;
    }
    current = {
      ...current,
      nodes: current.nodes.map((node) =>
        node.name === placed.name ? clone : node,
      ),
    };
    nameMap.set(name, placed.name);
    freshNames.push(placed.name);
  }
  const wanted = new Set(names);
  const linkIds: Array<string> = [];
  for (const src of topology.links) {
    if (!wanted.has(src.a.node) || !wanted.has(src.b.node)) {
      continue;
    }
    const a = nameMap.get(src.a.node);
    const b = nameMap.get(src.b.node);
    if (a === undefined || b === undefined) {
      continue;
    }
    const added = addLink(
      current,
      { node: a, iface: src.a.iface },
      { node: b, iface: src.b.iface },
    );
    current = added.topology;
    const params: LinkParams = { ...src.params };
    if (src.params.burst !== undefined) {
      params.burst = { ...src.params.burst };
    }
    current = {
      ...current,
      links: current.links.map((link) =>
        link.id === added.id ? { ...link, params } : link,
      ),
    };
    linkIds.push(added.id);
  }
  return { topology: current, names: freshNames, linkIds };
}

/* ------------------------------------------------------------------------- */
/* Align (F-84): snap node edges/centers to a shared line.                   */
/* ------------------------------------------------------------------------- */

export type AlignMode =
  | "left"
  | "centerX"
  | "right"
  | "top"
  | "centerY"
  | "bottom";

export const ALIGN_MODES: ReadonlyArray<AlignMode> = [
  "left",
  "centerX",
  "right",
  "top",
  "centerY",
  "bottom",
];

/**
 * Move the named nodes to a shared x/y, returning a new topology.
 * Unknown names are ignored; with fewer than two matches the topology is
 * returned untouched (no-op, so the UI can skip the undo step).
 */
export function alignNodes(
  topology: Topology,
  names: Array<string>,
  mode: AlignMode,
): Topology {
  const targets = new Set(
    topology.nodes
      .filter((node) => names.includes(node.name))
      .map((node) => node.name),
  );
  if (targets.size < 2) {
    return topology;
  }
  const placed = new Map(
    topology.nodes
      .filter((node) => targets.has(node.name))
      .map((node) => [node.name, node] as const),
  );
  const at = (name: string): number => {
    const node = placed.get(name);
    if (node === undefined) {
      throw new Error(`no existe el dispositivo "${name}"`);
    }
    return mode === "left" || mode === "centerX" || mode === "right"
      ? node.x
      : node.y;
  };
  const size =
    mode === "left" || mode === "centerX" || mode === "right"
      ? NODE_WIDTH
      : NODE_HEIGHT;
  const edges = [...targets].map((name) => at(name));
  const lines = [...targets].map((name) => at(name) + size);
  const min = Math.min(...edges);
  const max = Math.max(...lines);
  const mean = (values: Array<number>): number =>
    values.reduce((acc, value) => acc + value, 0) / values.length;
  const line = (() => {
    switch (mode) {
      case "left":
      case "top":
        return min;
      case "right":
      case "bottom":
        return max - size;
      case "centerX":
      case "centerY":
        return Math.round(
          mean([...targets].map((name) => at(name) + size / 2)) - size / 2,
        );
    }
  })();
  return {
    ...topology,
    nodes: topology.nodes.map((node) => {
      if (!targets.has(node.name)) {
        return node;
      }
      return mode === "left" || mode === "centerX" || mode === "right"
        ? { ...node, x: line }
        : { ...node, y: line };
    }),
  };
}

/* ------------------------------------------------------------------------- */
/* Templates (F-86): starter topologies for the editor canvas.               */
/* ------------------------------------------------------------------------- */

export type TemplateId =
  | "lan-simple"
  | "dos-subredes"
  | "vlan-aislamiento"
  | "dmz";

export interface TemplateInfo {
  id: TemplateId;
  label: string;
  description: string;
}

export const TEMPLATE_IDS: ReadonlyArray<TemplateId> = [
  "lan-simple",
  "dos-subredes",
  "vlan-aislamiento",
  "dmz",
];

export const TEMPLATES: Record<TemplateId, TemplateInfo> = {
  "lan-simple": {
    id: "lan-simple",
    label: "LAN simple",
    description: "Dos hosts y un switch con intercambio de tramas.",
  },
  "dos-subredes": {
    id: "dos-subredes",
    label: "Dos subredes con router",
    description: "h1 → r1 → h2 con traceroute y ping.",
  },
  "vlan-aislamiento": {
    id: "vlan-aislamiento",
    label: "Red con VLANs",
    description: "Dos switches con access 10/20, trunk y aislamiento.",
  },
  dmz: {
    id: "dmz",
    label: "Red con DMZ",
    description: "WAN, DMZ y LAN tras un router de tres puertos.",
  },
};

function templateHost(
  name: string,
  x: number,
  y: number,
  mac: string,
  ip: string,
  mask: string,
  gateway: string,
  hostOpts: TopologyNode["hostOpts"] = null,
): TopologyNode {
  return {
    name,
    kind: "host",
    x,
    y,
    interfaces: [
      {
        name: "eth0",
        mac,
        ip,
        mask,
        prefixLength: "",
        gateway,
        mtu: "",
        vlan: null,
      },
    ],
    routes: [],
    hostOpts,
    agingTimeUs: "",
  };
}

function templateSwitch(
  name: string,
  x: number,
  y: number,
  ports: Array<{ name: string; mac: string; vlan: TopologyVlan | null }>,
): TopologyNode {
  return {
    name,
    kind: "switch",
    x,
    y,
    interfaces: ports.map((port) => ({
      name: port.name,
      mac: port.mac,
      ip: "",
      mask: "",
      prefixLength: "",
      gateway: "",
      mtu: "",
      vlan: port.vlan === null ? null : { ...port.vlan },
    })),
    routes: [],
    hostOpts: null,
    agingTimeUs: "",
  };
}

function templateRouter(
  name: string,
  x: number,
  y: number,
  ports: Array<{ name: string; mac: string; ip: string }>,
): TopologyNode {
  return {
    name,
    kind: "router",
    x,
    y,
    interfaces: ports.map((port) => ({
      name: port.name,
      mac: port.mac,
      ip: port.ip,
      mask: "",
      prefixLength: "24",
      gateway: "",
      mtu: "",
      vlan: null,
    })),
    routes: [],
    hostOpts: null,
    agingTimeUs: "",
  };
}

function templateLink(
  id: string,
  aNode: string,
  aIface: string,
  bNode: string,
  bIface: string,
): TopologyLink {
  return {
    id,
    a: { node: aNode, iface: aIface },
    b: { node: bNode, iface: bIface },
    params: { latencyUs: DEFAULT_LATENCY_US },
  };
}

/** Runnable demo: two hosts on a switch exchanging raw frames. */
function lanSimpleTopology(): Topology {
  return {
    seed: 7,
    until: "2ms",
    nodes: [
      templateHost("h1", 120, 200, "02:00:00:00:00:0a", "10.0.0.1", "", ""),
      templateHost("h2", 370, 200, "02:00:00:00:00:0b", "10.0.0.2", "", ""),
      templateSwitch("sw1", 620, 200, [
        { name: "p1", mac: "02:00:00:00:00:01", vlan: null },
        { name: "p2", mac: "02:00:00:00:00:02", vlan: null },
      ]),
    ],
    links: [
      templateLink("l1", "h1", "eth0", "sw1", "p1"),
      templateLink("l2", "h2", "eth0", "sw1", "p2"),
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
  };
}

/** Runnable demo: h1 and h2 behind r1's two ports, with traceroute and ping. */
function dosSubredesTopology(): Topology {
  return {
    seed: 11,
    until: "5s",
    nodes: [
      templateHost(
        "h1",
        120,
        200,
        "02:00:00:00:00:0a",
        "10.0.0.2",
        "255.255.255.0",
        "10.0.0.1",
      ),
      templateRouter("r1", 370, 200, [
        { name: "p0", mac: "02:00:00:00:00:01", ip: "10.0.0.1" },
        { name: "p1", mac: "02:00:00:00:00:02", ip: "10.0.1.1" },
      ]),
      templateHost(
        "h2",
        620,
        200,
        "02:00:00:00:00:0b",
        "10.0.1.2",
        "255.255.255.0",
        "10.0.1.1",
      ),
    ],
    links: [
      templateLink("l1", "h1", "eth0", "r1", "p0"),
      templateLink("l2", "h2", "eth0", "r1", "p1"),
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
  };
}

/** Runnable demo: two switches with access 10/20, a trunk, and isolation. */
function vlanAislamientoTopology(): Topology {
  const access = (vlan: string): TopologyVlan => ({
    mode: "access",
    vlan,
    allowed: "",
    native: "",
  });
  const trunk: TopologyVlan = {
    mode: "trunk",
    vlan: "1",
    allowed: "10,20",
    native: "",
  };
  const fastArp: TopologyNode["hostOpts"] = {
    arpTimeoutUs: 200000,
    arpRetries: 1,
  };
  return {
    seed: 5,
    until: "2s",
    nodes: [
      templateHost(
        "h1",
        120,
        200,
        "02:00:00:00:00:0a",
        "10.0.0.2",
        "255.255.255.0",
        "",
        fastArp,
      ),
      templateSwitch("sw1", 370, 200, [
        { name: "p1", mac: "02:00:00:00:00:01", vlan: access("10") },
        { name: "p2", mac: "02:00:00:00:00:02", vlan: access("20") },
        { name: "p3", mac: "02:00:00:00:00:03", vlan: trunk },
      ]),
      templateSwitch("sw2", 620, 200, [
        { name: "p1", mac: "02:00:00:00:00:04", vlan: trunk },
        { name: "p2", mac: "02:00:00:00:00:05", vlan: access("10") },
      ]),
      templateHost(
        "h2",
        870,
        200,
        "02:00:00:00:00:0b",
        "10.0.0.3",
        "255.255.255.0",
        "",
        fastArp,
      ),
      templateHost(
        "h3",
        1120,
        200,
        "02:00:00:00:00:0c",
        "10.0.0.4",
        "255.255.255.0",
        "",
      ),
    ],
    links: [
      templateLink("l1", "h1", "eth0", "sw1", "p1"),
      templateLink("l2", "h2", "eth0", "sw1", "p2"),
      templateLink("l3", "sw1", "p3", "sw2", "p1"),
      templateLink("l4", "h3", "eth0", "sw2", "p2"),
    ],
    actions: [
      {
        at: 0,
        host: "h1",
        destIp: "10.0.0.4",
        ping: { count: 1, size: 8, interval: "1ms" },
      },
      {
        at: "1s",
        host: "h1",
        destIp: "10.0.0.3",
        ping: { count: 1, size: 8, interval: "1ms" },
      },
    ],
  };
}

/**
 * Runnable demo: WAN, DMZ and LAN behind a three-port router. h1 lives on
 * the WAN side, h2 is the DMZ server and h3 the LAN host; the router joins
 * the three connected subnets, so the pings cross zones through it.
 */
function dmzTopology(): Topology {
  return {
    seed: 7,
    until: "5s",
    nodes: [
      templateHost(
        "h1",
        120,
        360,
        "02:00:00:00:00:0a",
        "203.0.113.2",
        "255.255.255.0",
        "203.0.113.1",
      ),
      templateRouter("r1", 480, 360, [
        { name: "p0", mac: "02:00:00:00:00:01", ip: "203.0.113.1" },
        { name: "p1", mac: "02:00:00:00:00:02", ip: "10.0.2.1" },
        { name: "p2", mac: "02:00:00:00:00:03", ip: "10.0.1.1" },
      ]),
      templateHost(
        "h2",
        840,
        200,
        "02:00:00:00:00:0b",
        "10.0.2.2",
        "255.255.255.0",
        "10.0.2.1",
      ),
      templateHost(
        "h3",
        840,
        520,
        "02:00:00:00:00:0c",
        "10.0.1.2",
        "255.255.255.0",
        "10.0.1.1",
      ),
    ],
    links: [
      templateLink("l1", "h1", "eth0", "r1", "p0"),
      templateLink("l2", "h2", "eth0", "r1", "p1"),
      templateLink("l3", "h3", "eth0", "r1", "p2"),
    ],
    actions: [
      { at: 0, host: "h1", exec: "traceroute 10.0.1.2" },
      {
        at: "5ms",
        host: "h1",
        destIp: "10.0.1.2",
        ping: { count: 2, size: 32, interval: "1ms" },
      },
      {
        at: "1s",
        host: "h3",
        destIp: "10.0.2.2",
        ping: { count: 1, size: 32, interval: "1ms" },
      },
    ],
  };
}

/** Build a starter topology by id. Throws on unknown ids. */
export function buildTemplate(id: TemplateId): Topology {
  switch (id) {
    case "lan-simple":
      return lanSimpleTopology();
    case "dos-subredes":
      return dosSubredesTopology();
    case "vlan-aislamiento":
      return vlanAislamientoTopology();
    case "dmz":
      return dmzTopology();
    default:
      throw new Error(`plantilla desconocida "${id}"`);
  }
}

export type DeviceKind = "host" | "switch" | "router" | "hub";

export const DEVICE_KINDS: ReadonlyArray<DeviceKind> = [
  "host",
  "switch",
  "router",
  "hub",
];

export const DEVICE_GLYPH: Record<DeviceKind, string> = {
  host: "◻",
  switch: "▤",
  router: "⬡",
  hub: "⊹",
};

export interface TopologyVlan {
  mode: "access" | "trunk";
  /** Access VLAN id (string so the input can be empty while typing). */
  vlan: string;
  /** Trunk allowed VLAN ids, comma separated. Empty means "all". */
  allowed: string;
  /** Trunk native VLAN id. Empty means "none". */
  native: string;
}

export interface TopologyInterface {
  name: string;
  mac: string;
  ip: string;
  mask: string;
  prefixLength: string;
  gateway: string;
  mtu: string;
  /** Only switch ports carry VLAN config; `null` means "schema default". */
  vlan: TopologyVlan | null;
}

export interface TopologyRoute {
  destination: string;
  gateway: string;
  iface: string;
  metric: string;
}

export interface TopologyNode {
  /** Scenario id and canvas label. */
  name: string;
  kind: DeviceKind;
  x: number;
  y: number;
  interfaces: Array<TopologyInterface>;
  routes: Array<TopologyRoute>;
  /** Preserved host tunables from an imported scenario (not editable here). */
  hostOpts: ScenarioHostOpts | null;
  /** Preserved switch aging time from an imported scenario, as text. */
  agingTimeUs: string;
}

export interface TopologyEndpoint {
  node: string;
  iface: string;
}

export interface TopologyLink {
  id: string;
  a: TopologyEndpoint;
  b: TopologyEndpoint;
  /** Full v1 params are preserved on import; the link panel edits them (F-83). */
  params: LinkParams;
}

export interface Topology {
  seed: number;
  until: string;
  nodes: Array<TopologyNode>;
  links: Array<TopologyLink>;
  actions: Array<ScenarioAction>;
}

export type ConnectCheck = { ok: true } | { ok: false; reason: string };

export interface AddLinkResult {
  topology: Topology;
  id: string;
}

export interface AddNodeResult {
  topology: Topology;
  name: string;
}

const NAME_PREFIX: Record<DeviceKind, string> = {
  host: "h",
  switch: "sw",
  router: "r",
  hub: "hub",
};

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);
const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** First free deterministic `02:00:00:00:xx:xx` address. */
export function nextMac(used: Iterable<string>): string {
  const taken = new Set<string>();
  for (const mac of used) {
    taken.add(mac.trim().toLowerCase());
  }
  for (let index = 1; index <= 0xffff; index += 1) {
    const mac = `02:00:00:00:${hex2((index >> 8) & 0xff)}:${hex2(index & 0xff)}`;
    if (!taken.has(mac)) {
      return mac;
    }
  }
  throw new Error("no quedan direcciones MAC libres");
}

function allMacs(topology: Topology): Set<string> {
  const used = new Set<string>();
  for (const node of topology.nodes) {
    for (const iface of node.interfaces) {
      used.add(iface.mac.trim().toLowerCase());
    }
  }
  return used;
}

export function kindLabel(kind: DeviceKind): string {
  return kind;
}

function nextNodeName(kind: DeviceKind, nodes: Array<TopologyNode>): string {
  const names = new Set(nodes.map((node) => node.name));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${NAME_PREFIX[kind]}${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no hay un nombre libre para ${kindLabel(kind)}`);
}

function defaultInterfaceNames(kind: DeviceKind): Array<string> {
  switch (kind) {
    case "host":
      return ["eth0"];
    case "router":
      return ["p0", "p1"];
    case "switch":
    case "hub":
      return ["p1", "p2", "p3", "p4"];
  }
}

function createInterface(
  kind: DeviceKind,
  name: string,
  mac: string,
): TopologyInterface {
  return {
    name,
    mac,
    ip: "",
    mask: "",
    prefixLength: kind === "router" ? "24" : "",
    gateway: "",
    mtu: "",
    vlan: null,
  };
}

function nextInterfaceName(node: TopologyNode): string {
  const prefix = node.kind === "host" ? "eth" : "p";
  const names = new Set(node.interfaces.map((iface) => iface.name));
  for (let index = node.kind === "host" ? 0 : 1; index < 1000; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${node.name}: no hay un nombre de interfaz libre`);
}

function requireNode(topology: Topology, name: string): TopologyNode {
  const node = topology.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) {
    throw new Error(`no existe el dispositivo "${name}"`);
  }
  return node;
}

export function interfaceAnchor(
  node: TopologyNode,
  ifaceName: string,
): { x: number; y: number } | null {
  const index = node.interfaces.findIndex((iface) => iface.name === ifaceName);
  if (index < 0) {
    return null;
  }
  const count = node.interfaces.length;
  return {
    x: node.x + (NODE_WIDTH * (index + 1)) / (count + 1),
    y: node.y + NODE_HEIGHT,
  };
}

function endpointLabel(endpoint: TopologyEndpoint): string {
  return `${endpoint.node}:${endpoint.iface}`;
}

export function interfaceLink(
  topology: Topology,
  endpoint: TopologyEndpoint,
): TopologyLink | null {
  for (const link of topology.links) {
    const onA =
      link.a.node === endpoint.node && link.a.iface === endpoint.iface;
    const onB =
      link.b.node === endpoint.node && link.b.iface === endpoint.iface;
    if (onA || onB) {
      return link;
    }
  }
  return null;
}

/**
 * Cable validation (S2).
 *
 * - both ends can never be the same interface;
 * - a device cannot be cabled to itself;
 * - an interface carries at most one cable;
 * - a host needs a switch/router/hub port on the other side.
 */
export function canConnect(
  topology: Topology,
  a: TopologyEndpoint,
  b: TopologyEndpoint,
): ConnectCheck {
  const nodeA = topology.nodes.find((node) => node.name === a.node);
  const nodeB = topology.nodes.find((node) => node.name === b.node);
  if (nodeA === undefined) {
    return { ok: false, reason: `no existe el dispositivo "${a.node}"` };
  }
  if (nodeB === undefined) {
    return { ok: false, reason: `no existe el dispositivo "${b.node}"` };
  }
  if (!nodeA.interfaces.some((iface) => iface.name === a.iface)) {
    return {
      ok: false,
      reason: `${a.node} no tiene la interfaz "${a.iface}"`,
    };
  }
  if (!nodeB.interfaces.some((iface) => iface.name === b.iface)) {
    return {
      ok: false,
      reason: `${b.node} no tiene la interfaz "${b.iface}"`,
    };
  }
  if (a.node === b.node && a.iface === b.iface) {
    return {
      ok: false,
      reason: `no se puede conectar ${endpointLabel(a)} consigo misma`,
    };
  }
  if (a.node === b.node) {
    return {
      ok: false,
      reason: `no se pueden cablear dos interfaces de ${a.node}`,
    };
  }
  const linkA = interfaceLink(topology, a);
  if (linkA !== null) {
    return {
      ok: false,
      reason: `${endpointLabel(a)} ya está conectada por ${linkA.id}`,
    };
  }
  const linkB = interfaceLink(topology, b);
  if (linkB !== null) {
    return {
      ok: false,
      reason: `${endpointLabel(b)} ya está conectada por ${linkB.id}`,
    };
  }
  if (nodeA.kind === "host" && nodeB.kind === "host") {
    return {
      ok: false,
      reason: "un host se conecta a un puerto de switch, router o hub",
    };
  }
  return { ok: true };
}

function nextLinkId(topology: Topology): string {
  const ids = new Set(topology.links.map((link) => link.id));
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `l${index}`;
    if (!ids.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("no hay un id de cable libre");
}

export function addNode(
  topology: Topology,
  kind: DeviceKind,
  x: number,
  y: number,
): AddNodeResult {
  const name = nextNodeName(kind, topology.nodes);
  const used = allMacs(topology);
  const interfaces = defaultInterfaceNames(kind).map((ifaceName) => {
    const mac = nextMac(used);
    used.add(mac);
    return createInterface(kind, ifaceName, mac);
  });
  const node: TopologyNode = {
    name,
    kind,
    x,
    y,
    interfaces,
    routes: [],
    hostOpts: null,
    agingTimeUs: "",
  };
  return {
    topology: { ...topology, nodes: [...topology.nodes, node] },
    name,
  };
}

export function addInterface(
  topology: Topology,
  nodeName: string,
): { topology: Topology; name: string } {
  const node = requireNode(topology, nodeName);
  const name = nextInterfaceName(node);
  const iface = createInterface(node.kind, name, nextMac(allMacs(topology)));
  const nextNode: TopologyNode = {
    ...node,
    interfaces: [...node.interfaces, iface],
  };
  return {
    topology: {
      ...topology,
      nodes: topology.nodes.map((candidate) =>
        candidate.name === nodeName ? nextNode : candidate,
      ),
    },
    name,
  };
}

export function removeInterface(
  topology: Topology,
  nodeName: string,
  ifaceName: string,
): Topology {
  const node = requireNode(topology, nodeName);
  if (!node.interfaces.some((iface) => iface.name === ifaceName)) {
    throw new Error(`${nodeName} no tiene la interfaz "${ifaceName}"`);
  }
  const links = topology.links.filter(
    (link) =>
      !(
        (link.a.node === nodeName && link.a.iface === ifaceName) ||
        (link.b.node === nodeName && link.b.iface === ifaceName)
      ),
  );
  const nextNode: TopologyNode = {
    ...node,
    interfaces: node.interfaces.filter((iface) => iface.name !== ifaceName),
    routes: node.routes.filter((route) => route.iface !== ifaceName),
  };
  return {
    ...topology,
    links,
    nodes: topology.nodes.map((candidate) =>
      candidate.name === nodeName ? nextNode : candidate,
    ),
  };
}

export function renameInterface(
  topology: Topology,
  nodeName: string,
  from: string,
  to: string,
): Topology {
  const nextName = to.trim();
  if (nextName === "") {
    throw new Error("el nombre de la interfaz no puede estar vacío");
  }
  const node = requireNode(topology, nodeName);
  if (!node.interfaces.some((iface) => iface.name === from)) {
    throw new Error(`${nodeName} no tiene la interfaz "${from}"`);
  }
  if (from === nextName) {
    return topology;
  }
  if (node.interfaces.some((iface) => iface.name === nextName)) {
    throw new Error(`${nodeName} ya tiene una interfaz "${nextName}"`);
  }
  const rename = (endpoint: TopologyEndpoint): TopologyEndpoint =>
    endpoint.node === nodeName && endpoint.iface === from
      ? { ...endpoint, iface: nextName }
      : endpoint;
  const nextNode: TopologyNode = {
    ...node,
    interfaces: node.interfaces.map((iface) =>
      iface.name === from ? { ...iface, name: nextName } : iface,
    ),
    routes: node.routes.map((route) =>
      route.iface === from ? { ...route, iface: nextName } : route,
    ),
  };
  return {
    ...topology,
    nodes: topology.nodes.map((candidate) =>
      candidate.name === nodeName ? nextNode : candidate,
    ),
    links: topology.links.map((link) => ({
      ...link,
      a: rename(link.a),
      b: rename(link.b),
    })),
  };
}

function withActionHost(action: ScenarioAction, host: string): ScenarioAction {
  if ("exec" in action) {
    return { ...action, host };
  }
  if ("ping" in action) {
    return { ...action, host };
  }
  return { ...action, host };
}

export function renameNode(
  topology: Topology,
  from: string,
  to: string,
): Topology {
  const nextName = to.trim();
  if (nextName === "") {
    throw new Error("el nombre del dispositivo no puede estar vacío");
  }
  requireNode(topology, from);
  if (from === nextName) {
    return topology;
  }
  if (topology.nodes.some((node) => node.name === nextName)) {
    throw new Error(`ya existe un dispositivo "${nextName}"`);
  }
  const rename = (endpoint: TopologyEndpoint): TopologyEndpoint =>
    endpoint.node === from ? { ...endpoint, node: nextName } : endpoint;
  return {
    ...topology,
    nodes: topology.nodes.map((node) =>
      node.name === from ? { ...node, name: nextName } : node,
    ),
    links: topology.links.map((link) => ({
      ...link,
      a: rename(link.a),
      b: rename(link.b),
    })),
    actions: topology.actions.map((action) =>
      action.host === from ? withActionHost(action, nextName) : action,
    ),
  };
}

export function removeNode(topology: Topology, name: string): Topology {
  requireNode(topology, name);
  return {
    ...topology,
    nodes: topology.nodes.filter((node) => node.name !== name),
    links: topology.links.filter(
      (link) => link.a.node !== name && link.b.node !== name,
    ),
    actions: topology.actions.filter((action) => action.host !== name),
  };
}

export function addLink(
  topology: Topology,
  a: TopologyEndpoint,
  b: TopologyEndpoint,
): AddLinkResult {
  const check = canConnect(topology, a, b);
  if (!check.ok) {
    throw new Error(check.reason);
  }
  const id = nextLinkId(topology);
  return {
    topology: {
      ...topology,
      links: [
        ...topology.links,
        {
          id,
          a: { ...a },
          b: { ...b },
          params: { latencyUs: DEFAULT_LATENCY_US },
        },
      ],
    },
    id,
  };
}

export function removeLink(topology: Topology, id: string): Topology {
  return {
    ...topology,
    links: topology.links.filter((link) => link.id !== id),
  };
}

export function addRoute(
  topology: Topology,
  nodeName: string,
  destination = "10.0.0.0/24",
): Topology {
  const node = requireNode(topology, nodeName);
  const iface = node.interfaces[0];
  const route: TopologyRoute = {
    destination,
    gateway: "",
    iface: iface?.name ?? "",
    metric: "",
  };
  const nextNode: TopologyNode = { ...node, routes: [...node.routes, route] };
  return {
    ...topology,
    nodes: topology.nodes.map((candidate) =>
      candidate.name === nodeName ? nextNode : candidate,
    ),
  };
}

export function removeRoute(
  topology: Topology,
  nodeName: string,
  index: number,
): Topology {
  const node = requireNode(topology, nodeName);
  const nextNode: TopologyNode = {
    ...node,
    routes: node.routes.filter((_, routeIndex) => routeIndex !== index),
  };
  return {
    ...topology,
    nodes: topology.nodes.map((candidate) =>
      candidate.name === nodeName ? nextNode : candidate,
    ),
  };
}

// ---------------------------------------------------------------------------
// Editor model -> scenario v1
// ---------------------------------------------------------------------------

function fail(path: string, why: string): Error {
  return new Error(`${path}: ${why}`);
}

function requireText(value: string, path: string): string {
  const text = value.trim();
  if (text === "") {
    throw fail(path, "no puede estar vacío");
  }
  return text;
}

function optionalText(value: string): string | undefined {
  const text = value.trim();
  return text === "" ? undefined : text;
}

function parseInteger(
  value: string,
  path: string,
  min: number,
  max: number,
): number | undefined {
  const text = value.trim();
  if (text === "") {
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw fail(path, `se esperaba un entero, no "${value}"`);
  }
  const parsed = Number.parseInt(text, 10);
  if (parsed < min || parsed > max) {
    throw fail(path, `fuera de rango ${min}..${max}: ${parsed}`);
  }
  return parsed;
}

function assertIpv4(value: string, path: string): void {
  if (!IPV4_RE.test(value.trim())) {
    throw fail(path, `IPv4 inválida "${value}"`);
  }
}

function assertCidr(value: string, path: string): void {
  const slash = value.indexOf("/");
  if (slash < 0 || value.indexOf("/", slash + 1) >= 0) {
    throw fail(path, `CIDR inválido "${value}" (esperado a.b.c.d/n)`);
  }
  assertIpv4(value.slice(0, slash), path);
  const prefix = value.slice(slash + 1);
  if (!/^\d+$/.test(prefix) || Number.parseInt(prefix, 10) > 32) {
    throw fail(path, `prefijo inválido en "${value}"`);
  }
}

function macToScenario(value: string, path: string): string | undefined {
  const mac = optionalText(value);
  if (mac === undefined) {
    return undefined;
  }
  if (!MAC_RE.test(mac)) {
    throw fail(path, `MAC inválida "${value}"`);
  }
  return mac.toLowerCase();
}

function interfaceNameToScenario(value: string, path: string): string {
  const name = requireText(value, `${path}.name`);
  if (/\s/.test(name)) {
    throw fail(`${path}.name`, "no puede contener espacios");
  }
  return name;
}

function hostInterfaceToScenario(
  iface: TopologyInterface,
  path: string,
): ScenarioInterfaceDef {
  const def: ScenarioInterfaceDef = {
    name: interfaceNameToScenario(iface.name, path),
  };
  const ip = iface.ip.trim();
  const mask = iface.mask.trim();
  const prefix = parseInteger(
    iface.prefixLength,
    `${path}.prefixLength`,
    0,
    32,
  );
  const gateway = iface.gateway.trim();
  if (ip === "") {
    if (mask !== "" || prefix !== undefined || gateway !== "") {
      throw fail(path, "máscara, prefijo y gateway requieren una IP");
    }
  } else if (ip.includes("/")) {
    assertCidr(ip, `${path}.ip`);
    if (mask !== "" || prefix !== undefined) {
      throw fail(path, "la IP ya trae prefijo; quitá máscara o prefijo");
    }
  } else {
    assertIpv4(ip, `${path}.ip`);
  }
  const mac = macToScenario(iface.mac, `${path}.mac`);
  if (mac !== undefined) {
    def.mac = mac;
  }
  if (ip !== "") {
    def.ip = ip;
  }
  if (mask !== "") {
    assertIpv4(mask, `${path}.mask`);
    def.mask = mask;
  }
  if (prefix !== undefined) {
    def.prefixLength = prefix;
  }
  if (gateway !== "") {
    assertIpv4(gateway, `${path}.gateway`);
    def.gateway = gateway;
  }
  return def;
}

function routerInterfaceToScenario(
  iface: TopologyInterface,
  path: string,
): ScenarioRouterPortDef {
  const ip = requireText(iface.ip, `${path}.ip`);
  const mask = iface.mask.trim();
  const prefix = parseInteger(
    iface.prefixLength,
    `${path}.prefixLength`,
    0,
    32,
  );
  if (ip.includes("/")) {
    assertCidr(ip, `${path}.ip`);
    if (mask !== "" || prefix !== undefined) {
      throw fail(path, "la IP ya trae prefijo; quitá máscara o prefijo");
    }
  } else {
    assertIpv4(ip, `${path}.ip`);
    if (mask === "" && prefix === undefined) {
      throw fail(path, "indicá prefijo o máscara para el puerto del router");
    }
  }
  const def: ScenarioRouterPortDef = {
    name: interfaceNameToScenario(iface.name, path),
    ip,
  };
  const mac = macToScenario(iface.mac, `${path}.mac`);
  if (mac !== undefined) {
    def.mac = mac;
  }
  if (mask !== "") {
    assertIpv4(mask, `${path}.mask`);
    def.mask = mask;
  }
  if (prefix !== undefined) {
    def.prefixLength = prefix;
  }
  const mtu = parseInteger(iface.mtu, `${path}.mtu`, 68, 65535);
  if (mtu !== undefined) {
    def.mtu = mtu;
  }
  return def;
}

function vlanToScenario(
  vlan: TopologyVlan,
  path: string,
): ScenarioVlanPortConfig {
  const def: ScenarioVlanPortConfig = { mode: vlan.mode };
  if (vlan.mode === "access") {
    def.vlan = parseInteger(vlan.vlan, `${path}.vlan`, 1, 4094) ?? 1;
    return def;
  }
  const allowed: Array<number> = [];
  for (const raw of vlan.allowed.split(/[,\s]+/)) {
    const text = raw.trim();
    if (text === "") {
      continue;
    }
    if (!/^\d+$/.test(text)) {
      throw fail(`${path}.allowed`, `VLAN inválida "${raw}"`);
    }
    const id = Number.parseInt(text, 10);
    if (id < 1 || id > 4094) {
      throw fail(`${path}.allowed`, `VLAN fuera de 1..4094: ${id}`);
    }
    if (!allowed.includes(id)) {
      allowed.push(id);
    }
  }
  if (allowed.length > 0) {
    def.allowed = allowed;
  }
  const native = parseInteger(vlan.native, `${path}.native`, 1, 4094);
  if (native !== undefined) {
    if (allowed.length > 0 && !allowed.includes(native)) {
      throw fail(
        `${path}.native`,
        `la VLAN nativa ${native} no está en allowed`,
      );
    }
    def.native = native;
  }
  return def;
}

function portToScenario(
  iface: TopologyInterface,
  kind: "switch" | "hub",
  path: string,
): ScenarioPortDef {
  const def: ScenarioPortDef = {
    name: interfaceNameToScenario(iface.name, path),
  };
  const mac = macToScenario(iface.mac, `${path}.mac`);
  if (mac !== undefined) {
    def.mac = mac;
  }
  if (kind === "switch" && iface.vlan !== null) {
    def.vlan = vlanToScenario(iface.vlan, `${path}.vlan`);
  }
  return def;
}

function routeToScenario(
  route: TopologyRoute,
  node: TopologyNode,
  path: string,
): ScenarioRouteDef {
  const destination = requireText(route.destination, `${path}.destination`);
  assertCidr(destination, `${path}.destination`);
  const iface = requireText(route.iface, `${path}.iface`);
  if (!node.interfaces.some((candidate) => candidate.name === iface)) {
    throw fail(`${path}.iface`, `${node.name} no tiene la interfaz "${iface}"`);
  }
  const def: ScenarioRouteDef = { destination, iface };
  const gateway = route.gateway.trim();
  if (gateway !== "") {
    assertIpv4(gateway, `${path}.gateway`);
    def.gateway = gateway;
  }
  const metric = parseInteger(route.metric, `${path}.metric`, 0, 2_147_483_647);
  if (metric !== undefined) {
    def.metric = metric;
  }
  return def;
}

function assertUniqueInterfaceNames(node: TopologyNode, path: string): void {
  const names = new Set<string>();
  for (const iface of node.interfaces) {
    const name = requireText(iface.name, `${path}.interfaces`);
    if (names.has(name)) {
      throw fail(path, `interfaz duplicada "${name}" en ${node.name}`);
    }
    names.add(name);
  }
}

function nodeToScenario(node: TopologyNode, path: string): ScenarioNode {
  if (node.name.trim() === "") {
    throw fail(path, "falta el nombre del dispositivo");
  }
  if (node.interfaces.length === 0) {
    throw fail(path, `${node.name} necesita al menos una interfaz`);
  }
  assertUniqueInterfaceNames(node, path);
  if (node.kind === "host") {
    const out: ScenarioNode = {
      type: "host",
      id: node.name,
      interfaces: node.interfaces.map((iface, index) =>
        hostInterfaceToScenario(iface, `${path}.interfaces[${index}]`),
      ),
    };
    if (node.hostOpts !== null) {
      out.hostOpts = { ...node.hostOpts };
    }
    return out;
  }
  if (node.kind === "switch") {
    const out: ScenarioNode = {
      type: "switch",
      id: node.name,
      ports: node.interfaces.map((iface, index) =>
        portToScenario(iface, "switch", `${path}.ports[${index}]`),
      ),
    };
    const aging = parseInteger(
      node.agingTimeUs,
      `${path}.agingTimeUs`,
      0,
      2_147_483_647,
    );
    if (aging !== undefined) {
      out.agingTimeUs = aging;
    }
    return out;
  }
  if (node.kind === "hub") {
    return {
      type: "hub",
      id: node.name,
      ports: node.interfaces.map((iface, index) =>
        portToScenario(iface, "hub", `${path}.ports[${index}]`),
      ),
    };
  }
  const out: ScenarioNode = {
    type: "router",
    id: node.name,
    interfaces: node.interfaces.map((iface, index) =>
      routerInterfaceToScenario(iface, `${path}.interfaces[${index}]`),
    ),
  };
  if (node.routes.length > 0) {
    out.routes = node.routes.map((route, index) =>
      routeToScenario(route, node, `${path}.routes[${index}]`),
    );
  }
  return out;
}

function endpointToScenario(
  endpoint: TopologyEndpoint,
  nodes: Array<TopologyNode>,
  path: string,
): TopologyEndpoint {
  const node = nodes.find((candidate) => candidate.name === endpoint.node);
  if (node === undefined) {
    throw fail(path, `no existe el dispositivo "${endpoint.node}"`);
  }
  if (!node.interfaces.some((iface) => iface.name === endpoint.iface)) {
    throw fail(path, `${node.name} no tiene la interfaz "${endpoint.iface}"`);
  }
  return { node: endpoint.node, iface: endpoint.iface };
}

function linkToScenario(
  link: TopologyLink,
  nodes: Array<TopologyNode>,
  path: string,
): ScenarioLink {
  const id = requireText(link.id, `${path}.id`);
  validateLinkParams(link.params, path);
  return {
    id,
    a: endpointToScenario(link.a, nodes, `${path}.a`),
    b: endpointToScenario(link.b, nodes, `${path}.b`),
    params: { ...link.params },
  };
}

/**
 * Early gate mirroring the core `resolveParams` ranges, so a bad preset or
 * hand edit fails here with a field path instead of inside `netlab run`.
 * `queueLimit` admits only a positive integer when set: the in-memory
 * `Infinity` default has no JSON representation (`null` after stringify).
 */
function validateLinkParams(params: LinkParams, path: string): void {
  const base = `${path}.params`;
  if (!Number.isFinite(params.latencyUs) || params.latencyUs < 0) {
    throw fail(`${base}.latencyUs`, `latencia inválida: ${params.latencyUs}`);
  }
  if (
    params.jitterUs !== undefined &&
    (!Number.isFinite(params.jitterUs) || params.jitterUs < 0)
  ) {
    throw fail(`${base}.jitterUs`, `jitter inválido: ${params.jitterUs}`);
  }
  for (const name of [
    "lossRate",
    "reorderRate",
    "duplicateRate",
    "corruptRate",
  ] as const) {
    const value = params[name];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value < 0 || value > 1)
    ) {
      throw fail(`${base}.${name}`, `probabilidad inválida: ${value}`);
    }
  }
  if (params.burst !== undefined) {
    for (const name of ["pGoodToBad", "pBadToGood"] as const) {
      const value = params.burst[name];
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw fail(`${base}.burst.${name}`, `probabilidad inválida: ${value}`);
      }
    }
  }
  if (
    params.bandwidthBps !== undefined &&
    (!Number.isFinite(params.bandwidthBps) || params.bandwidthBps <= 0)
  ) {
    throw fail(
      `${base}.bandwidthBps`,
      `ancho de banda inválido: ${params.bandwidthBps}`,
    );
  }
  if (
    params.mtuBytes !== undefined &&
    (!Number.isInteger(params.mtuBytes) || params.mtuBytes <= 0)
  ) {
    throw fail(`${base}.mtuBytes`, `MTU inválida: ${params.mtuBytes}`);
  }
  if (
    params.queueLimit !== undefined &&
    (!Number.isInteger(params.queueLimit) || params.queueLimit <= 0)
  ) {
    throw fail(
      `${base}.queueLimit`,
      `límite de cola inválido: ${params.queueLimit}`,
    );
  }
}

function actionToScenario(
  action: ScenarioAction,
  nodes: Array<TopologyNode>,
  path: string,
): ScenarioAction {
  const host = nodes.find((node) => node.name === action.host);
  if (host === undefined) {
    throw fail(`${path}.host`, `no existe el dispositivo "${action.host}"`);
  }
  if (host.kind !== "host") {
    throw fail(`${path}.host`, `${action.host} no es un host`);
  }
  if ("exec" in action) {
    return { ...action };
  }
  if ("ping" in action) {
    if (
      action.iface !== undefined &&
      !host.interfaces.some((iface) => iface.name === action.iface)
    ) {
      throw fail(`${path}.iface`, `${action.host} no tiene "${action.iface}"`);
    }
    return { ...action, ping: { ...action.ping } };
  }
  if (!host.interfaces.some((iface) => iface.name === action.iface)) {
    throw fail(`${path}.iface`, `${action.host} no tiene "${action.iface}"`);
  }
  return { ...action };
}

/** Build a schema-shaped scenario from the canvas, rejecting unrunnable input. */
export function topologyToScenario(topology: Topology): Scenario {
  if (!Number.isInteger(topology.seed) || topology.seed < 0) {
    throw new Error(`seed: se esperaba un entero ≥ 0, no ${topology.seed}`);
  }
  const ids = new Set<string>();
  const nodes = topology.nodes.map((node, index) => {
    if (ids.has(node.name)) {
      throw new Error(`nodes[${index}]: id duplicado "${node.name}"`);
    }
    ids.add(node.name);
    return nodeToScenario(node, `nodes[${index}]`);
  });
  const usedEndpoints = new Set<string>();
  const links = topology.links.map((link, index) => {
    const path = `links[${index}]`;
    const out = linkToScenario(link, topology.nodes, path);
    for (const [side, endpoint] of [
      ["a", out.a],
      ["b", out.b],
    ] as const) {
      const key = `${endpoint.node}:${endpoint.iface}`;
      if (usedEndpoints.has(key)) {
        throw new Error(
          `${path}.${side}: ${endpoint.node}:${endpoint.iface} ya está conectada`,
        );
      }
      usedEndpoints.add(key);
    }
    return out;
  });
  const actions = topology.actions.map((action, index) =>
    actionToScenario(action, topology.nodes, `actions[${index}]`),
  );
  const scenario: Scenario = {
    version: SCENARIO_VERSION,
    nodes,
    links,
    actions,
    seed: topology.seed,
  };
  const until = topology.until.trim();
  if (until !== "") {
    scenario.until = until;
  }
  return scenario;
}

/**
 * Exportable JSON. `parseScenarioJson()` runs before the text leaves this
 * function, so the download is schema-valid even before `netlab run` sees it.
 */
export function topologyToScenarioJson(topology: Topology): {
  scenario: Scenario;
  json: string;
} {
  const scenario = parseScenarioJson(topologyToScenario(topology));
  return { scenario, json: `${JSON.stringify(scenario, null, 2)}\n` };
}

/** Parse an imported file and rebuild the canvas. */
export function topologyFromJson(text: string): {
  scenario: Scenario;
  topology: Topology;
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `JSON inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const scenario = parseScenarioJson(value);
  return { scenario, topology: scenarioToTopology(scenario) };
}

// ---------------------------------------------------------------------------
// Scenario v1 -> editor model
// ---------------------------------------------------------------------------

function splitCidr(value: string): { ip: string; prefix: string } {
  const slash = value.indexOf("/");
  if (slash < 0) {
    return { ip: value, prefix: "" };
  }
  return { ip: value.slice(0, slash), prefix: value.slice(slash + 1) };
}

function macFromScenario(mac: string | undefined, used: Set<string>): string {
  const explicit = mac?.trim().toLowerCase();
  if (explicit !== undefined && explicit !== "") {
    used.add(explicit);
    return explicit;
  }
  const generated = nextMac(used);
  used.add(generated);
  return generated;
}

function hostInterfaceFromScenario(
  def: ScenarioInterfaceDef,
  used: Set<string>,
): TopologyInterface {
  const split = splitCidr(def.ip ?? "");
  return {
    name: def.name,
    mac: macFromScenario(def.mac, used),
    ip: split.ip,
    mask: def.mask ?? "",
    prefixLength:
      def.prefixLength === undefined ? split.prefix : String(def.prefixLength),
    gateway: def.gateway ?? "",
    mtu: "",
    vlan: null,
  };
}

function routerInterfaceFromScenario(
  def: ScenarioRouterPortDef,
  used: Set<string>,
): TopologyInterface {
  const split = splitCidr(def.ip);
  return {
    name: def.name,
    mac: macFromScenario(def.mac, used),
    ip: split.ip,
    mask: def.mask ?? "",
    prefixLength:
      def.prefixLength === undefined ? split.prefix : String(def.prefixLength),
    gateway: "",
    mtu: def.mtu === undefined ? "" : String(def.mtu),
    vlan: null,
  };
}

function portToModel(
  def: ScenarioPortDef,
  kind: "switch" | "hub",
  used: Set<string>,
): TopologyInterface {
  let vlan: TopologyVlan | null = null;
  if (kind === "switch" && def.vlan !== undefined) {
    vlan = {
      mode: def.vlan.mode ?? "access",
      vlan: String(def.vlan.vlan ?? 1),
      allowed: (def.vlan.allowed ?? []).join(","),
      native: def.vlan.native === undefined ? "" : String(def.vlan.native),
    };
  }
  return {
    name: def.name,
    mac: macFromScenario(def.mac, used),
    ip: "",
    mask: "",
    prefixLength: "",
    gateway: "",
    mtu: "",
    vlan,
  };
}

function cloneAction(action: ScenarioAction): ScenarioAction {
  if ("exec" in action) {
    return { ...action };
  }
  if ("ping" in action) {
    return { ...action, ping: { ...action.ping } };
  }
  return { ...action };
}

const LAYOUT_START_X = 120;
const LAYOUT_START_Y = 120;
const LAYOUT_GAP_X = 250;
const LAYOUT_GAP_Y = 160;

function layoutPositions(count: number): Array<{ x: number; y: number }> {
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(count))));
  const rows = Math.max(1, Math.ceil(count / columns));
  // Keep large imported topologies inside the fixed canvas (there is no zoom).
  const bottom = CANVAS_HEIGHT - NODE_HEIGHT - 24;
  const gapY =
    rows > 1
      ? Math.min(LAYOUT_GAP_Y, (bottom - LAYOUT_START_Y) / (rows - 1))
      : LAYOUT_GAP_Y;
  return Array.from({ length: count }, (_, index) => ({
    x: LAYOUT_START_X + (index % columns) * LAYOUT_GAP_X,
    y: LAYOUT_START_Y + Math.floor(index / columns) * gapY,
  }));
}

function nodeFromScenario(
  def: ScenarioNode,
  position: { x: number; y: number },
  used: Set<string>,
): TopologyNode {
  const base = {
    name: def.id,
    x: position.x,
    y: position.y,
    hostOpts: null,
    agingTimeUs: "",
    routes: [] as Array<TopologyRoute>,
  };
  if (def.type === "host") {
    return {
      ...base,
      kind: "host",
      interfaces: def.interfaces.map((iface) =>
        hostInterfaceFromScenario(iface, used),
      ),
      hostOpts: def.hostOpts === undefined ? null : { ...def.hostOpts },
    };
  }
  if (def.type === "switch") {
    return {
      ...base,
      kind: "switch",
      interfaces: def.ports.map((port) => portToModel(port, "switch", used)),
      agingTimeUs: def.agingTimeUs === undefined ? "" : String(def.agingTimeUs),
    };
  }
  if (def.type === "hub") {
    return {
      ...base,
      kind: "hub",
      interfaces: def.ports.map((port) => portToModel(port, "hub", used)),
    };
  }
  return {
    ...base,
    kind: "router",
    interfaces: def.interfaces.map((iface) =>
      routerInterfaceFromScenario(iface, used),
    ),
    routes: (def.routes ?? []).map((route) => ({
      destination: route.destination,
      gateway: route.gateway ?? "",
      iface: route.iface,
      metric: route.metric === undefined ? "" : String(route.metric),
    })),
  };
}

/** Rebuild nodes, cables and actions from a parsed v1 scenario. */
export function scenarioToTopology(scenario: Scenario): Topology {
  const usedMacs = new Set<string>();
  const positions = layoutPositions(scenario.nodes.length);
  const nodes = scenario.nodes.map((node, index) => {
    const position = positions[index] ?? {
      x: LAYOUT_START_X,
      y: LAYOUT_START_Y,
    };
    return nodeFromScenario(node, position, usedMacs);
  });
  return {
    seed: scenario.seed ?? 0,
    until:
      scenario.until === undefined
        ? ""
        : typeof scenario.until === "number"
          ? String(scenario.until)
          : scenario.until,
    nodes,
    links: scenario.links.map((link) => ({
      id: link.id,
      a: { ...link.a },
      b: { ...link.b },
      params: { ...link.params },
    })),
    actions: scenario.actions.map(cloneAction),
  };
}

export function emptyTopology(): Topology {
  return { seed: 11, until: "5ms", nodes: [], links: [], actions: [] };
}

/**
 * Runnable demo: h1 and h3 behind r1's two left ports, h2 behind the right
 * one, plus a ping from h1 to h3. Mirrors the `dos-subredes` fixture and the
 * 02-canvas artboard layout.
 */
export function exampleTopology(): Topology {
  return {
    seed: 11,
    until: "5ms",
    nodes: [
      {
        name: "h1",
        kind: "host",
        x: 220,
        y: 360,
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:0a",
            ip: "10.0.0.2",
            mask: "255.255.255.0",
            prefixLength: "",
            gateway: "10.0.0.1",
            mtu: "",
            vlan: null,
          },
        ],
        routes: [],
        hostOpts: null,
        agingTimeUs: "",
      },
      {
        name: "r1",
        kind: "router",
        x: 560,
        y: 360,
        interfaces: [
          {
            name: "p0",
            mac: "02:00:00:00:00:01",
            ip: "10.0.0.1",
            mask: "",
            prefixLength: "24",
            gateway: "",
            mtu: "",
            vlan: null,
          },
          {
            name: "p1",
            mac: "02:00:00:00:00:02",
            ip: "10.0.1.1",
            mask: "",
            prefixLength: "24",
            gateway: "",
            mtu: "",
            vlan: null,
          },
          {
            name: "p2",
            mac: "02:00:00:00:00:03",
            ip: "10.0.2.1",
            mask: "",
            prefixLength: "24",
            gateway: "",
            mtu: "",
            vlan: null,
          },
        ],
        routes: [],
        hostOpts: null,
        agingTimeUs: "",
      },
      {
        name: "h2",
        kind: "host",
        x: 900,
        y: 360,
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:0b",
            ip: "10.0.1.2",
            mask: "255.255.255.0",
            prefixLength: "",
            gateway: "10.0.1.1",
            mtu: "",
            vlan: null,
          },
        ],
        routes: [],
        hostOpts: null,
        agingTimeUs: "",
      },
      {
        name: "h3",
        kind: "host",
        x: 560,
        y: 620,
        interfaces: [
          {
            name: "eth0",
            mac: "02:00:00:00:00:0c",
            ip: "10.0.2.2",
            mask: "255.255.255.0",
            prefixLength: "",
            gateway: "10.0.2.1",
            mtu: "",
            vlan: null,
          },
        ],
        routes: [],
        hostOpts: null,
        agingTimeUs: "",
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "r1", iface: "p0" },
        params: { latencyUs: DEFAULT_LATENCY_US },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "r1", iface: "p1" },
        params: { latencyUs: DEFAULT_LATENCY_US },
      },
      {
        id: "l3",
        a: { node: "h3", iface: "eth0" },
        b: { node: "r1", iface: "p2" },
        params: { latencyUs: DEFAULT_LATENCY_US },
      },
    ],
    actions: [
      {
        at: 0,
        host: "h1",
        destIp: "10.0.2.2",
        ping: { count: 2, size: 32, interval: "1ms" },
      },
    ],
  };
}

/** One-line label for the action list in the inspector. */
export function describeAction(action: ScenarioAction): string {
  if ("exec" in action) {
    return `${action.host}$ ${action.exec}`;
  }
  if ("ping" in action) {
    const count = action.ping.count ?? 4;
    return `${action.host} → ${action.destIp} · ping ×${count}`;
  }
  return `${action.host}:${action.iface} → ${action.destIp} · send`;
}
