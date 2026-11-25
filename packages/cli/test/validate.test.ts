/**
 * `netlab validate` end to end: the real `runScenario` behind the CLI.
 *
 * `@netlab/exercises` cannot import the CLI (ADR-001: the CLI consumes
 * exercises), so the integration test that wires both sides lives with the
 * consumer, where `@netlab/exercises` and `../src/run` both resolve by name.
 *
 * The exit-code cases write their fixtures under the OS temp dir, so they go
 * through the same file reads the `netlab` bin uses. The directory is stable
 * and rewritten on every run: no cleanup step deletes anything.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExerciseExample,
  type ExerciseJSON,
  type ExerciseValidationResult,
  exerciseExamples,
  prepareScenario,
  type RunEvidence,
  type ScenarioLike,
  validateExercise,
} from "@netlab/exercises";
import { runScenario } from "../src/run";
import { parseScenarioJson, type Scenario } from "../src/scenario";
import { runValidate } from "../src/validate";

const FIXTURES = join(tmpdir(), "netlab-validate-fixtures");

function exampleAt(index: number): ExerciseExample {
  const example = exerciseExamples[index];
  if (example === undefined) {
    throw new Error(`no example at index ${index}`);
  }
  return example;
}

/** The exact runner the `run` subcommand uses, behind the structural view. */
function realRunner(scenario: ScenarioLike): Promise<RunEvidence> {
  return runScenario(scenario as Scenario);
}

async function validateReal(
  example: ExerciseExample,
  which: "solution" | "trap",
): Promise<ExerciseValidationResult> {
  const source = which === "solution" ? example.solution : example.trap;
  return await validateExercise(
    example.exercise,
    prepareScenario(example.exercise, parseScenarioJson(source)),
    realRunner,
  );
}

async function fixture(name: string, value: unknown): Promise<string> {
  await mkdir(FIXTURES, { recursive: true });
  const file = join(FIXTURES, name);
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
  return file;
}

function exerciseFixture(example: ExerciseExample): Promise<string> {
  return fixture(`${example.exercise.id}.exercise.json`, example.exercise);
}

function scenarioFixture(
  example: ExerciseExample,
  which: "solution" | "trap",
): Promise<string> {
  const source = which === "solution" ? example.solution : example.trap;
  return fixture(`${example.exercise.id}.${which}.json`, source);
}

type StdoutWrite = typeof process.stdout.write;

function collector(sink: Array<string>): StdoutWrite {
  return ((chunk: string | Uint8Array) => {
    sink.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as unknown as StdoutWrite;
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the subcommand in-process with its output captured. */
async function captureRun(argv: Array<string>): Promise<Captured> {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = collector(stdout);
  process.stderr.write = collector(stderr);
  try {
    const code = await runValidate(argv);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("real runScenario", () => {
  for (const example of exerciseExamples) {
    test(`${example.exercise.id}: the reference solution passes`, async () => {
      const result = await validateReal(example, "solution");
      expect(result.checks.filter((check) => !check.pass)).toEqual([]);
      expect(result.pass).toBe(true);
      expect(result.run.seed).toBe(example.exercise.seed);
      expect(result.run.finalTime).toBeGreaterThan(0);
      expect(result.run.processed).toBeGreaterThan(0);
    });

    test(`${example.exercise.id}: the trap solution fails`, async () => {
      const result = await validateReal(example, "trap");
      expect(result.checks.some((check) => !check.pass)).toBe(true);
      expect(result.pass).toBe(false);
    });
  }

  test("each trap fails for the reason it was built for", async () => {
    const mac = await validateReal(exampleAt(0), "trap");
    expect(mac.checks[0]?.detail).toMatch(/learned on p2/);

    const gateway = await validateReal(exampleAt(1), "trap");
    expect(gateway.checks[0]?.detail).toMatch(/no gateway configured/);

    const routing = await validateReal(exampleAt(2), "trap");
    const drops = routing.checks.find(
      (check) => check.name === "no frames dropped",
    );
    const route = routing.checks.find((check) =>
      check.name.startsWith("r1 routes"),
    );
    expect(drops?.pass).toBe(false);
    expect(drops?.detail).toMatch(/matching trace/);
    expect(route?.pass).toBe(true);
  });

  test("the same exercise and solution replay the same verdict", async () => {
    const once = await validateReal(exampleAt(1), "solution");
    const twice = await validateReal(exampleAt(1), "solution");
    expect(twice).toEqual(once);
  });
});

describe("cli exit codes", () => {
  test("a passing solution exits 0 and reports PASS", async () => {
    const example = exampleAt(1);
    const exercise = await exerciseFixture(example);
    const solution = await scenarioFixture(example, "solution");

    const run = await captureRun([exercise, solution]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("PASS exercise ip-gateway-ping");
    expect(run.stdout).toContain("h1 reaches h2 across r1");
    expect(run.stderr).toBe("");
  });

  test("a trap solution exits 1 and reports the failing check", async () => {
    const example = exampleAt(1);
    const exercise = await exerciseFixture(example);
    const trap = await scenarioFixture(example, "trap");

    const run = await captureRun([exercise, trap]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("FAIL exercise ip-gateway-ping");
    expect(run.stdout).toContain("FAIL  h1 reaches h2 across r1");
    expect(run.stdout).toMatch(/no gateway configured/);
  });

  test("--format json prints the verdict as one JSON line", async () => {
    const example = exampleAt(1);
    const exercise = await exerciseFixture(example);
    const solution = await scenarioFixture(example, "solution");

    const run = await captureRun([exercise, solution, "--format", "json"]);
    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as ExerciseValidationResult;
    expect(parsed.pass).toBe(true);
    expect(parsed.run.seed).toBe(example.exercise.seed);
    expect(parsed.checks[0]?.name).toBe("h1 reaches h2 across r1");
    expect(parsed.checks[0]?.pass).toBe(true);
  });

  test("a malformed exercise exits 2 and prints nothing on stdout", async () => {
    const example = exampleAt(1);
    const solution = await scenarioFixture(example, "solution");
    const broken: Partial<ExerciseJSON> = { version: 1, id: "broken" };
    const exercise = await fixture("broken.exercise.json", broken);

    const run = await captureRun([exercise, solution]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^exercise: /);
  });

  test("a malformed solution exits 2", async () => {
    const example = exampleAt(1);
    const exercise = await exerciseFixture(example);
    const broken = await fixture("broken.solution.json", { version: 1 });

    const run = await captureRun([exercise, broken]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/^scenario/);
  });

  test("an unknown flag exits 2", async () => {
    const run = await captureRun(["--nope"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown flag "--nope"');
  });

  test("an unreadable file exits 1", async () => {
    const example = exampleAt(0);
    const exercise = await exerciseFixture(example);

    const run = await captureRun([exercise, join(FIXTURES, "nope.json")]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/cannot read/);
  });
});
