#!/usr/bin/env bun
/**
 * `netlab run` entrypoint: load a scenario JSON, run it, print traces.
 *
 * Usage: netlab run <scenario.json> [--seed N] [--until 10s] [--format human|json]
 * Exit codes: 0 ok · 1 scenario/runtime error · 2 usage error.
 */

import { readFile } from "node:fs/promises";
import { formatHuman, formatJsonLines, formatMacTablesJson } from "./format";
import { runScenario } from "./run";
import { parseDurationToUs, parseScenarioText } from "./scenario";

const USAGE =
  "Usage: netlab run <scenario.json> [--seed N] [--until 10s] [--format human|json]\n" +
  "  run a v1 scenario and print traces (human by default, JSON lines with --format json)\n" +
  "  --seed N overrides the scenario seed; --until overrides its horizon (e.g. 10s, 100ms)\n";

interface CliArgs {
  file: string;
  seed: number | undefined;
  untilUs: number | undefined;
  format: "human" | "json";
}

function usageError(message: string): Error {
  return new Error(`${message}\n${USAGE}`);
}

function parseArgs(argv: Array<string>): CliArgs {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    throw Object.assign(usageError("netlab run needs a scenario file."), {
      code: "HELP",
    });
  }
  if (argv[0] !== "run") {
    throw usageError(
      `unknown command ${JSON.stringify(argv[0])} (only "run" exists yet)`,
    );
  }
  const rest = argv.slice(1);
  let file: string | undefined;
  let seed: number | undefined;
  let untilUs: number | undefined;
  let format: "human" | "json" = "human";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--seed") {
      const raw = rest[++i];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw usageError(
          `--seed needs a non-negative integer, got ${JSON.stringify(raw)}`,
        );
      }
      seed = Number.parseInt(raw, 10);
    } else if (arg === "--until") {
      const raw = rest[++i];
      if (raw === undefined) {
        throw usageError("--until needs a duration (e.g. 10s)");
      }
      untilUs = parseDurationToUs(raw, 0, "--until");
    } else if (arg === "--format") {
      const raw = rest[++i];
      if (raw !== "human" && raw !== "json") {
        throw usageError(
          `--format must be "human" or "json", got ${JSON.stringify(raw)}`,
        );
      }
      format = raw;
    } else if (arg.startsWith("-")) {
      throw usageError(`unknown flag ${JSON.stringify(arg)}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw usageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  if (file === undefined) {
    throw usageError("missing <scenario.json>");
  }
  return { file, seed, untilUs, format };
}

async function main(argv: Array<string>): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "HELP") {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`${err.message}`);
    return 2;
  }
  let text: string;
  try {
    text = await readFile(args.file, "utf8");
  } catch (error) {
    process.stderr.write(
      `cannot read ${args.file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  try {
    const scenario = parseScenarioText(text, args.file);
    const result = runScenario(scenario, {
      ...(args.seed === undefined ? {} : { seed: args.seed }),
      ...(args.untilUs === undefined ? {} : { untilUs: args.untilUs }),
    });
    if (args.format === "json") {
      process.stdout.write(formatJsonLines(result.traces));
      process.stderr.write(`${formatMacTablesJson(result.macTables)}\n`);
    } else {
      process.stdout.write(formatHuman(result));
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

// When executed as the `netlab` bin (not when imported by tests).
if (import.meta.path === Bun.main) {
  const code = await main(Bun.argv.slice(2));
  process.exit(code);
}

export { main };
