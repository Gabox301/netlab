/**
 * Practice scoring and progress (F-113, F-114).
 *
 * The score is a pure function of the authored hints: every revealed hint
 * subtracts its penalty from 100 and the result never goes below 0. Progress
 * lives in one versioned localStorage document
 * (`netlab.practice.progress.v1`), with an entry per exercise: attempts, best
 * score, the most hints used, accumulated time and the timestamp of the first
 * pass.
 *
 * Same storage contract as the editor autosave: reads and writes never throw
 * (private mode, disabled storage and the static prerender all read as "no
 * progress"), and the parser is strict about every field it knows so a
 * half-written document cannot smuggle `NaN` into the panel. Unknown exercise
 * ids are preserved: progress survives a catalog that drops an exercise.
 */

import type { ExerciseHint } from "@netlab/exercises";

/**
 * The practice catalog, re-exported from `@netlab/exercises` so the page has
 * one web-side entry point for routes, exercises, scoring and progress.
 */
export {
  PRACTICE_EXERCISES,
  PRACTICE_ROUTES,
  type PracticeLocation,
  type PracticeRoute,
  type PracticeRouteLevel,
  practiceExercise,
  practiceLocation,
  practiceRoute,
} from "@netlab/exercises";

/** Storage key of the versioned progress document. */
export const PRACTICE_PROGRESS_KEY = "netlab.practice.progress.v1";

/** Version of the JSON document behind {@link PRACTICE_PROGRESS_KEY}. */
export const PRACTICE_PROGRESS_VERSION = 1;

/** Per-exercise progress (F-114). */
export interface PracticeProgress {
  /** Validations run, pass or fail. */
  attempts: number;
  /** Best score across attempts; `null` until the first validation. */
  bestScore: number | null;
  /** Most hints revealed in any attempt (F-113). */
  hintsRevealed: number;
  /** Accumulated validation time, in milliseconds. */
  elapsedMs: number;
  /** ISO timestamp of the first pass; `null` while unsolved. */
  passedAt: string | null;
}

/** The whole document: one progress entry per exercise id. */
export interface PracticeProgressStore {
  version: typeof PRACTICE_PROGRESS_VERSION;
  exercises: Record<string, PracticeProgress>;
}

/** One validation result, as the recorder stores it. */
export interface PracticeAttempt {
  pass: boolean;
  score: number;
  hintsRevealed: number;
  elapsedMs: number;
  /** Clock for the pass timestamp; tests inject it, the page omits it. */
  at?: Date;
}

/** The slice of `Storage` this module uses (a fake fits in tests). */
export interface PracticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Score after revealing the first `revealed` hints, never below 0. */
export function scoreOf(
  hints: ReadonlyArray<ExerciseHint>,
  revealed: number,
): number {
  const count = Number.isFinite(revealed)
    ? Math.min(Math.max(Math.floor(revealed), 0), hints.length)
    : 0;
  let penalty = 0;
  for (let index = 0; index < count; index += 1) {
    penalty += hints[index]?.penalty ?? 0;
  }
  return Math.max(0, 100 - penalty);
}

/** A brand-new exercise with no attempts. */
export function emptyProgress(): PracticeProgress {
  return {
    attempts: 0,
    bestScore: null,
    hintsRevealed: 0,
    elapsedMs: 0,
    passedAt: null,
  };
}

/** A brand-new document. */
export function emptyPracticeStore(): PracticeProgressStore {
  return { version: PRACTICE_PROGRESS_VERSION, exercises: {} };
}

