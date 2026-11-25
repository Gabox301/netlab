/**
 * `netlab pcap` entrypoint: run a scenario and write its wire traffic as a
 * classic libpcap capture (F-120).
 *
 * Capture decision: one record per `frame_tx` trace, ordered by simulation
 * time. `frame_tx` is the frame an endpoint hands to its link — what would
 * be seen leaving that NIC — while `frame_rx` is the same transmission seen
 * from the other end and `frame_drop` never reached the wire at all. The
 * exporter therefore records each transmission exactly once, in wire order;
 * per-interface capture and the rx/drop views (F-122) build on the same
 * `captureFrames` shape. The sort is stable, so frames that share a
 * timestamp keep their emission order.
 *
 * Timestamps are the scenario's virtual microseconds, not a wall clock: the
 * capture is reproducible from the seed and the horizon.
 *
 * Usage: netlab pcap <scenario.json> -o <out.pcap> [--seed N] [--until 10s]
 *                                     [--format human|json]
 * Exit codes: 0 written · 1 scenario, run or write failure · 2 usage or
 * parse error.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { Trace } from "@netlab/core";
import { type PcapFrameInput, writePcap } from "@netlab/pcap";
import { type RunResult, runScenario } from "./run";
import {
  parseDurationToUs,
  parseScenarioText,
  type Scenario,
} from "./scenario";

export const PCAP_USAGE =
  "Usage: netlab pcap <scenario.json> -o <out.pcap> [--seed N] [--until 10s] [--format human|json]\n" +
  "  run a scenario and write its frame_tx traffic as a classic libpcap capture\n" +
  "  --until overrides the scenario horizon (e.g. 10s, 100ms); --format json prints a summary line\n" +
  "  exit 0 when the capture is written, 1 on a run or write failure, 2 on usage or parse errors\n";

interface PcapArgs {
  file: string;
  output: string;
  seed: number | undefined;
  untilUs: number | undefined;
  format: "human" | "json";
}

/** What `--format json` promises and the human line summarises. */
export interface PcapSummary {
  /** The scenario that was run. */
  scenario: string;
  /** The capture file that was written. */
  output: string;
  /** Records in the capture (one per `frame_tx` trace). */
  packets: number;
  /** Size of the capture file in bytes, global header included. */
  bytes: number;
  seed: number;
  untilUs: number;
  /** Simulation time the run reached. */
  finalTime: number;
}

function usageError(message: string): Error {
  return new Error(`${message}\n${PCAP_USAGE}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse `netlab pcap` arguments (without the command word). */
export function parsePcapArgs(argv: Array<string>): PcapArgs {
  if (argv[0] === "-h" || argv[0] === "--help") {
    throw Object.assign(
      usageError("netlab pcap needs a scenario file and an output file."),
      { code: "HELP" },
    );
  }
  let file: string | undefined;
  let output: string | undefined;
  let seed: number | undefined;
  let untilUs: number | undefined;
  let format: "human" | "json" = "human";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-o") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw usageError("-o needs an output file");
      }
      output = raw;
    } else if (arg === "--seed") {
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw usageError(
          `--seed needs a non-negative integer, got ${JSON.stringify(raw)}`,
        );
      }
      seed = Number.parseInt(raw, 10);
    } else if (arg === "--until") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw usageError("--until needs a duration (e.g. 10s)");
      }
      untilUs = parseDurationToUs(raw, 0, "--until");
    } else if (arg === "--format") {
      const raw = argv[++i];
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
  if (output === undefined) {
    throw usageError("missing -o <out.pcap>");
  }
  return { file, output, seed, untilUs, format };
}

/**
 * The frames a capture keeps: `frame_tx` traces, stable-sorted by time.
 *
 * Frames travel by reference in the trace bus, so the returned `bytes` are
 * views over the traces. The runner never reuses a frame buffer after
 * `send()`, and `writePcap` copies what it stores.
 */
export function captureFrames(
  traces: ReadonlyArray<Trace>,
): Array<PcapFrameInput> {
  const frames: Array<PcapFrameInput> = [];
  for (const trace of traces) {
    if (trace.kind === "frame_tx") {
      frames.push({ timeUs: trace.t, bytes: trace.frame });
    }
  }
  frames.sort((a, b) => a.timeUs - b.timeUs);
  return frames;
}

/** One line: where the capture went and what it contains. */
export function formatPcapHuman(summary: PcapSummary): string {
  return (
    `wrote ${summary.output}: ${summary.packets} packets, ` +
    `${summary.bytes} bytes (seed=${summary.seed}, until=${summary.untilUs}us, ` +
    `final t=${summary.finalTime}us)\n`
  );
}

/** The summary as a single JSON line (same shape `--format json` promises). */
export function formatPcapJson(summary: PcapSummary): string {
  return `${JSON.stringify(summary)}\n`;
}

/** Run the subcommand and return the process exit code. */
export async function runPcap(argv: Array<string>): Promise<number> {
  let args: PcapArgs;
  try {
    args = parsePcapArgs(argv);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "HELP") {
      process.stdout.write(PCAP_USAGE);
      return 0;
    }
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  let text: string;
  try {
    text = await readFile(args.file, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read ${args.file}: ${errorMessage(error)}\n`);
    return 1;
  }

  let scenario: Scenario;
  try {
    scenario = parseScenarioText(text, args.file);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }

  let result: RunResult;
  try {
    result = await runScenario(scenario, {
      ...(args.seed === undefined ? {} : { seed: args.seed }),
      ...(args.untilUs === undefined ? {} : { untilUs: args.untilUs }),
    });
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }

  const frames = captureFrames(result.traces);
  let capture: Uint8Array;
  try {
    capture = writePcap(frames);
  } catch (error) {
    // A trace with an unrepresentable timestamp is a runtime failure, not a
    // usage error: the scenario itself was accepted.
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }

  try {
    await writeFile(args.output, capture);
  } catch (error) {
    process.stderr.write(
      `cannot write ${args.output}: ${errorMessage(error)}\n`,
    );
    return 1;
  }

  const summary: PcapSummary = {
    scenario: args.file,
    output: args.output,
    packets: frames.length,
    bytes: capture.length,
    seed: result.seed,
    untilUs: result.untilUs,
    finalTime: result.finalTime,
  };
  process.stdout.write(
    args.format === "json" ? formatPcapJson(summary) : formatPcapHuman(summary),
  );
  return 0;
}
