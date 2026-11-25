/**
 * Wire format shared by the workbench (main thread) and the simulation
 * worker. Frames travel as hex because structured clone handles strings
 * predictably and the UI needs the bytes as text anyway.
 */

export type EndpointSide = "a" | "b";

/** Serialized counterpart of `Trace` from `@netlab/core`. */
export type WireTrace =
  | {
      t: number;
      kind: "frame_tx";
      link: string;
      from: EndpointSide;
      length: number;
      frame: string;
    }
  | {
      t: number;
      kind: "frame_rx";
      link: string;
      to: EndpointSide;
      length: number;
      frame: string;
    }
  | {
      t: number;
      kind: "frame_drop";
      link: string;
      where: string;
      reason: string;
      length: number;
      frame: string;
    }
  | {
      t: number;
      kind: "state";
      scope: string;
      detail: string;
    }
  | {
      t: number;
      kind: "log";
      scope: string;
      level: string;
      message: string;
    };

/** One addressed interface of the fixed two-subnet scenario. */
export interface InterfaceSnapshot {
  device: string;
  deviceKind: "host" | "router";
  iface: string;
  mac: string;
  ip: string | null;
  prefixLength: number | null;
  gateway: string | null;
}

/** Resolved ARP neighbor observed through the public lookup API. */
export interface NeighborSnapshot {
  device: string;
  iface: string;
  ip: string;
  mac: string;
}

/** Routing-table row of r1. */
export interface RouteSnapshot {
  destination: string;
  iface: string;
  gateway: string | null;
  metric: number;
  kind: string;
}

/** Everything the workbench needs to render one deterministic run. */
export interface SimResult {
  scenario: string;
  seed: number;
  horizonUs: number;
  simTimeUs: number;
  events: number;
  traceCount: number;
  traces: WireTrace[];
  interfaces: InterfaceSnapshot[];
  neighbors: NeighborSnapshot[];
  routes: RouteSnapshot[];
  transcript: string[];
}

/**
 * Main thread -> worker. `run` replays the fixed scenario from scratch;
 * `exec` runs one shell command line on the live interactive session.
 */
export type WorkerRequest =
  | { type: "run" }
  | { type: "exec"; host: string; cmd: string };

/**
 * Worker -> main thread: one shell answer. `traces` carries only the frames
 * produced by this command, so the UI can append them to the packet list;
 * `error` is null on success and a message on parse/execution failure.
 */
export interface ExecResponse {
  kind: "exec";
  host: string;
  cmd: string;
  lines: string[];
  error: string | null;
  simTimeUs: number;
  traces: WireTrace[];
}

/** Worker -> main thread: one message with the whole run or one shell answer. */
export type WorkerResponse =
  | { kind: "result"; result: SimResult }
  | ExecResponse
  | { kind: "error"; message: string };
