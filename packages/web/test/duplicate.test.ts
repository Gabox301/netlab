import { describe, expect, test } from "bun:test";
import {
  applyLinkPreset,
  createHistory,
  duplicateNodes,
  exampleTopology,
  historyPush,
  historyUndo,
} from "../src/lib/topology";

function nodeOf(topology: ReturnType<typeof exampleTopology>, name: string) {
  const node = topology.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) {
    throw new Error(`fixture sin nodo "${name}"`);
  }
  return node;
}

describe("duplicate (F-84)", () => {
  test("duplicates a host with a fresh name and MACs", () => {
    const base = exampleTopology();
    const src = nodeOf(base, "h1");
    const res = duplicateNodes(base, ["h1"]);
    expect(res.names).toHaveLength(1);
    const name = res.names[0];
    if (name === undefined) {
      throw new Error("se esperaba un nombre");
    }
    expect(name).not.toBe("h1");
    const dst = nodeOf(res.topology, name);
    expect(dst.x).toBe(src.x + 32);
    expect(dst.y).toBe(src.y + 32);
    expect(dst.interfaces.map((iface) => iface.name)).toEqual(
      src.interfaces.map((iface) => iface.name),
    );
    for (const iface of dst.interfaces) {
      expect(iface.mac).toMatch(/^02:00:00:00:/);
    }
    expect(
      new Set([
        ...src.interfaces.map((iface) => iface.mac),
        ...dst.interfaces.map((iface) => iface.mac),
      ]).size,
    ).toBe(src.interfaces.length + dst.interfaces.length);
    // Everything else travels verbatim: normalize the fresh fields out.
    const norm = (node: typeof src) => ({
      ...node,
      name: "",
      x: 0,
      y: 0,
      interfaces: node.interfaces.map((iface) => ({ ...iface, mac: "" })),
    });
    expect(norm(dst)).toEqual(norm(src));
  });

  test("copies internal cables with remapped endpoints and cloned params", () => {
    const wifi = applyLinkPreset(exampleTopology(), "l2", "wifi-inestable");
    const res = duplicateNodes(wifi, ["r1", "h2"]);
    expect(res.names).toHaveLength(2);
    expect(res.linkIds).toHaveLength(1);
    const linkId = res.linkIds[0];
    if (linkId === undefined) {
      throw new Error("se esperaba un cable");
    }
    const link = res.topology.links.find(
      (candidate) => candidate.id === linkId,
    );
    if (link === undefined) {
      throw new Error("cable duplicado perdido");
    }
    const newR = res.names[0];
    const newH = res.names[1];
    if (newR === undefined || newH === undefined) {
      throw new Error("se esperaban dos nombres");
    }
    expect(link.a).toEqual({ node: newH, iface: "eth0" });
    expect(link.b).toEqual({ node: newR, iface: "p1" });
    const srcParams = wifi.links.find(
      (candidate) => candidate.id === "l2",
    )?.params;
    if (srcParams === undefined) {
      throw new Error("fixture sin cable l2");
    }
    expect(link.params).toEqual(srcParams);
    expect(link.params).not.toBe(srcParams);
  });

  test("drops cables that leave the duplicated set", () => {
    const base = exampleTopology();
    const res = duplicateNodes(base, ["h1"]);
    expect(res.linkIds).toHaveLength(0);
    expect(res.topology.links).toHaveLength(base.links.length);
  });

  test("missing nodes fail before touching the canvas", () => {
    expect(() => duplicateNodes(exampleTopology(), ["ghost"])).toThrow(
      /no existe el dispositivo/,
    );
  });

  test("pasting twice cascades without reusing names", () => {
    const first = duplicateNodes(exampleTopology(), ["h1"]);
    const firstName = first.names[0];
    if (firstName === undefined) {
      throw new Error("se esperaba un nombre");
    }
    const second = duplicateNodes(first.topology, [firstName]);
    const secondName = second.names[0];
    if (secondName === undefined) {
      throw new Error("se esperaba un segundo nombre");
    }
    expect(secondName).not.toBe(firstName);
    expect(secondName).not.toBe("h1");
    const srcX = nodeOf(exampleTopology(), "h1").x;
    expect(nodeOf(second.topology, secondName).x).toBe(srcX + 64);
  });

  test("a duplicate is a single undo step", () => {
    const base = exampleTopology();
    const h0 = historyPush(createHistory(), base);
    const res = duplicateNodes(base, ["h1", "r1"]);
    const undone = historyUndo(h0, res.topology);
    expect(undone?.snapshot).toEqual(base);
  });
});
