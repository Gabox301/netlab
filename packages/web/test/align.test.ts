import { describe, expect, test } from "bun:test";
import {
  ALIGN_MODES,
  alignNodes,
  createHistory,
  exampleTopology,
  historyPush,
  historyUndo,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "../src/lib/topology";

describe("align (F-84)", () => {
  test("ships the six alignment modes", () => {
    expect(ALIGN_MODES).toEqual([
      "left",
      "centerX",
      "right",
      "top",
      "centerY",
      "bottom",
    ]);
  });

  test("left/right/centerX align the x edges", () => {
    const base = exampleTopology();
    const names = ["h1", "h2", "h3"];
    const xs = names.map(
      (name) => base.nodes.find((node) => node.name === name)?.x ?? NaN,
    );
    const left = alignNodes(base, names, "left");
    for (const name of names) {
      expect(left.nodes.find((node) => node.name === name)?.x).toBe(
        Math.min(...xs),
      );
    }
    const right = alignNodes(base, names, "right");
    for (const name of names) {
      const x = right.nodes.find((node) => node.name === name)?.x ?? NaN;
      expect(x + NODE_WIDTH).toBe(Math.max(...xs.map((v) => v + NODE_WIDTH)));
    }
    const center = alignNodes(base, names, "centerX");
    const centers = names.map(
      (name) =>
        (center.nodes.find((node) => node.name === name)?.x ?? NaN) +
        NODE_WIDTH / 2,
    );
    expect(new Set(centers).size).toBe(1);
  });

  test("top/centerY/bottom align the y edges", () => {
    const base = exampleTopology();
    const names = ["h1", "h2", "h3"];
    const ys = names.map(
      (name) => base.nodes.find((node) => node.name === name)?.y ?? NaN,
    );
    const top = alignNodes(base, names, "top");
    for (const name of names) {
      expect(top.nodes.find((node) => node.name === name)?.y).toBe(
        Math.min(...ys),
      );
    }
    const bottom = alignNodes(base, names, "bottom");
    for (const name of names) {
      const y = bottom.nodes.find((node) => node.name === name)?.y ?? NaN;
      expect(y + NODE_HEIGHT).toBe(Math.max(...ys.map((v) => v + NODE_HEIGHT)));
    }
    const middle = alignNodes(base, names, "centerY");
    const centers = names.map(
      (name) =>
        (middle.nodes.find((node) => node.name === name)?.y ?? NaN) +
        NODE_HEIGHT / 2,
    );
    expect(new Set(centers).size).toBe(1);
  });

  test("fewer than two matches is a no-op", () => {
    const base = exampleTopology();
    expect(alignNodes(base, [], "left")).toBe(base);
    expect(alignNodes(base, ["h1"], "left")).toBe(base);
    expect(alignNodes(base, ["ghost"], "left")).toBe(base);
  });

  test("unknown names are ignored, known ones still align", () => {
    const base = exampleTopology();
    const res = alignNodes(base, ["ghost", "h1", "h2"], "left");
    const xs = ["h1", "h2"].map(
      (name) => base.nodes.find((node) => node.name === name)?.x ?? NaN,
    );
    for (const name of ["h1", "h2"]) {
      expect(res.nodes.find((node) => node.name === name)?.x).toBe(
        Math.min(...xs),
      );
    }
    expect(res.nodes.find((node) => node.name === "h3")?.x).toBe(
      base.nodes.find((node) => node.name === "h3")?.x,
    );
  });

  test("an align is a single undo step", () => {
    const base = exampleTopology();
    const h0 = historyPush(createHistory(), base);
    const res = alignNodes(base, ["h1", "h2", "h3"], "left");
    expect(res).not.toBe(base);
    const undone = historyUndo(h0, res);
    expect(undone?.snapshot).toEqual(base);
  });
});
