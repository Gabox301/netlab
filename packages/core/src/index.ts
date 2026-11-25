/**
 * @netlab/core: deterministic discrete-event simulation.
 *
 * No Bun/Node/DOM APIs here: the engine runs identically in Bun, the
 * browser (Web Worker) and Node. Virtual time is integer microseconds as a
 * `number`; randomness flows only through `Simulation.random`.
 */

export {
  connect,
  Device,
  type InterfaceCounters,
  type InterfaceOptions,
  NetworkInterface,
} from "./devices";
export {
  DEFAULT_DHCP_LEASE_TIME_SECONDS,
  DEFAULT_DHCP_RETRIES,
  DEFAULT_DHCP_TIMEOUT_US,
  DHCP_REBIND_RATIO,
  DHCP_RENEW_RATIO,
  DhcpClient,
  type DhcpClientLease,
  type DhcpClientOptions,
  type DhcpClientState,
  type DhcpClientStats,
  type DhcpLease,
  type DhcpLeaseState,
  DhcpServer,
  type DhcpServerOptions,
  type DhcpServerStats,
} from "./dhcp";
export {
  DEFAULT_DNS_PORT,
  DEFAULT_DNS_RETRIES,
  DEFAULT_DNS_TIMEOUT_US,
  DEFAULT_DNS_TTL_SECONDS,
  type DnsResolution,
  type DnsResolutionStatus,
  DnsResolver,
  type DnsResolverOptions,
  DnsServer,
  type DnsServerOptions,
  type DnsZone,
} from "./dns";
export {
  Host,
  type HostEchoReply,
  type HostIcmpError,
  type HostInterfaceOptions,
  type HostIpConfig,
  type HostIpConfigInput,
  type HostIpv4SendOptions,
  type HostOptions,
  type HostPayloadHandler,
  type HostPingHandle,
  type HostPingOptions,
  type HostTcpHandler,
  type HostTcpSegment,
  type HostTcpSendHandle,
  type HostTcpSendOptions,
  type HostTcpSocket,
} from "./host";
export {
  type BurstLoss,
  Link,
  type LinkParams,
  type Port,
} from "./link";
export { Mulberry32 } from "./prng";
export {
  DEFAULT_REASSEMBLY_MAX_BYTES,
  DEFAULT_REASSEMBLY_TIMEOUT_US,
  fragmentKey,
  isFragmented,
  Reassembler,
  type ReassemblyDropReason,
  type ReassemblyExpiry,
  type ReassemblyKey,
  type ReassemblyOptions,
  type ReassemblyResult,
} from "./reassembly";
export {
  DEFAULT_IPV4_MTU,
  DEFAULT_IPV4_TTL,
  fragmentIpv4Datagram,
  parseIpv4Prefix,
  prefixFromMask,
  prefixToMask,
  type RouteEntry,
  type RouteKind,
  Router,
  type RouterOptions,
  type RouterPortConfig,
  type RouterPortOptions,
  type RouteSpec,
  RoutingTable,
  resolveOptionalPrefix,
  sameSubnet,
  splitIpv4Prefix,
} from "./route";
export { DEFAULT_MAX_EVENTS, Simulation, type TimerHandle } from "./sim";
export {
  DEFAULT_AGING_TIME_US,
  DEFAULT_VLAN_ID,
  Hub,
  type MacTableEntry,
  Switch,
  type SwitchOptions,
  type VlanPortConfig,
  type VlanPortMode,
} from "./switch";
export {
  DEFAULT_MAX_RTO_US,
  DEFAULT_RTO_US,
  DEFAULT_TIME_WAIT_US,
  type TcpConnectOptions,
  TcpSocket,
  type TcpSocketOptions,
  type TcpState,
} from "./tcp";
export {
  type DropReason,
  type EndpointId,
  type Trace,
  TraceBus,
} from "./trace";