/** One exercise's progress; a missing entry reads as {@link emptyProgress}. */
export function progressOf(
  store: PracticeProgressStore,
  exerciseId: string,
): PracticeProgress {
  return store.exercises[exerciseId] ?? emptyProgress();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round to a whole number; a non-finite input falls back to 0. */
function whole(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Fold one validation into the store, purely.
 *
 * The maximums only grow (`bestScore`, `hintsRevealed`), time accumulates,
 * and `passedAt` keeps the timestamp of the *first* pass. Out-of-range input
 * is clamped instead of rejected: this runs from a UI event, not a parser.
 */
export function recordAttempt(
  store: PracticeProgressStore,
  exerciseId: string,
  attempt: PracticeAttempt,
): PracticeProgressStore {
  const previous = progressOf(store, exerciseId);
  const score = clamp(whole(attempt.score), 0, 100);
  const revealed = Math.max(0, whole(attempt.hintsRevealed));
  const elapsed = Math.max(0, whole(attempt.elapsedMs));
  const at = attempt.at ?? new Date();
  const next: PracticeProgress = {
    attempts: previous.attempts + 1,
    bestScore: Math.max(previous.bestScore ?? 0, score),
    hintsRevealed: Math.max(previous.hintsRevealed, revealed),
    elapsedMs: previous.elapsedMs + elapsed,
    passedAt: previous.passedAt ?? (attempt.pass ? at.toISOString() : null),
  };
  return {
    version: store.version,
    exercises: { ...store.exercises, [exerciseId]: next },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-negative integer, the shape of every counter in the document. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseProgress(value: unknown): PracticeProgress | null {
  if (!isRecord(value)) {
    return null;
  }
  const attempts = value.attempts;
  const hintsRevealed = value.hintsRevealed;
  const elapsedMs = value.elapsedMs;
  if (!isCount(attempts) || !isCount(hintsRevealed) || !isCount(elapsedMs)) {
    return null;
  }
  const bestScore = value.bestScore;
  if (bestScore !== null && !(isCount(bestScore) && bestScore <= 100)) {
    return null;
  }
  const passedAt = value.passedAt;
  if (
    passedAt !== null &&
    !(typeof passedAt === "string" && Number.isFinite(Date.parse(passedAt)))
  ) {
    return null;
  }
  return { attempts, bestScore, hintsRevealed, elapsedMs, passedAt };
}

/**
 * Strict parse of one progress document: every known field must have the
 * right shape, or the whole draft is discarded. Never throws.
 */
export function parsePracticeProgress(
  text: string,
): PracticeProgressStore | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== PRACTICE_PROGRESS_VERSION) {
    return null;
  }
  const source = raw.exercises;
  if (!isRecord(source)) {
    return null;
  }
  const exercises: Record<string, PracticeProgress> = {};
  for (const [id, value] of Object.entries(source)) {
    if (id.length === 0) {
      return null;
    }
    const parsed = parseProgress(value);
    if (parsed === null) {
      return null;
    }
    exercises[id] = parsed;
  }
  return { version: PRACTICE_PROGRESS_VERSION, exercises };
}

/** Serialize the document exactly as {@link parsePracticeProgress} reads it. */
export function serializePracticeProgress(
  store: PracticeProgressStore,
): string {
  return JSON.stringify(store);
}

/** Browser storage when it exists; `null` in workers, tests and prerender. */
function defaultStorage(): PracticeStorage | null {
  const candidate = (
    globalThis as { localStorage?: PracticeStorage | undefined }
  ).localStorage;
  return candidate ?? null;
}

/** Read the draft; a missing, refused or corrupt one reads as empty. */
export function loadPracticeProgress(
  storage: PracticeStorage | null = defaultStorage(),
): PracticeProgressStore {
  if (storage === null) {
    return emptyPracticeStore();
  }
  let text: string | null;
  try {
    text = storage.getItem(PRACTICE_PROGRESS_KEY);
  } catch {
    return emptyPracticeStore();
  }
  if (text === null) {
    return emptyPracticeStore();
  }
  return parsePracticeProgress(text) ?? emptyPracticeStore();
}

/** Persist the draft; a refused write (quota, private mode) is dropped. */
export function savePracticeProgress(
  store: PracticeProgressStore,
  storage: PracticeStorage | null = defaultStorage(),
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(PRACTICE_PROGRESS_KEY, serializePracticeProgress(store));
  } catch {
    // Quota exceeded or private mode: drop the write and keep practicing.
  }
}
