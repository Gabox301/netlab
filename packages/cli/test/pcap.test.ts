/**
 * `netlab pcap` end to end: the real `runScenario` and the real writer.
 *
 * The capture contract (F-120): one record per `frame_tx` trace, sorted by
 * simulation time, with the scenario's own clock as the timestamp. The
 * fixtures live under the OS temp dir so the command goes through the same
 * file reads and writes the `netlab` bin uses; the directory is stable and
 * rewritten on every run.
 *
 * `tshark` is not part of these tests: opening the files with a third-party
 * dissector is the CI job's oracle (S2), while `bun test` pins the bytes and
 * the CLI behaviour everywhere.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trace } from "@netlab/core";
import { type PcapFile, parsePcap } from "@netlab/pcap";
import { captureFrames, runPcap } from "../src/pcap";
import { runScenario } from "../src/run";
import { parseScenarioText } from "../src/scenario";

const FIXTURES = join(tmpdir(), "netlab-pcap-fixtures");
const SCENARIO = join(import.meta.dir, "..", "fixtures", "dos-subredes.json");

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
    const code = await runPcap(argv);
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

async function fixture(name: string, text: string): Promise<string> {
  await mkdir(FIXTURES, { recursive: true });
  const file = join(FIXTURES, name);
  await writeFile(file, text, "utf8");
  return file;
}

async function readCapture(file: string): Promise<PcapFile> {
  const result = parsePcap(await readFile(file));
  if (!result.ok) {
    throw new Error(
      `capture did not parse: ${result.error.code} at ${result.error.offset}`,
    );
  }
  return result.value;
}

function frameTrace(
  t: number,
  link: string,
  from: "a" | "b",
  byte: number,
): Extract<Trace, { kind: "frame_tx" }> {
  return {
    t,
    kind: "frame_tx",
    link,
    from,
    length: 1,
    frame: Uint8Array.from([byte]),
  };
}

describe("captureFrames", () => {
  test("keeps frame_tx only and sorts by simulation time", () => {
    const traces: Array<Trace> = [
      frameTrace(20, "l1", "a", 2),
      {
        t: 10,
        kind: "frame_rx",
        link: "l1",
        to: "b",
        length: 1,
        frame: Uint8Array.from([9]),
      },
      frameTrace(10, "l1", "b", 1),
      { t: 10, kind: "state", scope: "sw1", detail: "learn" },
      frameTrace(20, "l2", "b", 3),
    ];
    const frames = captureFrames(traces);
    expect(frames.map((frame) => frame.timeUs)).toEqual([10, 20, 20]);
    expect(frames.map((frame) => frame.bytes[0])).toEqual([1, 2, 3]);
  });

  test("equal timestamps keep emission order", () => {
    const traces: Array<Trace> = [
      frameTrace(5, "l1", "a", 7),
      frameTrace(5, "l2", "a", 8),
      frameTrace(5, "l3", "a", 9),
    ];
    expect(captureFrames(traces).map((frame) => frame.bytes[0])).toEqual([
      7, 8, 9,
    ]);
  });

  test("an empty trace list is an empty capture, not an error", () => {
    expect(captureFrames([])).toEqual([]);
  });
});

describe("netlab pcap", () => {
  test("writes one record per frame_tx trace, ordered by time", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "wire.pcap");
    const captured = await captureRun([
      SCENARIO,
      "-o",
      out,
      "--until",
      "100ms",
    ]);
    expect(captured.code).toBe(0);
    expect(captured.stderr).toBe("");
    expect(captured.stdout).toContain("wrote");

    const file = await readCapture(out);
    const scenarioText = await readFile(SCENARIO, "utf8");
    const run = await runScenario(parseScenarioText(scenarioText, SCENARIO), {
      untilUs: 100_000,
    });
    const expected = captureFrames(run.traces);
    expect(file.frames.length).toBeGreaterThan(0);
    expect(file.frames.length).toBe(expected.length);
    expect(file.frames.map((frame) => frame.timeUs)).toEqual(
      expected.map((frame) => frame.timeUs),
    );
    expect(file.frames.map((frame) => Array.from(frame.bytes))).toEqual(
      expected.map((frame) => Array.from(frame.bytes)),
    );
  });

  test("the capture is deterministic for a seed and horizon", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const first = join(FIXTURES, "determinism-1.pcap");
    const second = join(FIXTURES, "determinism-2.pcap");
    const args = [SCENARIO, "--until", "50ms", "--format", "json"];
    expect((await captureRun([...args, "-o", first])).code).toBe(0);
    expect((await captureRun([...args, "-o", second])).code).toBe(0);
    const a = await readFile(first);
    const b = await readFile(second);
    expect(a.equals(b)).toBe(true);
  });

  test("--until is forwarded to the run", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const short = join(FIXTURES, "until-2ms.pcap");
    const long = join(FIXTURES, "until-50ms.pcap");
    expect(
      (await captureRun([SCENARIO, "-o", short, "--until", "2ms"])).code,
    ).toBe(0);
    expect(
      (await captureRun([SCENARIO, "-o", long, "--until", "50ms"])).code,
    ).toBe(0);
    const shortFile = await readCapture(short);
    const longFile = await readCapture(long);
    expect(shortFile.frames.length).toBeLessThanOrEqual(longFile.frames.length);
    // Deterministic prefix: the shorter horizon cannot reorder the wire.
    expect(shortFile.frames.map((frame) => frame.timeUs)).toEqual(
      longFile.frames
        .map((frame) => frame.timeUs)
        .slice(0, shortFile.frames.length),
    );
  });

  test("--format json prints a single summary line", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "summary.pcap");
    const captured = await captureRun([
      SCENARIO,
      "-o",
      out,
      "--until",
      "50ms",
      "--seed",
      "99",
      "--format",
      "json",
    ]);
    expect(captured.code).toBe(0);
    const summary = JSON.parse(captured.stdout) as {
      scenario: string;
      output: string;
      packets: number;
      bytes: number;
      seed: number;
      untilUs: number;
      finalTime: number;
    };
    expect(summary.scenario).toBe(SCENARIO);
    expect(summary.output).toBe(out);
    expect(summary.packets).toBeGreaterThan(0);
    expect(summary.bytes).toBeGreaterThan(24);
    expect(summary.seed).toBe(99);
    expect(summary.untilUs).toBe(50_000);
    expect(summary.finalTime).toBe(50_000);
    expect((await readFile(out)).length).toBe(summary.bytes);
  });

  test("missing -o is a usage error", async () => {
    const captured = await captureRun([SCENARIO]);
    expect(captured.code).toBe(2);
    expect(captured.stderr).toContain("missing -o");
  });

  test("--help prints the usage and exits 0", async () => {
    const captured = await captureRun(["--help"]);
    expect(captured.code).toBe(0);
    expect(captured.stdout).toContain("netlab pcap");
    expect(captured.stdout).toContain("-o");
  });

  test("an unknown flag is a usage error", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const captured = await captureRun([
      SCENARIO,
      "-o",
      join(FIXTURES, "unused.pcap"),
      "--bogus",
    ]);
    expect(captured.code).toBe(2);
    expect(captured.stderr).toContain("unknown flag");
  });

  test("a bad --until is a usage error", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const captured = await captureRun([
      SCENARIO,
      "-o",
      join(FIXTURES, "unused.pcap"),
      "--until",
      "soon",
    ]);
    expect(captured.code).toBe(2);
  });

  test("an unreadable scenario exits 1", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const captured = await captureRun([
      join(FIXTURES, "does-not-exist.json"),
      "-o",
      join(FIXTURES, "unused.pcap"),
    ]);
    expect(captured.code).toBe(1);
    expect(captured.stderr).toContain("cannot read");
  });

  test("a scenario that does not parse exits 2", async () => {
    const bad = await fixture("bad-scenario.json", "{ not json");
    const captured = await captureRun([
      bad,
      "-o",
      join(FIXTURES, "unused.pcap"),
    ]);
    expect(captured.code).toBe(2);
  });

  test("a scenario that parses but cannot run exits 1", async () => {
    const broken = await fixture(
      "broken-run.json",
      JSON.stringify({
        version: 1,
        nodes: [{ type: "switch", id: "sw1", ports: [{ name: "p1" }] }],
        links: [],
        actions: [{ at: 0, cut: "nope" }],
      }),
    );
    const captured = await captureRun([
      broken,
      "-o",
      join(FIXTURES, "unused.pcap"),
    ]);
    expect(captured.code).toBe(1);
    expect(captured.stderr).toContain("unknown link");
  });

  test("an unwritable output exits 1", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const captured = await captureRun([SCENARIO, "-o", FIXTURES]);
    expect(captured.code).toBe(1);
    expect(captured.stderr).toContain("cannot write");
  });
});
