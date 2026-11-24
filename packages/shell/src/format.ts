/**
 * Text formatting for `ip addr`, `ip link`, `ip route`, `ip neigh` and
 * `arp -a` (S7). All data comes from Host snapshots; nothing is cached in
 * the shell except the neighbor candidates described in `neighbors.ts`.
 */

import { Ipv4Address } from "@netlab/bytes";
import { type Host, prefixToMask } from "@netlab/core";
import type { NeighborEntry } from "./neighbors";

/** `addr` block: name/state/mtu, MAC, then the optional IPv4 identity. */
export function formatAddressLines(
  host: Host,
  mtu: number,
  ifaceName?: string,
): Array<string> {
  const lines: Array<string> = [];
  for (const [index, iface] of host.interfaces.entries()) {
    if (ifaceName !== undefined && iface.name !== ifaceName) {
      continue;
    }
    lines.push(
      `${index + 1}: ${iface.name}: state ${iface.up ? "UP" : "DOWN"} ` +
        `mtu ${mtu}`,
    );
    lines.push(`    link/ether ${iface.mac.toString()}`);
    const config = host.getIpConfig(iface.name);
    if (config === undefined) {
      continue;
    }
    let inet = `    inet ${config.ip.toString()}`;
    if (config.prefixLength !== undefined) {
      inet += `/${config.prefixLength}`;
      if (config.prefixLength <= 30) {
        const mask = prefixToMask(config.prefixLength).toU32();
        const broadcast = Ipv4Address.fromU32(
          (config.ip.toU32() | (~mask >>> 0)) >>> 0,
        );
        inet += ` brd ${broadcast.toString()}`;
      }
    }
    lines.push(`${inet} scope global`);
  }
  return lines;
}

/** `link` block: no L3 data beyond what `ip link` shows on a real host. */
export function formatLinkLines(
  host: Host,
  mtu: number,
  ifaceName?: string,
): Array<string> {
  const lines: Array<string> = [];
  for (const [index, iface] of host.interfaces.entries()) {
    if (ifaceName !== undefined && iface.name !== ifaceName) {
      continue;
    }
    lines.push(
      `${index + 1}: ${iface.name}: state ${iface.up ? "UP" : "DOWN"} ` +
        `mtu ${mtu}`,
    );
    lines.push(`    link/ether ${iface.mac.toString()}`);
  }
  return lines;
}

/**
 * Host routing view: connected routes from ip/prefix and one default route
 * per configured gateway. The Host has no static table yet, so this is the
 * honest projection of its configuration.
 */
export function formatRouteLines(host: Host): Array<string> {
  const configured = host.interfaces.flatMap((iface) => {
    const config = host.getIpConfig(iface.name);
    return config === undefined ? [] : [{ name: iface.name, config }];
  });
  const lines: Array<string> = [];
  for (const { name, config } of configured) {
    if (config.prefixLength === undefined) {
      continue;
    }
    const mask = prefixToMask(config.prefixLength).toU32();
    const network = Ipv4Address.fromU32((config.ip.toU32() & mask) >>> 0);
    lines.push(
      `${network.toString()}/${config.prefixLength} dev ${name} ` +
        `proto kernel scope link src ${config.ip.toString()}`,
    );
  }
  for (const { name, config } of configured) {
    if (config.gateway === undefined) {
      continue;
    }
    lines.push(`default via ${config.gateway.toString()} dev ${name}`);
  }
  return lines;
}

/** Linux `ip neigh` form. */
export function formatIpNeighLines(
  entries: ReadonlyArray<NeighborEntry>,
): Array<string> {
  return entries.map(
    (entry) => `${entry.ip} dev ${entry.iface} lladdr ${entry.mac} REACHABLE`,
  );
}

/** BSD-style `arp -a` form. */
export function formatArpLines(
  entries: ReadonlyArray<NeighborEntry>,
): Array<string> {
  return entries.map(
    (entry) => `? (${entry.ip}) at ${entry.mac} [ether] on ${entry.iface}`,
  );
}
