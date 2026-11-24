/**
 * @netlab/core: deterministic discrete-event simulation.
 *
 * No Bun/Node/DOM APIs here: the engine runs identically in Bun, the
 * browser (Web Worker) and Node. Virtual time is integer microseconds as a
 * `number`; randomness flows only through `Simulation.random`.
 */

export { Mulberry32 } from "./prng";
export { DEFAULT_MAX_EVENTS, Simulation, type TimerHandle } from "./sim";
export {
  Link,
  type BurstLoss,
  type LinkParams,
  type Port,
} from "./link";
export {
  TraceBus,
  type DropReason,
  type EndpointId,
  type Trace,
} from "./trace";
