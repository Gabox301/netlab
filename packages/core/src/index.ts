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
  type HostInterfaceOptions,
  type HostOptions,
  type HostPayloadHandler,
} from "./host";
export {
  type BurstLoss,
  Link,
  type LinkParams,
  type Port,
} from "./link";
export { Mulberry32 } from "./prng";
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
