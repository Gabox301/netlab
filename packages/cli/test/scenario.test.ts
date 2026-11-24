import { describe, expect, test } from "bun:test";
import {
  decodePayload,
  parseDurationToUs,
  parseEtherType,
  parseScenarioJson,
} from "../src/scenario";

describe("scenario parsing", () => {
  test("accepts a minimal v1 host scenario", () => {
    const scenario = parseScenarioJson({
      version: 1,
      seed: 7,
      until: "2ms",
      nodes: [
        {
          type: "host",
          id: "h1",
          interfaces: [
            { name: "eth0", mac: "02:00:00:00:00:0a", ip: "10.0.0.1" },
          ],
        },
      ],
      links: [],
      actions: [],
    });
    expect(scenario.version).toBe(1);
    expect(scenario.seed).toBe(7);
    expect(scenario.nodes).toHaveLength(1);
  });

  test("rejects unknown versions", () => {
    expect(() =>
      parseScenarioJson({ version: 2, nodes: [], links: [], actions: [] }),
    ).toThrow(/version/);
  });

  test("rejects duplicate node ids", () => {
    expect(() =>
      parseScenarioJson({
        version: 1,
        nodes: [
          { type: "hub", id: "h", ports: [{ name: "p1" }] },
          { type: "hub", id: "h", ports: [{ name: "p1" }] },
        ],
        links: [],
        actions: [],
      }),
    ).toThrow(/duplicate node id/);
  });

  test("parses durations", () => {
    expect(parseDurationToUs("10s", 0)).toBe(10_000_000);
    expect(parseDurationToUs("100ms", 0)).toBe(100_000);
    expect(parseDurationToUs("500us", 0)).toBe(500);
    expect(parseDurationToUs(42, 0)).toBe(42);
    expect(parseDurationToUs(undefined, 5)).toBe(5);
    expect(() => parseDurationToUs("soon", 0)).toThrow(/duration/);
  });

  test("parses ether types", () => {
    expect(parseEtherType(undefined, "p")).toBe(0x0800);
    expect(parseEtherType(0x0806, "p")).toBe(0x0806);
    expect(parseEtherType("0x0806", "p")).toBe(0x0806);
    expect(() => parseEtherType("arp", "p")).toThrow(/etherType/);
  });

  test("decodes hex payloads", () => {
    expect(decodePayload("ff00", "hex", "p")).toEqual(
      new Uint8Array([0xff, 0x00]),
    );
    expect(() => decodePayload("zz", "hex", "p")).toThrow(/hex/);
  });
});
