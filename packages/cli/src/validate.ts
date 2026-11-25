/**
 * `netlab validate` entrypoint: judge a solution against an exercise.
 *
 * The exercise is parsed by `@netlab/exercises`, the solution by the CLI's own
 * scenario schema, and the probes the checks need are appended to a copy of the
 * solution before the single run. The runner is the same `runScenario` that
 * `netlab run` uses, so validation and replay cannot drift apart.
 *
 * Usage: netlab validate <exercise.json> <solution.json> [--format human|json]
 * Exit codes: 0 all checks pass · 1 a check or the run failed · 2 usage or
 * parse error.
 */

import { readFile } from "node:fs/promises";
import {
  type ExerciseJSON,
  type ExerciseValidationResult,
  parseExerciseText,
  prepareScenario,
  type ScenarioLike,
  validateExercise,
} from "@netlab/exercises";
import { runScenario } from "./run";
import { parseScenarioText, type Scenario } from "./scenario";

export const VALIDATE_USAGE =
  "Usage: netlab validate <exercise.json> <solution.json> [--format human|json]\n" +
  "  run the exercise checks against a solution scenario\n" +
  "  exit 0 when every check passes, 1 when one fails, 2 on usage or parse errors\n";

interface ValidateArgs {
  exerciseFile: string;
  solutionFile: string;
  format: "human" | "json";
}

function usageError(message: string): Error {
  return new Error(`${message}\n${VALIDATE_USAGE}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse `netlab validate` arguments (without the command word). */
export function parseValidateArgs(argv: Array<string>): ValidateArgs {
  if (argv[0] === "-h" || argv[0] === "--help") {
    throw Object.assign(
      usageError("netlab validate needs an exercise file and a solution file."),
      { code: "HELP" },
    );
  }
  let exerciseFile: string | undefined;
  let solutionFile: string | undefined;
  let format: "human" | "json" = "human";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--format") {
      const raw = argv[++i];
      if (raw !== "human" && raw !== "json") {
        throw usageError(
          `--format must be "human" or "json", got ${JSON.stringify(raw)}`,
        );
      }
      format = raw;
    } else if (arg.startsWith("-")) {
      throw usageError(`unknown flag ${JSON.stringify(arg)}`);
    } else if (exerciseFile === undefined) {
      exerciseFile = arg;
    } else if (solutionFile === undefined) {
      solutionFile = arg;
    } else {
      throw usageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  if (exerciseFile === undefined) {
    throw usageError("missing <exercise.json>");
  }
  if (solutionFile === undefined) {
    throw usageError("missing <solution.json>");
  }
  return { exerciseFile, solutionFile, format };
}

/** One verdict block per check, plus the run summary on the header line. */
export function formatValidationHuman(
  result: ExerciseValidationResult,
  exerciseId: string,
): string {
  const passed = result.checks.filter((check) => check.pass).length;
  const verdict = result.pass ? "PASS" : "FAIL";
  const lines = [
    `${verdict} exercise ${exerciseId}: ${passed}/${result.checks.length} checks passed ` +
      `(seed=${result.run.seed}, final t=${result.run.finalTime}us, processed=${result.run.processed})`,
  ];
  for (const check of result.checks) {
    lines.push(
      `  ${check.pass ? "PASS" : "FAIL"}  ${check.name} - ${check.detail}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The verdict as a single JSON line (same shape `--format json` promises). */
export function formatValidationJson(result: ExerciseValidationResult): string {
  return `${JSON.stringify(result)}\n`;
}

async function readText(file: string): Promise<string> {
  return await readFile(file, "utf8");
}

/** Run the subcommand and return the process exit code. */
export async function runValidate(argv: Array<string>): Promise<number> {
  let args: ValidateArgs;
  try {
    args = parseValidateArgs(argv);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "HELP") {
      process.stdout.write(VALIDATE_USAGE);
      return 0;
    }
    process.stderr.write(`${err.message}`);
    return 2;
  }

  let exerciseText: string;
  let solutionText: string;
  try {
    exerciseText = await readText(args.exerciseFile);
    solutionText = await readText(args.solutionFile);
  } catch (error) {
    process.stderr.write(
      `cannot read the exercise or the solution: ${errorMessage(error)}\n`,
    );
    return 1;
  }

  let exercise: ExerciseJSON;
  let solution: Scenario;
  let scenario: ScenarioLike;
  try {
    exercise = parseExerciseText(exerciseText, args.exerciseFile);
    solution = parseScenarioText(solutionText, args.solutionFile);
    scenario = prepareScenario(exercise, solution);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }

  let result: ExerciseValidationResult;
  try {
    result = await validateExercise(
      exercise,
      scenario,
      // The structural view exists only to keep this package below the CLI;
      // the CLI owns the concrete `Scenario` it parsed above.
      (prepared) => runScenario(prepared as Scenario),
    );
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }

  process.stdout.write(
    args.format === "json"
      ? formatValidationJson(result)
      : formatValidationHuman(result, exercise.id),
  );
  return result.pass ? 0 : 1;
}
