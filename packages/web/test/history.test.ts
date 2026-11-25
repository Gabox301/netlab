import { describe, expect, test } from "bun:test";
import {
  applyLinkPreset,
  canRedoHistory,
  canUndoHistory,
  createHistory,
  exampleTopology,
  historyPush,
  historyRedo,
  historyUndo,
} from "../src/lib/topology";

describe("history (F-84)", () => {
  test("push/undo/redo round-trips a snapshot", () => {
    let history = createHistory();
    expect(canUndoHistory(history)).toBe(false);
    const base = exampleTopology();
    history = historyPush(history, base);
    expect(canUndoHistory(history)).toBe(true);
    const moved = { ...base, seed: 99 };
    const undone = historyUndo(history, moved);
    if (undone === null) {
      throw new Error("se esperaba un paso atrás");
    }
    expect(undone.snapshot).toEqual(base);
    expect(canRedoHistory(undone.history)).toBe(true);
    const redone = historyRedo(undone.history, undone.snapshot);
    if (redone === null) {
      throw new Error("se esperaba un paso adelante");
    }
    expect(redone.snapshot).toEqual(moved);
    expect(canUndoHistory(redone.history)).toBe(true);
    expect(canRedoHistory(redone.history)).toBe(false);
  });

  test("empty stacks return null", () => {
    const history = createHistory();
    expect(historyUndo(history, exampleTopology())).toBeNull();
    expect(historyRedo(history, exampleTopology())).toBeNull();
  });

  test("push discards the redo stack", () => {
    const history = historyPush(createHistory(), exampleTopology());
    const undone = historyUndo(history, { ...exampleTopology(), seed: 1 });
    if (undone === null) {
      throw new Error("se esperaba un paso atrás");
    }
    expect(canRedoHistory(undone.history)).toBe(true);
    const pushed = historyPush(undone.history, {
      ...exampleTopology(),
      seed: 2,
    });
    expect(canRedoHistory(pushed)).toBe(false);
    expect(pushed.past).toHaveLength(1);
  });

  test("in-place edits after push never corrupt the stored snapshot", () => {
    const live = exampleTopology();
    const history = historyPush(createHistory(), live);
    const node = live.nodes[0];
    const link = live.links[0];
    if (node === undefined || link === undefined) {
      throw new Error("fixture sin nodos o cables");
    }
    node.x += 500;
    link.params.latencyUs = 99999;
    const undone = historyUndo(history, live);
    expect(undone?.snapshot.nodes[0]?.x).toBe(exampleTopology().nodes[0]?.x);
    expect(undone?.snapshot.links[0]?.params.latencyUs).toBe(10);
  });

  test("nested preset objects are cloned, not shared", () => {
    const wifi = applyLinkPreset(exampleTopology(), "l1", "wifi-inestable");
    const history = historyPush(createHistory(), wifi);
    const burst = wifi.links[0]?.params.burst;
    if (burst === undefined) {
      throw new Error("el preset wifi deberia traer burst");
    }
    burst.pGoodToBad = 0.9;
    const undone = historyUndo(history, wifi);
    expect(undone?.snapshot.links[0]?.params.burst).toMatchObject({
      pGoodToBad: 0.02,
    });
  });

  test("oldest steps drop off past the limit", () => {
    let history = createHistory();
    for (let seed = 0; seed < 4; seed += 1) {
      history = historyPush(history, { ...exampleTopology(), seed }, 2);
    }
    expect(history.past).toHaveLength(2);
    const first = historyUndo(history, { ...exampleTopology(), seed: 99 });
    if (first === null) {
      throw new Error("se esperaba un paso atrás");
    }
    expect(first.snapshot.seed).toBe(3);
    const second = historyUndo(first.history, first.snapshot);
    if (second === null) {
      throw new Error("se esperaba un segundo paso atrás");
    }
    expect(second.snapshot.seed).toBe(2);
    expect(historyUndo(second.history, second.snapshot)).toBeNull();
  });
});
