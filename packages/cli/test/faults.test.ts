/**
 * Scenario-level fault injection (F-100): `cut` / `restore` / `restart` /
 * `flushArp` actions are executed by `runScenario` at their virtual time, so
 * an exercise can ship a preinstalled fault and a diagnosis that fixes it.
 *
 * The observable evidence is the shell transcript (a ping that fails and then
 * works) plus the traces (`link_down` drops), never wall-clock time.
 */

import { describe, expect, test } from "bun:test";
import type { Trace } from "@netlab/core";
import {
  ARP_OP_REQUEST,
  ETHERTYPE_ARP,
  parseArp,
  parseEthernet,
} from "@netlab/protocols";
import { runScenario } from "../src/run";
import { parseScenarioJson, type Scenario } from "../src/scenario";

const IP_H1 = "10.0.0.1";
const IP_H2 = "10.0.0.2";
const MAC_H1 = "02:00:00:00:00:01";
const MAC_H2 = "02:00:00:00:00:02";
const LINK_ID = "l1";
const LATENCY_US = 10;

function hostNodes(): Array<Record<string, unknown>> {
  return [
    {
      type: "host",
      id: "h1",
      interfaces: [
        { name: "eth0", mac: MAC_H1, ip: IP_H1, mask: "255.255.255.0" },
      ],
    },
    {
      type: "host",
      id: "h2",
      interfaces: [
        { name: "eth0", mac: MAC_H2, ip: IP_H2, mask: "255.255.255.0" },
      ],
    },
  ];
}

function linkDefs(): Array<Record<string, unknown>> {
  return [
    {
      id: LINK_ID,
      a: { node: "h1", iface: "eth0" },
      b: { node: "h2", iface: "eth0" },
      params: { latencyUs: LATENCY_US },
    },
  ];
}

/** A valid scenario around one list of actions. */
function scenarioWith(
  actions: Array<Record<string, unknown>>,
  until = "2s",
): Scenario {
  return parseScenarioJson({
    version: 1,
    seed: 3,
    until,
    nodes: hostNodes(),
    links: linkDefs(),
    actions,
  });
}

/**
 * The same preinstalled fault every exercise ships: the cable is cut before
 * anything happens. With `restore` the cable comes back before the probe.
 */
function cutScenario(restore: boolean): Scenario {
  const actions: Array<Record<string, unknown>> = [{ at: 0, cut: LINK_ID }];
  if (restore) {
    actions.push({ at: "1ms", restore: LINK_ID });
  }
  actions.push({ at: "2ms", host: "h1", exec: `ping -c 1 ${IP_H2}` });
  return scenarioWith(actions);
}

function transcript(
  result: Awaited<ReturnType<typeof runScenario>>,
  index: number,
): string {
  const entry = result.shellTranscripts[index];
  if (entry === undefined) {
    throw new Error(`scenario produced no transcript ${index}`);
  }
  if (entry.error !== undefined) {
    throw new Error(`shell action failed: ${entry.error}`);
  }
  return entry.lines?.join("\n") ?? "";
}

function arpRequests(traces: ReadonlyArray<Trace>): number {
  let count = 0;
  for (const trace of traces) {
    if (trace.kind !== "frame_tx" || trace.link !== LINK_ID) {
      continue;
    }
    const eth = parseEthernet(trace.frame);
    if (!eth.ok || eth.value.etherType !== ETHERTYPE_ARP) {
      continue;
    }
    const arp = parseArp(eth.value.payload);
    if (arp.ok && arp.value.oper === ARP_OP_REQUEST) {
      count += 1;
    }
  }
  return count;
}

