/**
 * Neighbor cache snapshots (S7).
 *
 * `Host` exposes per-address lookups (`arpLookup`) but no cache iterator,
 * and the shell must not reach into another device's private state. The
 * default provider therefore resolves only the addresses the shell can
 * legitimately know about — interface gateways plus destinations it sent
 * to — through the public lookup API. Callers with a richer source can
 * inject their own `neighbors` provider when constructing the shell.
 */

import { Ipv4Address } from "@netlab/bytes";
import type { Host } from "@netlab/core";

/** One resolved neighbor row. */
export interface NeighborEntry {
  readonly iface: string;
  readonly ip: string;
  readonly mac: string;
  readonly state: "reachable";
}

/** Address the shell may ask the Host cache about. */
export interface NeighborCandidate {
  readonly iface: string;
  readonly ip: string;
}

/** Snapshot source for `arp -a` / `ip neigh`. */
export type NeighborProvider = (host: Host) => ReadonlyArray<NeighborEntry>;

/**
 * Resolve candidates through `Host.arpLookup()`, skipping anything the
 * cache does not know (or that expired). Never throws: a snapshot must stay
 * available even for odd interface/candidate combinations.
 */
export function hostNeighborEntries(
  host: Host,
  candidates: ReadonlyArray<NeighborCandidate>,
): Array<NeighborEntry> {
  const seen = new Set<string>();
  const entries: Array<NeighborEntry> = [];
  for (const candidate of candidates) {
    const key = `${candidate.iface}\u0000${candidate.ip}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let mac: string | undefined;
    try {
      mac = host.arpLookup(candidate.iface, candidate.ip)?.toString();
    } catch {
      mac = undefined;
    }
    if (mac !== undefined) {
      entries.push({
        iface: candidate.iface,
        ip: candidate.ip,
        mac,
        state: "reachable",
      });
    }
  }
  return entries;
}

/** Stable order: interface creation order, then numeric address. */
export function sortNeighborEntries(
  host: Host,
  entries: ReadonlyArray<NeighborEntry>,
): Array<NeighborEntry> {
  const ifaceOrder = new Map(
    host.interfaces.map((iface, index) => [iface.name, index] as const),
  );
  const addressOrder = (text: string): number => {
    try {
      return Ipv4Address.parse(text).toU32();
    } catch {
      return 0;
    }
  };
  return [...entries].sort((left, right) => {
    const leftIface = ifaceOrder.get(left.iface) ?? Number.MAX_SAFE_INTEGER;
    const rightIface = ifaceOrder.get(right.iface) ?? Number.MAX_SAFE_INTEGER;
    if (leftIface !== rightIface) {
      return leftIface - rightIface;
    }
    return addressOrder(left.ip) - addressOrder(right.ip);
  });
}
