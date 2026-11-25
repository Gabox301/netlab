/**
 * F-113 / F-114 / T5: practice scoring and the versioned localStorage
 * progress document.
 *
 * The lib is pure: `scoreOf` is arithmetic over the authored hints, the
 * parser never throws (a corrupt draft reads as "no progress", never a
 * crash), and `recordAttempt` takes its clock as an argument, so every
 * assertion here is deterministic. A fake storage object covers the
 * localStorage round-trip without a browser.
 */

import { describe, expect, test } from "bun:test";
import type { ExerciseHint } from "@netlab/exercises";
import {
  emptyPracticeStore,
  emptyProgress,
  loadPracticeProgress,
  PRACTICE_PROGRESS_KEY,
  PRACTICE_PROGRESS_VERSION,
  type PracticeProgressStore,
  type PracticeStorage,
  parsePracticeProgress,
  progressOf,
  recordAttempt,
  savePracticeProgress,
  scoreOf,
  serializePracticeProgress,
} from "../src/lib/practice";

const HINTS: ReadonlyArray<ExerciseHint> = [
  { level: 1, text: "Mirá el trunk.", penalty: 10 },
  { level: 2, text: "La VLAN nativa.", penalty: 15 },
  { level: 3, text: "Es sw2 p1.", penalty: 25 },
];

const STORE: PracticeProgressStore = {
  version: PRACTICE_PROGRESS_VERSION,
  exercises: {
    "l2-vlan-isolated": {
      attempts: 2,
      bestScore: 90,
      hintsRevealed: 1,
      elapsedMs: 42_000,
      passedAt: "2025-01-02T03:04:05.000Z",
    },
    "tcp-handshake": {
      attempts: 1,
      bestScore: null,
      hintsRevealed: 0,
      elapsedMs: 1_500,
      passedAt: null,
    },
  },
};

