/**
 * Trace rendering: human lines for the console, JSON lines for replay/diff.
 *
 * Frames travel by reference in the bus. These printers only read them
 * synchronously during formatting (hex for JSON, length for humans) and
 * never retain the view — anything persisted is a copy.
 */

import type { Trace } from "@netlab/core";
import type { RunResult } from "./run";

/** `Uint8Array` → lowercase hex (a copy as text, safe to persist). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function fmtTime(t: number): string {
  return `t=${t}us`;
}

/** One trace as one human-readable line (no trailing newline). */
export function formatTraceHuman(trace: Trace): string {
  switch (trace.kind) {
    case "frame_tx":
      return `[${fmtTime(trace.t)}] TX ${trace.link} from=${trace.from} len=${trace.length}`;
    case "frame_rx":
      return `[${fmtTime(trace.t)}] RX ${trace.link} to=${trace.to} len=${trace.length}`;
    case "frame_drop":
      return `[${fmtTime(trace.t)}] DROP ${trace.link} where=${trace.where} reason=${trace.reason} len=${trace.length}`;
    case "state":
      return `[${fmtTime(trace.t)}] STATE ${trace.scope}: ${trace.detail}`;
    case "log":
      return `[${fmtTime(trace.t)}] LOG ${trace.scope} [${trace.level}] ${trace.message}`;
  }
}

/** Full human report: traces plus MAC tables and run summary. */
export function formatHuman(result: RunResult): string {
  const lines = result.traces.map(formatTraceHuman);
  lines.push(
    `processed ${result.processed} events, final ${fmtTime(result.finalTime)}, seed=${result.seed}, traces=${result.traces.length}`,
  );
  const ids = Object.keys(result.macTables).sort();
  if (ids.length === 0) {
    lines.push("MAC tables: (none)");
  } else {
    lines.push("MAC tables:");
    for (const id of ids) {
      const rows = result.macTables[id] ?? [];
      lines.push(`  ${id}:`);
      if (rows.length === 0) {
        lines.push("    (empty)");
      }
      for (const row of rows) {
        lines.push(
          `    ${row.mac.toString()} -> ${row.port} vlan ${row.vlan} (expires ${fmtTime(row.expiresAt)})`,
        );
      }
    }
  }
  const routerIds = Object.keys(result.routes).sort();
  if (routerIds.length === 0) {
    lines.push("Routing tables: (none)");
  } else {
    lines.push("Routing tables:");
    for (const id of routerIds) {
      const rows = result.routes[id] ?? [];
      lines.push(`  ${id}:`);
      if (rows.length === 0) {
        lines.push("    (empty)");
      }
      for (const row of rows) {
        const via =
          row.gateway === undefined ? "connected" : `via ${row.gateway}`;
        lines.push(
          `    ${row.destination} ${via} dev ${row.iface} metric ${row.metric} (${row.kind})`,
        );
      }
    }
  }
  if (result.shellTranscripts.length === 0) {
    lines.push("Shell: (no commands)");
  } else {
    lines.push("Shell:");
    for (const entry of result.shellTranscripts) {
      lines.push(`  ${entry.host}$ ${entry.command}`);
      if (entry.error !== undefined) {
        lines.push(`    error: ${entry.error}`);
      }
      for (const line of entry.lines ?? []) {
        lines.push(`    ${line}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** One trace as plain JSON (frame as hex string, safe to persist). */
export function traceToJson(trace: Trace): unknown {
  switch (trace.kind) {
    case "frame_tx":
      return {
        t: trace.t,
        kind: trace.kind,
        link: trace.link,
        from: trace.from,
        length: trace.length,
        frame: bytesToHex(trace.frame),
      };
    case "frame_rx":
      return {
        t: trace.t,
        kind: trace.kind,
        link: trace.link,
        to: trace.to,
        length: trace.length,
        frame: bytesToHex(trace.frame),
      };
    case "frame_drop":
      return {
        t: trace.t,
        kind: trace.kind,
        link: trace.link,
        where: trace.where,
        reason: trace.reason,
        length: trace.length,
        frame: bytesToHex(trace.frame),
      };
    case "state":
      return {
        t: trace.t,
        kind: trace.kind,
        scope: trace.scope,
        detail: trace.detail,
      };
    case "log":
      return {
        t: trace.t,
        kind: trace.kind,
        scope: trace.scope,
        level: trace.level,
        message: trace.message,
      };
  }
}

/** Traces as JSON lines (one object per line, trailing newline when non-empty). */
export function formatJsonLines(traces: Array<Trace>): string {
  if (traces.length === 0) {
    return "";
  }
  return `${traces.map((trace) => JSON.stringify(traceToJson(trace))).join("\n")}\n`;
}

/** MAC tables as JSON (goes to stderr in `--format json`, keeping stdout pure). */
export function formatMacTablesJson(macTables: RunResult["macTables"]): string {
  return JSON.stringify({ macTables: macTablesJson(macTables) });
}

/** Full run summary (MAC tables, routes, shell transcripts) for stderr. */
export function formatSummaryJson(result: RunResult): string {
  return JSON.stringify({
    macTables: macTablesJson(result.macTables),
    routes: result.routes,
    shell: result.shellTranscripts,
  });
}

function macTablesJson(
  macTables: RunResult["macTables"],
): Record<
  string,
  Array<{ mac: string; port: string; vlan: number; expiresAt: number }>
> {
  const out: Record<
    string,
    Array<{ mac: string; port: string; vlan: number; expiresAt: number }>
  > = {};
  for (const [id, rows] of Object.entries(macTables).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    out[id] = rows.map((row) => ({
      mac: row.mac.toString(),
      port: row.port,
      vlan: row.vlan,
      expiresAt: row.expiresAt,
    }));
  }
  return out;
}
