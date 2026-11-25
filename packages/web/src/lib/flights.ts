/**
 * Pure flight builder for F-87 frame animation (S1).
 *
 * Turns the worker's `WireTrace[]` into one `Flight` per cable traversal
 * with its virtual `[startUs, endUs]` window and protocol for coloring.
 * No DOM, no SvelteKit: safe for tests and the worker boundary.
 *
 * Pairing is FIFO per `(link, from)`: tx `from=a` pairs with rx `to=b`
 * on the same link (and vice versa). Drops pair through `where`
 * (`link:from>to`) and keep their reason. rx/drop with `t >= tx.t`
 * and equal hex win; unmatched completions are ignored so a corrupt
 * or foreign trace never invents a flight. Leftover tx without a
 * completion closes as a zero-length flight so the render layer can
 * still show it through its visual floor without touching virtual time.
 */

import { decodeFrame } from "./decode";
import type { EndpointSide, WireTrace } from "./sim-protocol";

export type FlightOutcome = "delivered" | "dropped";

export interface Flight {
  linkId: string;
  from: EndpointSide;
  startUs: number;
  endUs: number;
  protocol: "ARP" | "ICMP" | "OTRO";
  hex: string;
  outcome: FlightOutcome;
  dropReason?: string;
}

interface PendingTx {
  t: number;
  hex: string;
}

function opposite(side: EndpointSide): EndpointSide {
  return side === "a" ? "b" : "a";
}

function parseDropWhere(
  where: string,
): { linkId: string; from: EndpointSide } | null {
  const match = /^(.*):([ab])>([ab])$/.exec(where);
  if (!match) {
    return null;
  }
  const [, linkId, from] = match;
  if ((from !== "a" && from !== "b") || linkId === undefined) {
    return null;
  }
  return { linkId, from };
}

/** Pair tx/rx/drop traces into per-cable flights (completion order). */
export function buildFlights(traces: readonly WireTrace[]): Flight[] {
  const pending = new Map<string, PendingTx[]>();
  const flights: Flight[] = [];

  function pushPending(
    link: string,
    from: EndpointSide,
    t: number,
    hex: string,
  ): void {
    const key = `${link}:${from}`;
    const queue = pending.get(key);
    const entry: PendingTx = { t, hex };
    if (queue) {
      queue.push(entry);
    } else {
      pending.set(key, [entry]);
    }
  }

  function takePending(
    link: string,
    from: EndpointSide,
    t: number,
    hex: string,
  ): PendingTx | null {
    const key = `${link}:${from}`;
    const queue = pending.get(key);
    if (!queue || queue.length === 0) {
      return null;
    }
    let index = queue.findIndex((entry) => entry.t <= t && entry.hex === hex);
    if (index === -1) {
      index = queue.findIndex((entry) => entry.t <= t);
    }
    if (index === -1) {
      return null;
    }
    const [entry] = queue.splice(index, 1);
    return entry ?? null;
  }

  for (const trace of traces) {
    if (trace.kind === "frame_tx") {
      pushPending(trace.link, trace.from, trace.t, trace.frame);
    } else if (trace.kind === "frame_rx") {
      const from = opposite(trace.to);
      const tx = takePending(trace.link, from, trace.t, trace.frame);
      if (!tx) {
        continue;
      }
      flights.push({
        linkId: trace.link,
        from,
        startUs: tx.t,
        endUs: trace.t,
        protocol: decodeFrame(tx.hex).protocol,
        hex: tx.hex,
        outcome: "delivered",
      });
    } else if (trace.kind === "frame_drop") {
      const parsed = parseDropWhere(trace.where);
      const linkId = parsed?.linkId ?? trace.link;
      const from = parsed?.from ?? (trace.where.includes(":b>") ? "b" : "a");
      const tx = takePending(linkId, from, trace.t, trace.frame);
      if (!tx) {
        continue;
      }
      flights.push({
        linkId,
        from,
        startUs: tx.t,
        endUs: trace.t,
        protocol: decodeFrame(tx.hex).protocol,
        hex: tx.hex,
        outcome: "dropped",
        dropReason: trace.reason,
      });
    }
  }

  for (const [key, queue] of pending) {
    const separator = key.lastIndexOf(":");
    const linkId = key.slice(0, separator);
    const from = key.slice(separator + 1) as EndpointSide;
    for (const tx of queue) {
      flights.push({
        linkId,
        from,
        startUs: tx.t,
        endUs: tx.t,
        protocol: decodeFrame(tx.hex).protocol,
        hex: tx.hex,
        outcome: "delivered",
      });
    }
  }

  return flights;
}
