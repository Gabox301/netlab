/**
 * Scenario JSON (v1) for `netlab run`.
 *
 * The roadmap never defined `TopologyJSON`, so this slice owns the schema:
 * nodes (host/switch/hub), point-to-point links with impairments, and
 * timed actions — traffic (`send`, `ping`, `exec`) plus the fault-injection
 * actions of F-100 (`cut`, `restore`, `restart`, `flushArp`). Everything is
 * serializable — no functions cross the JSON boundary
 * (`HostOptions.onPayload` stays code-side).
 *
 * An action is recognized by its discriminator key, in this order: `cut`,
 * `restore`, `restart`, `flushArp`, `exec`, `ping`, then the `sendTo` shape
 * that needs `iface` + `destIp`. The fault actions therefore never require a
 * `host` field, and every failure keeps its `actions[i]` path.
 */

import type { LinkParams } from "@netlab/core";

/** `until`/`at` as raw microseconds or a duration string (`10s`, `100ms`). */
export type DurationInput = number | string;

/** Default horizon when the scenario sets no `until`: 5 s. */
export const DEFAULT_UNTIL_US = 5_000_000;

/** Wire format version owned by this slice. */
export const SCENARIO_VERSION = 1;

export interface ScenarioInterfaceDef {
  name: string;
  mac?: string;
  ip?: string;
  mask?: string;
  prefixLength?: number;
  gateway?: string;
}

export interface ScenarioRouterPortDef {
  name: string;
  mac?: string;
  ip: string;
  mask?: string;
  prefixLength?: number;
  mtu?: number;
}

export interface ScenarioRouteDef {
  /** CIDR such as `10.0.1.0/24`; `0.0.0.0/0` installs the default route. */
  destination: string;
  gateway?: string;
  iface: string;
  metric?: number;
}

export interface ScenarioPortDef {
  name: string;
  mac?: string;
  vlan?: ScenarioVlanPortConfig;
}

export interface ScenarioVlanPortConfig {
  mode?: "access" | "trunk";
  vlan?: number;
  allowed?: Array<number>;
  native?: number;
}

export interface ScenarioHostOpts {
  arpTtlUs?: number;
  arpTimeoutUs?: number;
  arpRetries?: number;
  arpQueueLimit?: number;
}

export type ScenarioNode =
  | {
      type: "host";
      id: string;
      interfaces: Array<ScenarioInterfaceDef>;
      hostOpts?: ScenarioHostOpts;
    }
  | {
      type: "switch";
      id: string;
      ports: Array<ScenarioPortDef>;
      agingTimeUs?: number;
    }
  | {
      type: "router";
      id: string;
      interfaces: Array<ScenarioRouterPortDef>;
      routes?: Array<ScenarioRouteDef>;
    }
  | {
      type: "hub";
      id: string;
      ports: Array<ScenarioPortDef>;
    };

export interface ScenarioLinkEndpoint {
  node: string;
  iface: string;
}

export interface ScenarioPingOptions {
  /** Requests to send. Default 4. */
  count?: number;
  /** Echo data bytes. Default 56. */
  size?: number;
  /** IP TTL of the probes. Default 64. */
  ttl?: number;
  dontFragment?: boolean;
  /** Spacing between requests. Default "1s". */
  interval?: DurationInput;
}

export interface ScenarioPingAction {
  /** Virtual time of the first request. Default 0. */
  at?: DurationInput;
  host: string;
  iface?: string;
  destIp: string;
  ping: ScenarioPingOptions;
}

export interface ScenarioShellAction {
  /** Virtual time the command runs. Default 0. */
  at?: DurationInput;
  host: string;
  exec: string;
}

/**
 * Compatibility surface for the action editor that predates fault injection
 * (`packages/web`, owned by T5). That editor rewrites the `host` of every
 * action and reads `host` / `iface` / `destIp` from the whole union, so the
 * fault variants accept a `host` they never use and answer `undefined` for
 * the traffic-only fields. The scenario parser reads neither: a fault action
 * targets a link id or a device id in its own key. T5 removes this shim.
 */
