/**
 * Shared topologies for the shell tests: one plain link and the two-subnet
 * fixture of S8 (A -- r1 -- B), always with virtual-time-only links.
 */

import {
  connect,
  Host,
  Link,
  Router,
  Simulation,
  TraceBus,
} from "@netlab/core";

/** One-way propagation delay used by every lab link. */
export const LATENCY_US = 10;

export const MASK_24 = "255.255.255.0";

export const MAC_A = "02:00:00:00:00:0a";
export const MAC_B = "02:00:00:00:00:0b";
export const MAC_R1 = "02:00:00:00:00:01";
export const MAC_R2 = "02:00:00:00:00:02";

export const IP_A = "10.0.0.2";
export const IP_B_SAME_SUBNET = "10.0.0.3";
export const IP_B = "10.0.1.2";
export const IP_R1_A = "10.0.0.1";
export const IP_R1_B = "10.0.1.1";
export const IP_MISSING = "10.0.0.99";

export interface SameSubnetLab {
  sim: Simulation;
  bus: TraceBus;
  a: Host;
  b: Host;
}

export interface TwoSubnetLab extends SameSubnetLab {
  router: Router;
}

function link(sim: Simulation, bus: TraceBus, id: string): Link {
  return new Link(sim, id, { latencyUs: LATENCY_US }, bus);
}

/** A and B on one link. */
export function sameSubnetLab(seed = 5): SameSubnetLab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  connect(
    link(sim, bus, "l0"),
    a.addInterface("eth0", {
      mac: MAC_A,
      ip: IP_A,
      mask: MASK_24,
    }),
    b.addInterface("eth0", { mac: MAC_B, ip: IP_B_SAME_SUBNET, mask: MASK_24 }),
  );
  return { sim, bus, a, b };
}

/** A -- r1 -- B with a gateway on each host, the S8 shape. */
export function twoSubnetLab(seed = 7): TwoSubnetLab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const router = new Router(sim, "r1", bus);
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  connect(
    link(sim, bus, "l1"),
    a.addInterface("eth0", {
      mac: MAC_A,
      ip: IP_A,
      mask: MASK_24,
      gateway: IP_R1_A,
    }),
    router.addPort("p1", { mac: MAC_R1, ip: IP_R1_A, prefixLength: 24 }),
  );
  connect(
    link(sim, bus, "l2"),
    router.addPort("p2", { mac: MAC_R2, ip: IP_R1_B, prefixLength: 24 }),
    b.addInterface("eth0", {
      mac: MAC_B,
      ip: IP_B,
      mask: MASK_24,
      gateway: IP_R1_B,
    }),
  );
  return { sim, bus, a, b, router };
}
