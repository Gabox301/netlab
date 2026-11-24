/**
 * `ping` against the real Host + Simulation (S7): replies, RTT statistics
 * from virtual time, loss accounting and ICMP errors.
 */

import { describe, expect, test } from "bun:test";
import { Host, Simulation, TraceBus } from "@netlab/core";
import { Shell, type ShellErrorCode } from "../src/index";
import {
  IP_A,
  IP_B,
  IP_B_SAME_SUBNET,
  IP_MISSING,
  IP_R1_A,
  MAC_A,
  sameSubnetLab,
  twoSubnetLab,
} from "./lab";

function rttStats(line: string | undefined): {
  min: number;
  avg: number;
  max: number;
} {
  if (line === undefined) {
    throw new Error("expected an rtt statistics line");
  }
  const match = /^rtt min\/avg\/max = (\d+)\/(\d+)\/(\d+) us$/.exec(line);
  if (match === null) {
    throw new Error(`unexpected rtt line: ${line}`);
  }
  return {
    min: Number(match[1]),
    avg: Number(match[2]),
    max: Number(match[3]),
  };
}

function errorCode(error: unknown): ShellErrorCode | "not-a-shell-error" {
  if (error instanceof Error && "code" in error) {
    return (error as { code: ShellErrorCode }).code;
  }
  return "not-a-shell-error";
}

describe("ping on-link (S7)", () => {
  test("counts replies and reports min/avg/max from the virtual clock", async () => {
    const lab = sameSubnetLab(81);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec("ping -c 2 10.0.0.3");
    expect(lines[0]).toBe(
      `PING ${IP_B_SAME_SUBNET} (${IP_B_SAME_SUBNET}): 56 data bytes`,
    );
    const replies = lines.filter((line) => line.includes("bytes from"));
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatch(
      /^64 bytes from 10\.0\.0\.3: icmp_seq=1 ttl=64 time=\d+ us$/,
    );
    expect(replies[1]).toMatch(
      /^64 bytes from 10\.0\.0\.3: icmp_seq=2 ttl=64 time=\d+ us$/,
    );
    expect(lines).toContain(`--- ${IP_B_SAME_SUBNET} ping statistics ---`);
    expect(lines).toContain(
      "2 packets transmitted, 2 received, 0.0% packet loss",
    );
    const stats = rttStats(lines[lines.length - 1]);
    expect(stats.min).toBeGreaterThan(0);
    expect(stats.min).toBeLessThanOrEqual(stats.avg);
    expect(stats.avg).toBeLessThanOrEqual(stats.max);

    // The command advanced virtual time by the ping interval, nothing more.
    expect(lab.sim.now).toBe(2_000_000);
  });

  test("honours -s and reports the ICMP message length", async () => {
    const lab = sameSubnetLab(83);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec("ping -c 1 -s 16 10.0.0.3");
    expect(lines[0]).toBe(
      `PING ${IP_B_SAME_SUBNET} (${IP_B_SAME_SUBNET}): 16 data bytes`,
    );
    expect(lines[1]).toMatch(
      /^24 bytes from 10\.0\.0\.3: icmp_seq=1 ttl=64 time=\d+ us$/,
    );
    expect(lines).toContain(
      "1 packets transmitted, 1 received, 0.0% packet loss",
    );
    expect(lines[lines.length - 1]).toMatch(
      /^rtt min\/avg\/max = \d+\/\d+\/\d+ us$/,
    );
  });
});

describe("ping across subnets (S7 + S8)", () => {
  test("reaches the destination through the router", async () => {
    const lab = twoSubnetLab(87);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec("ping -c 2 10.0.1.2");
    const replies = lines.filter((line) => line.includes("bytes from"));
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatch(
      /^64 bytes from 10\.0\.1\.2: icmp_seq=1 ttl=63 time=\d+ us$/,
    );
    expect(lines).toContain(
      "2 packets transmitted, 2 received, 0.0% packet loss",
    );
    expect(lines[lines.length - 1]).toMatch(
      /^rtt min\/avg\/max = \d+\/\d+\/\d+ us$/,
    );
  });

  test("surfaces Time Exceeded from the first router when TTL is 1", async () => {
    const lab = twoSubnetLab(89);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec("ping -c 1 -t 1 10.0.1.2");
    expect(lines).toEqual([
      `PING ${IP_B} (${IP_B}): 56 data bytes`,
      `From ${IP_R1_A} icmp_seq=1 Time to live exceeded`,
      `--- ${IP_B} ping statistics ---`,
      "1 packets transmitted, 0 received, 100.0% packet loss",
    ]);
  });
});

describe("ping loss accounting (S7)", () => {
  test("counts an unanswered request as loss and omits the rtt summary", async () => {
    const lab = sameSubnetLab(91);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec(`ping -c 1 ${IP_MISSING}`);
    expect(lines).toEqual([
      `PING ${IP_MISSING} (${IP_MISSING}): 56 data bytes`,
      `--- ${IP_MISSING} ping statistics ---`,
      "1 packets transmitted, 0 received, 100.0% packet loss",
    ]);
    expect(lab.sim.now).toBe(1_000_000);
  });

  test("turns a routing failure into a typed execution error", async () => {
    const sim = new Simulation(97);
    const bus = new TraceBus();
    const a = new Host(sim, "a", bus);
    a.addInterface("eth0", { mac: MAC_A });
    const shell = new Shell({ host: a, sim });

    let caught: unknown;
    try {
      await shell.exec(`ping -c 1 ${IP_A}`);
    } catch (error) {
      caught = error;
    }
    expect(errorCode(caught)).toBe("execution_failed");
    expect(String(caught)).toMatch(/IPv4|address|route/i);
    expect(sim.now).toBe(0);
    expect(bus.length).toBe(0);
  });
});

describe("ping defaults", () => {
  test("uses 4 requests by default", async () => {
    const lab = sameSubnetLab(99);
    const shell = new Shell({ host: lab.a, sim: lab.sim });
    const lines = await shell.exec(`ping ${IP_B_SAME_SUBNET}`);
    expect(lines.filter((line) => line.includes("bytes from"))).toHaveLength(4);
    expect(lines).toContain(
      "4 packets transmitted, 4 received, 0.0% packet loss",
    );
    expect(lab.sim.now).toBe(4_000_000);
  });
});

describe("ping configuration", () => {
  test("respects an injected virtual timeout", async () => {
    const lab = sameSubnetLab(101);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      pingTimeoutUs: 500,
    });
    const lines = await shell.exec(`ping -c 2 ${IP_B_SAME_SUBNET}`);
    // A 10 us link still answers well inside the 500 us window.
    expect(lines.filter((line) => line.includes("bytes from"))).toHaveLength(2);
  });
});
