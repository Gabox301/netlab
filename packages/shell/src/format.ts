/**
 * Text formatting for `ip addr`, `ip link`, `ip route`, `ip neigh`, `arp -a`
 * (S7) plus the Fase 4 commands `dig`, `dhclient` and `nc -u` and the Fase 5
 * TCP surface `nc` (TCP), `ss` and `curl`. All data comes from Host snapshots
 * or application results; nothing is cached here except the neighbor
 * candidates described in `neighbors.ts`.
 */

import { Ipv4Address } from "@netlab/bytes";
import {
  type DhcpClientLease,
  type DhcpClientState,
  type DnsResolutionStatus,
  type Host,
  prefixToMask,
  type TcpState,
} from "@netlab/core";
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

/** Lowercase hex, the only payload form `nc -u` prints or accepts. */
export function bytesToHex(data: Uint8Array): string {
  let hex = "";
  for (const byte of data) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Header carried by every `dig` line or `formatDigLines` view. */
export interface DigView {
  /** Normalized query name, no trailing dot. */
  readonly name: string;
  readonly server: string;
  readonly port: number;
  readonly status: DnsResolutionStatus;
  readonly address: string | undefined;
  readonly rcode: number | undefined;
  readonly ttlSeconds: number | undefined;
  readonly fromCache: boolean;
  readonly attempts: number;
  readonly timeoutUs: number;
  readonly retries: number;
}

const DIG_STATUS_NAMES: Record<DnsResolutionStatus, string> = {
  ok: "NOERROR",
  nxdomain: "NXDOMAIN",
  timeout: "TIMEOUT",
  error: "ERROR",
};

function digStatus(view: DigView): string {
  const name = DIG_STATUS_NAMES[view.status];
  if (view.status !== "error" || view.rcode === undefined) {
    return name;
  }
  return `${name} rcode=${view.rcode}`;
}

/**
 * `dig` output: a BIND-flavoured, line-oriented report. Only observable
 * facts are printed — the answer section when one arrived, the status, the
 * attempt count and the resolver window the command used.
 */
export function formatDigLines(view: DigView): Array<string> {
  const lines = [
    `; <<>> netlab dig <<>> ${view.name}`,
    `;; status: ${digStatus(view)}`,
    `;; attempts: ${view.attempts}`,
  ];
  if (view.fromCache) {
    lines.push(";; cache: hit");
  }
  if (view.status === "ok" && view.address !== undefined) {
    lines.push(";; ANSWER SECTION:");
    lines.push(
      `${view.name}.\t${view.ttlSeconds ?? 0}\tIN\tA\t${view.address}`,
    );
  }
  lines.push(`;; SERVER: ${view.server}#${view.port}`);
  lines.push(`;; timeout: ${view.timeoutUs} us (retries: ${view.retries})`);
  return lines;
}

/** One `dhclient` run: the interface, its outcome and the lease it applied. */
export interface DhclientView {
  readonly iface: string;
  readonly state: DhcpClientState;
  readonly lease: DhcpClientLease | undefined;
  /** Discover attempts transmitted. */
  readonly attempts: number;
}

/** `dhclient` output: DORA start, the applied lease, or the failure. */
export function formatDhclientLines(view: DhclientView): Array<string> {
  const lines = [`DHCPDISCOVER on ${view.iface} to 255.255.255.255 port 67`];
  const lease = view.lease;
  if (view.state !== "bound" || lease === undefined) {
    lines.push(
      `dhclient: no DHCPACK on ${view.iface} after ${view.attempts} attempts`,
    );
    return lines;
  }
  const mask = lease.mask === undefined ? "" : ` mask ${lease.mask}`;
  lines.push(
    `DHCPACK from ${lease.serverId ?? "unknown"}: ` +
      `bound to ${lease.ip}${mask}`,
  );
  if (lease.gateway !== undefined) {
    lines.push(`  gateway ${lease.gateway}`);
  }
  for (const dns of lease.dnsServers) {
    lines.push(`  nameserver ${dns}`);
  }
  const leaseTime =
    lease.leaseTimeSeconds === undefined
      ? "unknown"
      : `${lease.leaseTimeSeconds}`;
  lines.push(
    `lease acquired at ${lease.acquiredAt} us, lease time ${leaseTime} s`,
  );
  return lines;
}

/** One datagram collected by `nc -u`, payload already hex-encoded. */
export interface NcReplyView {
  readonly srcIp: string;
  readonly srcPort: number;
  readonly payload: string;
}

/** Header carried by `formatNcUdpLines`: what was sent and what came back. */
export interface NcUdpView {
  readonly host: string;
  readonly port: number;
  /** Sent payload, lowercase hex. */
  readonly payload: string;
  readonly replies: ReadonlyArray<NcReplyView>;
}

function payloadSuffix(hex: string): string {
  return hex.length === 0 ? "" : `: ${hex}`;
}

/** `nc -u` output: the target, the sent datagram, every reply and a count. */
export function formatNcUdpLines(view: NcUdpView): Array<string> {
  const lines = [
    `UDP ${view.host}:${view.port}`,
    `sent ${view.payload.length / 2} bytes${payloadSuffix(view.payload)}`,
  ];
  for (const reply of view.replies) {
    lines.push(
      `received ${reply.payload.length / 2} bytes from ` +
        `${reply.srcIp}:${reply.srcPort}${payloadSuffix(reply.payload)}`,
    );
  }
  lines.push(`--- ${view.host}:${view.port} udp ---`);
  lines.push(`1 sent, ${view.replies.length} received`);
  return lines;
}

/** One TCP session collected by `nc`, payload already hex-encoded. */
export interface NcTcpView {
  readonly host: string;
  readonly port: number;
  /** Payload sent after the handshake, lowercase hex. */
  readonly payload: string;
  /** Every byte received, concatenated and hex-encoded. */
  readonly received: string;
  /** True when the three-way handshake completed before the deadline. */
  readonly connected: boolean;
  /** Connection state at the deadline, before the command closes the socket. */
  readonly state: TcpState;
}

/**
 * `nc` (TCP) output: the target, the handshake outcome, the bytes sent and
 * received, and the state the connection reached before the deadline.
 *
 * A refused connection (RST) and a silent one (SYN dropped, no answer) read
 * differently: the first left CLOSED, the second is still trying. The byte
 * counts are aggregated because TCP is a stream, unlike the per-datagram
 * `nc -u` report.
 */
export function formatNcTcpLines(view: NcTcpView): Array<string> {
  const lines = [`TCP ${view.host}:${view.port}`];
  if (view.connected) {
    lines.push(
      `sent ${view.payload.length / 2} bytes${payloadSuffix(view.payload)}`,
    );
  } else {
    lines.push(
      view.state === "CLOSED" ? "connect: refused" : "connect: timeout",
    );
  }
  lines.push(
    `received ${view.received.length / 2} bytes${payloadSuffix(view.received)}`,
  );
  lines.push(`--- ${view.host}:${view.port} tcp ---`);
  lines.push(`state ${view.state}, ${view.received.length / 2} bytes received`);
  return lines;
}

/** One row of the `ss` table: a live TCP socket as the host sees it. */
export interface SsSocketView {
  readonly state: TcpState;
  /** `address:port`, or the wildcard `0.0.0.0:port` for a listener. */
  readonly local: string;
  /** `address:port`, or `0.0.0.0:*` while the peer is not known. */
  readonly peer: string;
  readonly cwnd: number;
  readonly ssthresh: number;
}

const SS_STATE_WIDTH = 12;
const SS_ADDRESS_WIDTH = 21;
const SS_NUMBER_WIDTH = 8;

/**
 * `ss` output: one aligned row per TCP socket with the connection state, both
 * endpoints and the congestion numbers (`cwnd`, `ssthresh`) the UI plots.
 *
 * The header is part of the contract so an empty host still prints something;
 * columns are padded to fixed widths, never shrunk to the content.
 */
export function formatSsLines(
  rows: ReadonlyArray<SsSocketView>,
): Array<string> {
  const header =
    "State".padEnd(SS_STATE_WIDTH) +
    " " +
    "Local Address".padEnd(SS_ADDRESS_WIDTH) +
    " " +
    "Peer Address".padEnd(SS_ADDRESS_WIDTH) +
    " " +
    "Cwnd".padStart(SS_NUMBER_WIDTH) +
    " " +
    "Ssthresh".padStart(SS_NUMBER_WIDTH);
  const lines = [header.trimEnd()];
  for (const row of rows) {
    lines.push(
      row.state.padEnd(SS_STATE_WIDTH) +
        " " +
        row.local.padEnd(SS_ADDRESS_WIDTH) +
        " " +
        row.peer.padEnd(SS_ADDRESS_WIDTH) +
        " " +
        String(row.cwnd).padStart(SS_NUMBER_WIDTH) +
        " " +
        String(row.ssthresh).padStart(SS_NUMBER_WIDTH),
    );
  }
  return lines;
}

/** One HTTP response as `curl` prints it: status plus the decoded body. */
export interface HttpGetView {
  readonly statusCode: number;
  readonly reason: string;
  readonly body: string;
}

/**
 * `curl` output: the body of a 200 response, line by line.
 *
 * Non-200 answers are prefixed with one diagnostic line and still print the
 * body (the server sends a short HTML message). The body is ASCII and CRLF is
 * normalized away, so the lines are stable across runs.
 */
export function formatHttpGetLines(view: HttpGetView): Array<string> {
  const lines: Array<string> = [];
  if (view.statusCode !== 200) {
    const reason = view.reason.length === 0 ? "" : ` ${view.reason}`;
    lines.push(`curl: HTTP ${view.statusCode}${reason}`);
  }
  if (view.body.length === 0) {
    return lines;
  }
  const body = view.body.split("\n");
  if (body.at(-1) === "") {
    body.pop();
  }
  for (const line of body) {
    lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
  return lines;
}