describe("scenario fault actions (F-100)", () => {
  test("parses cut/restore/restart/flushArp actions", () => {
    const scenario = scenarioWith([
      { at: 0, cut: LINK_ID },
      { at: "1ms", restore: LINK_ID },
      { at: "2ms", restart: "h1" },
      { at: "3ms", flushArp: "h1" },
      { at: "4ms", flushArp: "h1", iface: "eth0" },
    ]);
    expect(scenario.actions).toEqual([
      { at: 0, cut: LINK_ID },
      { at: "1ms", restore: LINK_ID },
      { at: "2ms", restart: "h1" },
      { at: "3ms", flushArp: "h1" },
      { at: "4ms", flushArp: "h1", iface: "eth0" },
    ]);
  });

  test("rejects fault actions without a valid target", () => {
    expect(() => scenarioWith([{ cut: 5 }])).toThrow(
      /actions\[0\]: "cut" must be a non-empty string/,
    );
    expect(() => scenarioWith([{ restore: "" }])).toThrow(
      /actions\[0\]: "restore" must be a non-empty string/,
    );
    expect(() => scenarioWith([{ restart: 7 }])).toThrow(
      /actions\[0\]: "restart" must be a non-empty string/,
    );
    expect(() => scenarioWith([{ flushArp: "h1", iface: 7 }])).toThrow(
      /actions\[0\]: "iface" must be a non-empty string/,
    );
  });

  test("a preinstalled cut makes the ping fail with link_down drops", async () => {
    const result = await runScenario(cutScenario(false));

    expect(transcript(result, 0)).toContain(
      "1 packets transmitted, 0 received, 100.0% packet loss",
    );
    const dropped = result.traces.filter(
      (trace) => trace.kind === "frame_drop",
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]).toMatchObject({ reason: "link_down", link: LINK_ID });
  });

  test("the same scenario with restore makes the ping succeed", async () => {
    const result = await runScenario(cutScenario(true));

    expect(transcript(result, 0)).toContain(
      "1 packets transmitted, 1 received, 0.0% packet loss",
    );
    expect(
      result.traces.filter((trace) => trace.kind === "frame_drop"),
    ).toHaveLength(0);
  });

  test("flushArp and restart force a fresh ARP resolution", async () => {
    const scenario = scenarioWith(
      [
        { at: "1ms", host: "h1", exec: `ping -c 1 ${IP_H2}` },
        { at: "2s", flushArp: "h1" },
        { at: "2.1s", host: "h1", exec: `ping -c 1 ${IP_H2}` },
        { at: "4s", restart: "h1" },
        { at: "4.1s", host: "h1", exec: `ping -c 1 ${IP_H2}` },
      ],
      "6s",
    );
    const result = await runScenario(scenario);

    for (const index of [0, 1, 2]) {
      expect(transcript(result, index)).toContain("0.0% packet loss");
    }
    expect(arpRequests(result.traces)).toBe(3);
    expect(
      result.traces.filter((trace) => trace.kind === "frame_drop"),
    ).toHaveLength(0);
  });

  test("rejects unknown link and host targets", async () => {
    await expect(
      runScenario(scenarioWith([{ at: 0, cut: "nope" }])),
    ).rejects.toThrow(/unknown link "nope"/);
    await expect(
      runScenario(scenarioWith([{ at: 0, restore: "nope" }])),
    ).rejects.toThrow(/unknown link "nope"/);
    await expect(
      runScenario(scenarioWith([{ at: 0, restart: "nope" }])),
    ).rejects.toThrow(/unknown host "nope"/);
    await expect(
      runScenario(scenarioWith([{ at: 0, flushArp: "h1", iface: "eth9" }])),
    ).rejects.toThrow(/no interface named "eth9"/);
  });

  test("same seed replays the same fault trace", async () => {
    const signature = async (): Promise<Array<string>> => {
      const result = await runScenario(cutScenario(true), { seed: 9 });
      return result.traces.map((trace) => {
        if (trace.kind === "frame_tx") {
          return `${trace.kind}:${trace.link}:${trace.from}:${trace.length}:${trace.t}`;
        }
        if (trace.kind === "frame_rx") {
          return `${trace.kind}:${trace.link}:${trace.to}:${trace.length}:${trace.t}`;
        }
        if (trace.kind === "frame_drop") {
          return `${trace.kind}:${trace.link}:${trace.reason}:${trace.t}`;
        }
        return `${trace.kind}:${trace.t}`;
      });
    };
    expect(await signature()).toEqual(await signature());
  });
});