/** In-memory `Storage` slice: the only two methods the lib touches. */
class FakeStorage implements PracticeStorage {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("scoreOf (F-113)", () => {
  test("subtracts the revealed penalties from 100", () => {
    expect(scoreOf(HINTS, 0)).toBe(100);
    expect(scoreOf(HINTS, 1)).toBe(90);
    expect(scoreOf(HINTS, 2)).toBe(75);
    expect(scoreOf(HINTS, 3)).toBe(50);
  });

  test("floors at 0 instead of going negative", () => {
    const brutal: ReadonlyArray<ExerciseHint> = [
      { level: 1, text: "a", penalty: 80 },
      { level: 2, text: "b", penalty: 80 },
    ];
    expect(scoreOf(brutal, 2)).toBe(0);
  });

  test("clamps the revealed count to the hint list", () => {
    expect(scoreOf(HINTS, 99)).toBe(50);
    expect(scoreOf(HINTS, -3)).toBe(100);
    expect(scoreOf(HINTS, 1.9)).toBe(90);
    expect(scoreOf([], 5)).toBe(100);
  });
});

describe("progress document (F-114)", () => {
  test("starts empty with the versioned key", () => {
    expect(PRACTICE_PROGRESS_KEY).toBe("netlab.practice.progress.v1");
    expect(emptyPracticeStore()).toEqual({
      version: PRACTICE_PROGRESS_VERSION,
      exercises: {},
    });
    expect(emptyProgress()).toEqual({
      attempts: 0,
      bestScore: null,
      hintsRevealed: 0,
      elapsedMs: 0,
      passedAt: null,
    });
    expect(progressOf(emptyPracticeStore(), "nope")).toEqual(emptyProgress());
  });

  test("round-trips a valid store", () => {
    const text = serializePracticeProgress(STORE);
    expect(parsePracticeProgress(text)).toEqual(STORE);
  });

  test("rejects malformed documents without throwing", () => {
    const broken: ReadonlyArray<string> = [
      "{nope",
      "[]",
      "null",
      JSON.stringify({ version: 2, exercises: {} }),
      JSON.stringify({ version: PRACTICE_PROGRESS_VERSION }),
      JSON.stringify({ version: PRACTICE_PROGRESS_VERSION, exercises: [] }),
      JSON.stringify({
        version: PRACTICE_PROGRESS_VERSION,
        exercises: { "": emptyProgress() },
      }),
      JSON.stringify({
        version: PRACTICE_PROGRESS_VERSION,
        exercises: { "l2-vlan-isolated": null },
      }),
    ];
    for (const text of broken) {
      expect(parsePracticeProgress(text), text).toBeNull();
    }
  });

  test("rejects malformed entries without throwing", () => {
    const badEntries: ReadonlyArray<Record<string, unknown>> = [
      {},
      { ...emptyProgress(), attempts: -1 },
      { ...emptyProgress(), attempts: 1.5 },
      { ...emptyProgress(), bestScore: 101 },
      { ...emptyProgress(), bestScore: -1 },
      { ...emptyProgress(), bestScore: "90" },
      { ...emptyProgress(), hintsRevealed: -1 },
      { ...emptyProgress(), hintsRevealed: 0.5 },
      { ...emptyProgress(), elapsedMs: -1 },
      { ...emptyProgress(), elapsedMs: "0" },
      { ...emptyProgress(), passedAt: "ayer" },
      { ...emptyProgress(), passedAt: 5 },
    ];
    for (const entry of badEntries) {
      const text = JSON.stringify({
        version: PRACTICE_PROGRESS_VERSION,
        exercises: { "l2-vlan-isolated": entry },
      });
      expect(parsePracticeProgress(text), text).toBeNull();
    }
  });

  test("tracks attempts, best score, hints and time per exercise", () => {
    const start = emptyPracticeStore();
    const first = recordAttempt(start, "l2-vlan-isolated", {
      pass: false,
      score: 70,
      hintsRevealed: 2,
      elapsedMs: 30_000,
      at: new Date("2025-05-01T10:00:00.000Z"),
    });
    expect(progressOf(first, "l2-vlan-isolated")).toEqual({
      attempts: 1,
      bestScore: 70,
      hintsRevealed: 2,
      elapsedMs: 30_000,
      passedAt: null,
    });
    // The recorder is pure: the previous store is untouched.
    expect(start).toEqual(emptyPracticeStore());

    const second = recordAttempt(first, "l2-vlan-isolated", {
      pass: true,
      score: 90,
      hintsRevealed: 1,
      elapsedMs: 20_000,
      at: new Date("2025-05-01T10:05:00.000Z"),
    });
    expect(progressOf(second, "l2-vlan-isolated")).toEqual({
      attempts: 2,
      bestScore: 90,
      hintsRevealed: 2,
      elapsedMs: 50_000,
      passedAt: "2025-05-01T10:05:00.000Z",
    });

    // A later pass keeps the first pass timestamp and never lowers a maximum.
    const third = recordAttempt(second, "l2-vlan-isolated", {
      pass: true,
      score: 80,
      hintsRevealed: 0,
      elapsedMs: 5_000,
      at: new Date("2025-05-02T10:00:00.000Z"),
    });
    expect(progressOf(third, "l2-vlan-isolated")).toEqual({
      attempts: 3,
      bestScore: 90,
      hintsRevealed: 2,
      elapsedMs: 55_000,
      passedAt: "2025-05-01T10:05:00.000Z",
    });
  });

  test("clamps out-of-range attempt values", () => {
    const store = recordAttempt(emptyPracticeStore(), "x", {
      pass: false,
      score: 140,
      hintsRevealed: -2,
      elapsedMs: -500,
      at: new Date("2025-05-01T10:00:00.000Z"),
    });
    expect(progressOf(store, "x")).toEqual({
      attempts: 1,
      bestScore: 100,
      hintsRevealed: 0,
      elapsedMs: 0,
      passedAt: null,
    });
  });

  test("load/save round-trip through a storage", () => {
    const storage = new FakeStorage();
    expect(loadPracticeProgress(storage)).toEqual(emptyPracticeStore());

    savePracticeProgress(STORE, storage);
    expect(storage.map.get(PRACTICE_PROGRESS_KEY)).toBe(
      serializePracticeProgress(STORE),
    );
    expect(loadPracticeProgress(storage)).toEqual(STORE);
  });

  test("a corrupt draft reads as empty and a refused write never throws", () => {
    const corrupt = new FakeStorage();
    corrupt.map.set(PRACTICE_PROGRESS_KEY, "{nope");
    expect(loadPracticeProgress(corrupt)).toEqual(emptyPracticeStore());

    const refused: PracticeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => savePracticeProgress(STORE, refused)).not.toThrow();
  });
});