interface ScenarioFaultFields {
  host?: string;
  readonly destIp?: undefined;
}

/**
 * Fault injection (F-100): cut one cable. `cut` is the link id.
 * Restoring it is {@link ScenarioRestoreAction}.
 */
export interface ScenarioCutAction extends ScenarioFaultFields {
  /** Virtual time the cable is cut. Default 0. */
  at?: DurationInput;
  cut: string;
  readonly iface?: undefined;
}

/** Fault injection (F-100): plug the cable back in. */
export interface ScenarioRestoreAction extends ScenarioFaultFields {
  /** Virtual time the cable comes back. Default 0. */
  at?: DurationInput;
  restore: string;
  readonly iface?: undefined;
}

/** Fault injection (F-100): power-cycle a host (bounce interfaces + flush ARP). */
export interface ScenarioRestartAction extends ScenarioFaultFields {
  /** Virtual time of the restart. Default 0. */
  at?: DurationInput;
  restart: string;
  readonly iface?: undefined;
}

/** Fault injection (F-100): wipe the ARP cache of one host (and iface). */
export interface ScenarioFlushArpAction extends ScenarioFaultFields {
  /** Virtual time of the flush. Default 0. */
  at?: DurationInput;
  flushArp: string;
  /** Interface to flush; omitted means every interface. */
  iface?: string;
}

export type ScenarioAction =
  | ScenarioSendAction
  | ScenarioPingAction
  | ScenarioShellAction
  | ScenarioCutAction
  | ScenarioRestoreAction
  | ScenarioRestartAction
  | ScenarioFlushArpAction;

export interface ScenarioLink {
  id: string;
  a: ScenarioLinkEndpoint;
  b: ScenarioLinkEndpoint;
  params: LinkParams;
}

export interface ScenarioSendAction {
  /** Virtual time of the send. Default 0. */
  at?: DurationInput;
  host: string;
  iface: string;
  destIp: string;
  /** Default 0x0800 (IPv4). Accepts a number or `"0x0800"` / `"2048"`. */
  etherType?: number | string;
  /** Payload bytes. Default `""`. */
  payload?: string;
  /** How to decode `payload`. Default `"utf8"`. */
  payloadEncoding?: "utf8" | "hex";
}

export interface Scenario {
  version: typeof SCENARIO_VERSION;
  seed?: number;
  until?: DurationInput;
  nodes: Array<ScenarioNode>;
  links: Array<ScenarioLink>;
  actions: Array<ScenarioAction>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, why: string): Error {
  return new Error(`scenario ${path}: ${why}`);
}

function reqRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw fail(path, "must be an object");
  }
  return value;
}

function reqString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw fail(path, `"${key}" must be a non-empty string`);
  }
  return value;
}

function optString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw fail(path, `"${key}" must be a non-empty string`);
  }
  return value;
}

function reqArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Array<unknown> {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw fail(path, `"${key}" must be an array`);
  }
  return value;
}

function optNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw fail(path, `"${key}" must be a finite number`);
  }
  return value;
}

/**
 * Virtual-time duration to microseconds.
 *
 * - number: raw microseconds (must be finite, >= 0).
 * - string: `<amount><unit>` with unit `us|µs|ms|s|m` (default `us`),
 *   e.g. `"10s"` → 10_000_000.
 */
export function parseDurationToUs(
  value: DurationInput | undefined,
  defaultUs: number,
  path = "until",
): number {
  if (value === undefined) {
    return defaultUs;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw fail(path, `duration must be >= 0, got ${value}`);
    }
    return Math.floor(value);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(us|µs|μs|ms|s|m)?\s*$/i.exec(value);
  if (match === null) {
    throw fail(
      path,
      `cannot parse duration ${JSON.stringify(value)} (try "10s", "100ms", "500us" or microseconds as a number)`,
    );
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "us").toLowerCase();
  const factor =
    unit === "us" || unit === "µs" || unit === "μs"
      ? 1
      : unit === "ms"
        ? 1_000
        : unit === "s"
          ? 1_000_000
          : 60_000_000;
  return Math.floor(amount * factor);
}

