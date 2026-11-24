/**
 * `traceroute` over the real stack (S7/S8): TTL climbing from 1, one line
 * per answering hop, ending at the destination.
 */

import { describe, expect, test } from "bun:test";
import { Shell } from "../src/index";
import {
  IP_B,
  IP_B_SAME_SUBNET,
  IP_MISSING,
  IP_R1_A,
  sameSubnetLab,
  twoSubnetLab,
} from "./lab";

const HOP = /^(\d+) {2}(\d+\.\d+\.\d+\.\d+) {2}\d+ us$/;

describe("traceroute (S7)", () => {
  test("shows one line per hop through the router and ends at the destination", async () => {
    const lab = twoSubnetLab(111);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec(`traceroute ${IP_B}`);
    expect(lines[0]).toBe(`traceroute to ${IP_B} (${IP_B}), 30 hops max`);

    const hops = lines.slice(1);
    expect(hops).toHaveLength(2);
    const first = HOP.exec(hops[0] ?? "");
    const second = HOP.exec(hops[1] ?? "");
    if (first === null || second === null) {
      throw new Error(`unexpected traceroute lines: ${hops.join(" | ")}`);
    }
    expect(first[1]).toBe("1");
    expect(first[2]).toBe(IP_R1_A);
    expect(second[1]).toBe("2");
    expect(second[2]).toBe(IP_B);
  });

  test("stops at the destination on a single link", async () => {
    const lab = sameSubnetLab(113);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec(`traceroute ${IP_B_SAME_SUBNET}`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `traceroute to ${IP_B_SAME_SUBNET} (${IP_B_SAME_SUBNET}), 30 hops max`,
    );
    expect(lines[1]).toMatch(
      new RegExp(`^1  ${IP_B_SAME_SUBNET.replaceAll(".", "\\.")}  \\d+ us$`),
    );
  });

  test("prints a star per unanswered hop and respects the hop budget", async () => {
    const lab = sameSubnetLab(115);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      tracerouteMaxHops: 3,
    });

    const lines = await shell.exec(`traceroute ${IP_MISSING}`);
    expect(lines).toEqual([
      `traceroute to ${IP_MISSING} (${IP_MISSING}), 3 hops max`,
      "1  *",
      "2  *",
      "3  *",
    ]);
    expect(lab.sim.now).toBe(3_000_000);
  });

  test("advances only virtual time", async () => {
    const lab = twoSubnetLab(117);
    const shell = new Shell({ host: lab.a, sim: lab.sim });
    const wallStart = Date.now();
    await shell.exec(`traceroute ${IP_B}`);
    // Two virtual probes, at most 2 virtual seconds; wall time is irrelevant.
    expect(lab.sim.now).toBeLessThanOrEqual(2_000_000);
    expect(Date.now() - wallStart).toBeLessThan(1_000);
  });
});
