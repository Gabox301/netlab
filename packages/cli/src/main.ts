#!/usr/bin/env bun
/**
 * `netlab` entrypoint: `run` executes a scenario, `validate` judges a
 * solution against an exercise and `pcap` exports a scenario's wire traffic.
 *
 * Usage: netlab run <scenario.json> [--seed N] [--until 10s] [--format human|json]
 *        netlab validate <exercise.json> <solution.json> [--format human|json]
 *        netlab pcap <scenario.json> -o <out.pcap> [--until 10s] [--format human|json]
 * Exit codes: 0 ok · 1 scenario/runtime error or failed check · 2 usage or
 * parse error.
 */

import { readFile } from "node:fs/promises";
import { formatHuman, formatJsonLines, formatSummaryJson } from "./format";
import { PCAP_USAGE, runPcap } from "./pcap";
import { runScenario } from "./run";
import { parseDurationToUs, parseScenarioText } from "./scenario";
import { runValidate, VALIDATE_USAGE } from "./validate";

const COMMANDS =
  "Usage: netlab <command> [options]\n" +
  "  run       run a v1 scenario and print its traces\n" +
  "  validate  check a solution scenario against an exercise\n" +
  "  pcap      export a scenario's wire traffic as a classic PCAP file\n";

const USAGE =
  COMMANDS +
  "\n" +
  "Usage: netlab run <scenario.json> [--seed N] [--until 10s] [--format human|json]\n" +
  "  run a v1 scenario and print traces (human by default, JSON lines with --format json)\n" +
  "  --seed N overrides the scenario seed; --until overrides its horizon (e.g. 10s, 100ms)\n" +
  "\n" +
  VALIDATE_USAGE +
  "\n" +
  PCAP_USAGE;

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
      `unknown command ${JSON.stringify(argv[0])} (expected "run", "validate" or "pcap")`,
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
  if (argv[0] === "validate") {
    return runValidate(argv.slice(1));
  }
  if (argv[0] === "pcap") {
    return runPcap(argv.slice(1));
  }
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
    const result = await runScenario(scenario, {
      ...(args.seed === undefined ? {} : { seed: args.seed }),
      ...(args.untilUs === undefined ? {} : { untilUs: args.untilUs }),
    });
    if (args.format === "json") {
      process.stdout.write(formatJsonLines(result.traces));
      process.stderr.write(`${formatSummaryJson(result)}\n`);
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
