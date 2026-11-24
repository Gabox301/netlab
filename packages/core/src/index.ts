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
  Hub,
  type MacTableEntry,
  Switch,
  type SwitchOptions,
} from "./switch";
export {
  type DropReason,
  type EndpointId,
  type Trace,
  TraceBus,
} from "./trace";