/** `0x0800` / `"2048"` / `2048` → 0x0800. */
export function parseEtherType(
  value: number | string | undefined,
  path: string,
): number {
  if (value === undefined) {
    return 0x0800;
  }
  const n =
    typeof value === "number"
      ? value
      : /^0x[0-9a-f]+$/i.test(value.trim())
        ? Number.parseInt(value.trim(), 16)
        : /^\d+$/.test(value.trim())
          ? Number.parseInt(value.trim(), 10)
          : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw fail(
      path,
      `etherType must be 0..0xFFFF, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

/** Decode an action payload to bytes. */
export function decodePayload(
  payload: string | undefined,
  encoding: "utf8" | "hex" | undefined,
  path: string,
): Uint8Array {
  const text = payload ?? "";
  const enc = encoding ?? "utf8";
  if (enc === "utf8") {
    return new TextEncoder().encode(text);
  }
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(text)) {
    throw fail(path, `payload must be even-length hex for "hex" encoding`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function parseInterfaceDef(value: unknown, path: string): ScenarioInterfaceDef {
  const obj = reqRecord(value, path);
  const name = reqString(obj, "name", path);
  const def: ScenarioInterfaceDef = { name };
  for (const key of ["mac", "ip", "mask", "gateway"] as const) {
    const text = optString(obj, key, path);
    if (text !== undefined) {
      def[key] = text;
    }
  }
  const prefixLength = optNumber(obj, "prefixLength", path);
  if (prefixLength !== undefined) {
    def.prefixLength = prefixLength;
  }
  return def;
}

function parseRouterPortDef(
  value: unknown,
  path: string,
): ScenarioRouterPortDef {
  const obj = reqRecord(value, path);
  const def: ScenarioRouterPortDef = {
    name: reqString(obj, "name", path),
    ip: reqString(obj, "ip", path),
  };
  const mac = optString(obj, "mac", path);
  if (mac !== undefined) {
    def.mac = mac;
  }
  const mask = optString(obj, "mask", path);
  if (mask !== undefined) {
    def.mask = mask;
  }
  const prefixLength = optNumber(obj, "prefixLength", path);
  if (prefixLength !== undefined) {
    def.prefixLength = prefixLength;
  }
  const mtu = optNumber(obj, "mtu", path);
  if (mtu !== undefined) {
    if (!Number.isInteger(mtu) || mtu < 68) {
      throw fail(path, `"mtu" must be an integer >= 68: ${mtu}`);
    }
    def.mtu = mtu;
  }
  return def;
}

function parseRouteDef(value: unknown, path: string): ScenarioRouteDef {
  const obj = reqRecord(value, path);
  const def: ScenarioRouteDef = {
    destination: reqString(obj, "destination", path),
    iface: reqString(obj, "iface", path),
  };
  const gateway = optString(obj, "gateway", path);
  if (gateway !== undefined) {
    def.gateway = gateway;
  }
  const metric = optNumber(obj, "metric", path);
  if (metric !== undefined) {
    if (!Number.isInteger(metric) || metric < 0) {
      throw fail(path, `"metric" must be an integer >= 0: ${metric}`);
    }
    def.metric = metric;
  }
  return def;
}

function parseVlanId(value: unknown, path: string, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw fail(path, `${what} must be an integer VLAN id`);
  }
  if (value < 1 || value > 4094) {
    throw fail(path, `${what} must be a VLAN id in 1..4094: ${value}`);
  }
  return value;
}

function parsePortVlan(value: unknown, path: string): ScenarioVlanPortConfig {
  const obj = reqRecord(value, path);
  const modeRaw = obj["mode"];
  if (modeRaw !== undefined && modeRaw !== "access" && modeRaw !== "trunk") {
    throw fail(path, `"mode" must be "access" | "trunk"`);
  }
  const mode = modeRaw as "access" | "trunk" | undefined;
  const vlan: ScenarioVlanPortConfig = {};
  if (mode !== undefined) {
    vlan.mode = mode;
  }
  if (obj["vlan"] !== undefined) {
    if (mode === "trunk") {
      throw fail(path, `"vlan" is an access setting; use native on a trunk`);
    }
    vlan.vlan = parseVlanId(obj["vlan"], path, `"vlan"`);
  }
  if (obj["allowed"] !== undefined) {
    if (mode !== "trunk") {
      throw fail(path, `"allowed" is a trunk setting`);
    }
    const raw = obj["allowed"];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw fail(path, `"allowed" must be a non-empty array of VLAN ids`);
    }
    vlan.allowed = raw.map((entry, i) =>
      parseVlanId(entry, `${path}.allowed[${i}]`, `"allowed" entry`),
    );
  }
  if (obj["native"] !== undefined) {
    if (mode !== "trunk") {
      throw fail(path, `"native" is a trunk setting`);
    }
    vlan.native = parseVlanId(obj["native"], path, `"native"`);
  }
  if (
    vlan.native !== undefined &&
    vlan.allowed !== undefined &&
    !vlan.allowed.includes(vlan.native)
  ) {
    throw fail(path, `"native" must also be allowed`);
  }
  return vlan;
}

function parsePortDef(value: unknown, path: string): ScenarioPortDef {
  const obj = reqRecord(value, path);
  const name = reqString(obj, "name", path);
  const mac = optString(obj, "mac", path);
  const def: ScenarioPortDef = { name };
  if (mac !== undefined) {
    def.mac = mac;
  }
  if (obj["vlan"] !== undefined) {
    def.vlan = parsePortVlan(obj["vlan"], `${path}.vlan`);
  }
  return def;
}

function parseNode(value: unknown, path: string): ScenarioNode {
  const obj = reqRecord(value, path);
  const type = reqString(obj, "type", path);
  const id = reqString(obj, "id", path);
  if (type === "host") {
    const interfaces = reqArray(obj, "interfaces", path).map((entry, i) =>
      parseInterfaceDef(entry, `${path}.interfaces[${i}]`),
    );
    if (interfaces.length === 0) {
      throw fail(path, `host ${JSON.stringify(id)} needs one interface`);
    }
    let hostOpts: ScenarioHostOpts | undefined;
    if (obj["hostOpts"] !== undefined) {
      const opts = reqRecord(obj["hostOpts"], `${path}.hostOpts`);
      hostOpts = {};
      for (const key of [
        "arpTtlUs",
        "arpTimeoutUs",
        "arpRetries",
        "arpQueueLimit",
      ] as const) {
        const n = optNumber(opts, key, `${path}.hostOpts`);
        if (n !== undefined) {
          (hostOpts as Record<string, number>)[key] = n;
        }
      }
    }
    const node: ScenarioNode = { type: "host", id, interfaces };
    if (hostOpts !== undefined) {
      node.hostOpts = hostOpts;
    }
    return node;
  }
  if (type === "switch" || type === "hub") {
    const ports = reqArray(obj, "ports", path).map((entry, i) =>
      parsePortDef(entry, `${path}.ports[${i}]`),
    );
    if (ports.length === 0) {
      throw fail(path, `${type} ${JSON.stringify(id)} needs one port`);
    }
    if (type === "hub") {
      for (const port of ports) {
        if (port.vlan !== undefined) {
          throw fail(path, `"vlan" is not supported on hub ports`);
        }
      }
      return { type: "hub", id, ports };
    }
    const agingTimeUs = optNumber(obj, "agingTimeUs", path);
    const node: ScenarioNode = { type: "switch", id, ports };
    if (agingTimeUs !== undefined) {
      node.agingTimeUs = agingTimeUs;
    }
    return node;
  }
  if (type === "router") {
    const interfaces = reqArray(obj, "interfaces", path).map((entry, i) =>
      parseRouterPortDef(entry, `${path}.interfaces[${i}]`),
    );
    if (interfaces.length === 0) {
      throw fail(path, `router ${JSON.stringify(id)} needs one port`);
    }
    const routes =
      obj["routes"] === undefined
        ? undefined
        : reqArray(obj, "routes", path).map((entry, i) =>
            parseRouteDef(entry, `${path}.routes[${i}]`),
          );
    const node: ScenarioNode = { type: "router", id, interfaces };
    if (routes !== undefined) {
      node.routes = routes;
    }
    return node;
  }
  throw fail(path, `"type" must be "host" | "switch" | "hub" | "router"`);
}

function parseEndpoint(value: unknown, path: string): ScenarioLinkEndpoint {
  const obj = reqRecord(value, path);
  return {
    node: reqString(obj, "node", path),
    iface: reqString(obj, "iface", path),
  };
}

function parseLink(value: unknown, path: string): ScenarioLink {
  const obj = reqRecord(value, path);
  const id = reqString(obj, "id", path);
  const a = parseEndpoint(obj["a"], `${path}.a`);
  const b = parseEndpoint(obj["b"], `${path}.b`);
  const params = reqRecord(obj["params"], `${path}.params`);
  const latencyUs = params["latencyUs"];
  if (typeof latencyUs !== "number") {
    throw fail(path, `"params.latencyUs" must be a number`);
  }
  return { id, a, b, params: params as unknown as LinkParams };
}

function optBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw fail(path, `"${key}" must be a boolean`);
  }
  return value;
}

function parseAction(value: unknown, path: string): ScenarioAction {
  const obj = reqRecord(value, path);
  let at: DurationInput | undefined;
  if (obj["at"] !== undefined) {
    const raw = obj["at"];
    if (typeof raw !== "number" && typeof raw !== "string") {
      throw fail(path, `"at" must be a duration string or microseconds`);
    }
    parseDurationToUs(raw, 0, `${path}.at`);
    at = raw;
  }
  // Fault actions (F-100) target a link or a host, so they are recognized
  // before the `host` requirement of the traffic actions.
  if (obj["cut"] !== undefined) {
    const action: ScenarioCutAction = { cut: reqString(obj, "cut", path) };
    if (at !== undefined) {
      action.at = at;
    }
    return action;
  }
  if (obj["restore"] !== undefined) {
    const action: ScenarioRestoreAction = {
      restore: reqString(obj, "restore", path),
    };
    if (at !== undefined) {
      action.at = at;
    }
    return action;
  }
  if (obj["restart"] !== undefined) {
    const action: ScenarioRestartAction = {
      restart: reqString(obj, "restart", path),
    };
    if (at !== undefined) {
      action.at = at;
    }
    return action;
  }
  if (obj["flushArp"] !== undefined) {
    const action: ScenarioFlushArpAction = {
      flushArp: reqString(obj, "flushArp", path),
    };
    const iface = optString(obj, "iface", path);
    if (iface !== undefined) {
      action.iface = iface;
    }
    if (at !== undefined) {
      action.at = at;
    }
    return action;
  }
  const host = reqString(obj, "host", path);
  if (obj["exec"] !== undefined) {
    const action: ScenarioShellAction = {
      host,
      exec: reqString(obj, "exec", path),
    };
    if (at !== undefined) {
      action.at = at;
    }
    return action;
  }
  if (obj["ping"] !== undefined) {
    const destIp = reqString(obj, "destIp", path);
    const pingObj = reqRecord(obj["ping"], `${path}.ping`);
    const ping: ScenarioPingOptions = {};
    const count = optNumber(pingObj, "count", `${path}.ping`);
    if (count !== undefined) {
      if (!Number.isInteger(count) || count < 1 || count > 10000) {
        throw fail(path, `"ping.count" must be an integer 1..10000`);
      }
      ping.count = count;
    }
    const size = optNumber(pingObj, "size", `${path}.ping`);
    if (size !== undefined) {
      if (!Number.isInteger(size) || size < 0 || size > 65500) {
        throw fail(path, `"ping.size" must be an integer 0..65500`);
      }
      ping.size = size;
    }
    const ttl = optNumber(pingObj, "ttl", `${path}.ping`);
    if (ttl !== undefined) {
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 255) {
        throw fail(path, `"ping.ttl" must be an integer 1..255`);
      }
      ping.ttl = ttl;
    }
    const dontFragment = optBoolean(pingObj, "dontFragment", `${path}.ping`);
    if (dontFragment !== undefined) {
      ping.dontFragment = dontFragment;
    }
    if (pingObj["interval"] !== undefined) {
      const raw = pingObj["interval"];
      if (typeof raw !== "number" && typeof raw !== "string") {
        throw fail(path, `"ping.interval" must be a duration string or number`);
      }
      parseDurationToUs(raw, 0, `${path}.ping.interval`);
      ping.interval = raw;
    }
    const action: ScenarioPingAction = { host, destIp, ping };
    const iface = optString(obj, "iface", path);
    if (iface !== undefined) {
      action.iface = iface;
    }
    if (at !== undefined) {
      action.at = at;
    }
    return action;
  }
  const iface = reqString(obj, "iface", path);
  const destIp = reqString(obj, "destIp", path);
  const action: ScenarioSendAction = { host, iface, destIp };
  if (at !== undefined) {
    action.at = at;
  }
  if (obj["etherType"] !== undefined) {
    const etherType = obj["etherType"];
    if (typeof etherType !== "number" && typeof etherType !== "string") {
      throw fail(path, `"etherType" must be a number or hex string`);
    }
    action.etherType = etherType;
  }
  if (obj["payload"] !== undefined) {
    if (typeof obj["payload"] !== "string") {
      throw fail(path, `"payload" must be a string`);
    }
    action.payload = obj["payload"] as string;
  }
  if (obj["payloadEncoding"] !== undefined) {
    if (obj["payloadEncoding"] !== "utf8" && obj["payloadEncoding"] !== "hex") {
      throw fail(path, `"payloadEncoding" must be "utf8" | "hex"`);
    }
    action.payloadEncoding = obj["payloadEncoding"];
  }
  // Early validation so JSON errors fail fast with a path.
  if (action.at !== undefined) {
    parseDurationToUs(action.at, 0, `${path}.at`);
  }
  parseEtherType(action.etherType, `${path}.etherType`);
  decodePayload(action.payload, action.payloadEncoding, `${path}.payload`);
  return action;
}

/** Validate an already-parsed JSON value into a `Scenario`. */
export function parseScenarioJson(value: unknown): Scenario {
  const obj = reqRecord(value, "scenario");
  if (obj["version"] !== SCENARIO_VERSION) {
    throw fail(
      "scenario",
      `"version" must be ${SCENARIO_VERSION}, got ${JSON.stringify(obj["version"])}`,
    );
  }
  const nodes = reqRecord(obj, "scenario");
  void nodes;
  const nodeList = reqArray(obj, "nodes", "scenario").map((entry, i) =>
    parseNode(entry, `nodes[${i}]`),
  );
  const linkList = (
    obj["links"] === undefined ? [] : reqArray(obj, "links", "scenario")
  ).map((entry, i) => parseLink(entry, `links[${i}]`));
  const actionList = (
    obj["actions"] === undefined ? [] : reqArray(obj, "actions", "scenario")
  ).map((entry, i) => parseAction(entry, `actions[${i}]`));
  const ids = new Set<string>();
  for (const node of nodeList) {
    if (ids.has(node.id)) {
      throw fail("scenario", `duplicate node id ${JSON.stringify(node.id)}`);
    }
    ids.add(node.id);
  }
  const scenario: Scenario = {
    version: SCENARIO_VERSION,
    nodes: nodeList,
    links: linkList,
    actions: actionList,
  };
  if (obj["seed"] !== undefined) {
    if (typeof obj["seed"] !== "number" || !Number.isInteger(obj["seed"])) {
      throw fail("scenario", `"seed" must be an integer`);
    }
    scenario.seed = obj["seed"] as number;
  }
  if (obj["until"] !== undefined) {
    const until = obj["until"];
    if (typeof until !== "number" && typeof until !== "string") {
      throw fail("scenario", `"until" must be a duration string or number`);
    }
    parseDurationToUs(until, DEFAULT_UNTIL_US, "until");
    scenario.until = until;
  }
  return scenario;
}

/** Parse scenario text (JSON) with a filename in error messages. */
export function parseScenarioText(text: string, _filename: string): Scenario {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse scenario: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseScenarioJson(value);
}
