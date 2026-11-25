import { describe, expect, test } from "bun:test";
import {
  applyLinkPreset,
  exampleTopology,
  parseSavedTopology,
  serializeTopology,
} from "../src/lib/topology";

describe("saved topologies (F-130)", () => {
  test("round-trips positions and impairments", () => {
    const base = applyLinkPreset(exampleTopology(), "l1", "wifi-inestable");
    const text = serializeTopology(base);
    expect(typeof text).toBe("string");
    const rebuilt = parseSavedTopology(text);
    expect(rebuilt).toEqual(base);
  });

  test("rejects garbage before touching the canvas", () => {
    for (const bad of [
      "{nope",
      "[]",
      "null",
      JSON.stringify({ version: 2, savedAt: "x", topology: {} }),
      JSON.stringify({ version: 1, savedAt: "x", topology: { seed: 0 } }),
      JSON.stringify({ version: 1, savedAt: "x" }),
    ]) {
      expect(() => parseSavedTopology(bad), bad).toThrow();
    }
  });

  test("rejects topologies that could never run", () => {
    const base = exampleTopology();
    const broken = {
      version: 1 as const,
      savedAt: new Date(0).toISOString(),
      topology: { ...base, nodes: [{ name: "h1" }] },
    };
    expect(() => parseSavedTopology(JSON.stringify(broken))).toThrow(
      /nodos|nodes|interfaz/i,
    );
  });
});
