/**
 * `@netlab/shell`: a minimal, deterministic network shell over a live Host
 * and Simulation (S5, S7, S9).
 *
 * ```ts
 * const shell = new Shell({ host, sim });
 * const lines = await shell.exec("ping -c 2 10.0.1.2");
 * ```
 *
 * Commands advance the virtual clock with `sim.runUntil()` and never wait
 * on wall-clock timers. Parse failures are typed (`parseCommandLine`) and
 * execution failures reject with `ShellCommandError`.
 */

export const PACKAGE = "@netlab/shell";

export {
  ShellCommandError,
  type ShellError,
  type ShellErrorCode,
  shellError,
} from "./errors";
export {
  hostNeighborEntries,
  type NeighborCandidate,
  type NeighborEntry,
  type NeighborProvider,
  sortNeighborEntries,
} from "./neighbors";
export {
  type ArpCommand,
  DEFAULT_HTTP_PORT,
  DEFAULT_PING_COUNT,
  DEFAULT_PING_SIZE,
  DEFAULT_PING_TTL,
  type DhclientCommand,
  type DigCommand,
  type HttpGetCommand,
  type HttpServerCommand,
  type IpAddrSetCommand,
  type IpAddrShowCommand,
  type IpLinkSetCommand,
  type IpLinkShowCommand,
  type IpNeighShowCommand,
  type IpRouteShowCommand,
  MAX_NC_PAYLOAD_BYTES,
  MAX_PING_COUNT,
  MAX_PING_SIZE,
  type NcTcpCommand,
  type NcUdpCommand,
  type PingCommand,
  parseCommandLine,
  type ShellCommand,
  type ShellParseResult,
  type SsCommand,
  type TracerouteCommand,
} from "./parse";
export {
  createShell,
  DEFAULT_DHCLIENT_RETRIES,
  DEFAULT_DHCLIENT_TIMEOUT_US,
  DEFAULT_DIG_RETRIES,
  DEFAULT_DIG_TIMEOUT_US,
  DEFAULT_NC_TIMEOUT_US,
  DEFAULT_PING_INTERVAL_US,
  DEFAULT_PING_TIMEOUT_US,
  DEFAULT_TRACEROUTE_MAX_HOPS,
  DEFAULT_TRACEROUTE_TIMEOUT_US,
  Shell,
  type ShellOptions,
} from "./shell";
