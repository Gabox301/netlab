/**
 * `netlab pcap` and `netlab pcap-import` end to end: the real `runScenario`,
 * the real writers and the real parsers.
 *
 * The capture contract (F-120 to F-123): one record per `frame_tx` trace,
 * sorted by simulation time, with the scenario's own clock as the timestamp;
 * pcapng adds one interface per link (`--link` filters them) and the import
 * command turns either format back into one JSON line per packet. The
 * fixtures live under the OS temp dir so the commands go through the same
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
import {
  type PcapFile,
  type PcapngFile,
  parsePcap,
  parsePcapng,
  writePcap,
} from "@netlab/pcap";
import { main } from "../src/main";
import {
  captureFrames,
  type ImportedPacket,
  runPcap,
  runPcapImport,
} from "../src/pcap";
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

/** Run a subcommand in-process with its output captured. */
async function withCapturedOutput(
  run: () => Promise<number>,
): Promise<Captured> {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = collector(stdout);
  process.stderr.write = collector(stderr);
  try {
    const code = await run();
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

/** Run `netlab pcap` in-process with its output captured. */
function captureRun(argv: Array<string>): Promise<Captured> {
  return withCapturedOutput(() => runPcap(argv));
}

/** Run `netlab pcap-import` in-process with its output captured. */
function captureImport(argv: Array<string>): Promise<Captured> {
  return withCapturedOutput(() => runPcapImport(argv));
}

/** Run the `netlab` entrypoint in-process with its output captured. */
function captureMain(argv: Array<string>): Promise<Captured> {
  return withCapturedOutput(() => main(argv));
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

async function readPcapng(file: string): Promise<PcapngFile> {
  const result = parsePcapng(await readFile(file));
  if (!result.ok) {
    throw new Error(
      `capture did not parse: ${result.error.code} at ${result.error.offset}`,
    );
  }
  return result.value;
}

/** The JSON lines `netlab pcap-import --format json` printed. */
function jsonLines(stdout: string): Array<ImportedPacket> {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ImportedPacket);
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

/** Interface names the CLI derives from `fixtures/dos-subredes.json`. */
const L1_NAME = "h1:eth0-r1:p0";
const L2_NAME = "h2:eth0-r1:p1";

describe("netlab pcap --format pcapng", () => {
  test("writes one interface per link and one EPB per frame_tx trace", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "wire.pcapng");
    const captured = await captureRun([
      SCENARIO,
      "-o",
      out,
      "--until",
      "100ms",
      "--format",
      "pcapng",
    ]);
    expect(captured.code).toBe(0);
    expect(captured.stderr).toBe("");
    expect(captured.stdout).toContain("wrote");

    const magic = await readFile(out);
    expect(Array.from(magic.slice(0, 4))).toEqual([0x0a, 0x0d, 0x0d, 0x0a]);
    const file = await readPcapng(out);
    expect(file.interfaces.map((iface) => iface.name)).toEqual([
      L1_NAME,
      L2_NAME,
    ]);
    expect(file.interfaces.map((iface) => iface.linkType)).toEqual([1, 1]);

    // Same traffic as the classic capture: pcapng only adds the interface.
    const classic = join(FIXTURES, "wire-classic.pcap");
    expect(
      (await captureRun([SCENARIO, "-o", classic, "--until", "100ms"])).code,
    ).toBe(0);
    const reference = await readCapture(classic);
    expect(file.packets.length).toBe(reference.frames.length);
    expect(file.packets.map((packet) => packet.timeUs)).toEqual(
      reference.frames.map((frame) => frame.timeUs),
    );
    expect(file.packets.map((packet) => Array.from(packet.bytes))).toEqual(
      reference.frames.map((frame) => Array.from(frame.bytes)),
    );
  });

  test("--link keeps only that link's frames under a single interface", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const full = join(FIXTURES, "filter-full.pcapng");
    const only = join(FIXTURES, "filter-l1.pcapng");
    expect(
      (
        await captureRun([
          SCENARIO,
          "-o",
          full,
          "--until",
          "100ms",
          "--format",
          "pcapng",
        ])
      ).code,
    ).toBe(0);
    const captured = await captureRun([
      SCENARIO,
      "-o",
      only,
      "--until",
      "100ms",
      "--format",
      "pcapng",
      "--link",
      "l1",
    ]);
    expect(captured.code).toBe(0);

    const fullFile = await readPcapng(full);
    const file = await readPcapng(only);
    expect(file.interfaces.map((iface) => iface.name)).toEqual([L1_NAME]);
    expect(file.packets.every((packet) => packet.interfaceId === 0)).toBe(true);

    const names = new Map(
      fullFile.interfaces.map((iface) => [iface.id, iface.name]),
    );
    const l1Packets = fullFile.packets.filter(
      (packet) => names.get(packet.interfaceId) === L1_NAME,
    );
    expect(file.packets.length).toBeGreaterThan(0);
    expect(file.packets.length).toBe(l1Packets.length);
    expect(file.packets.length).toBeLessThan(fullFile.packets.length);
    expect(file.packets.map((packet) => packet.timeUs)).toEqual(
      l1Packets.map((packet) => packet.timeUs),
    );
    expect(file.packets.map((packet) => Array.from(packet.bytes))).toEqual(
      l1Packets.map((packet) => Array.from(packet.bytes)),
    );
  });

  test("--link is repeatable and keeps the scenario's link order", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "filter-both.pcapng");
    const captured = await captureRun([
      SCENARIO,
      "-o",
      out,
      "--until",
      "100ms",
      "--format",
      "pcapng",
      "--link",
      "l2",
      "--link",
      "l1",
    ]);
    expect(captured.code).toBe(0);
    const file = await readPcapng(out);
    expect(file.interfaces.map((iface) => iface.name)).toEqual([
      L1_NAME,
      L2_NAME,
    ]);
    expect(new Set(file.packets.map((packet) => packet.interfaceId))).toEqual(
      new Set([0, 1]),
    );
  });

  test("an unknown --link is a usage error", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const captured = await captureRun([
      SCENARIO,
      "-o",
      join(FIXTURES, "unused.pcapng"),
      "--format",
      "pcapng",
      "--link",
      "nope",
    ]);
    expect(captured.code).toBe(2);
    expect(captured.stderr).toContain("unknown link");
  });

  test("--format json --format pcapng reports the encoding and interfaces", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "summary.pcapng");
    const captured = await captureRun([
      SCENARIO,
      "-o",
      out,
      "--until",
      "50ms",
      "--format",
      "pcapng",
      "--format",
      "json",
    ]);
    expect(captured.code).toBe(0);
    const summary = JSON.parse(captured.stdout) as {
      output: string;
      format: string;
      interfaces: number;
      packets: number;
      bytes: number;
    };
    expect(summary.format).toBe("pcapng");
    expect(summary.interfaces).toBe(2);
    expect(summary.packets).toBeGreaterThan(0);
    expect(summary.bytes).toBe((await readFile(out)).length);
  });
});

describe("netlab pcap-import", () => {
  test("a classic capture becomes one JSON line per packet", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "import-classic.pcap");
    expect(
      (await captureRun([SCENARIO, "-o", out, "--until", "100ms"])).code,
    ).toBe(0);
    const captured = await captureImport([out, "--format", "json"]);
    expect(captured.code).toBe(0);
    expect(captured.stderr).toContain("imported");

    const packets = jsonLines(captured.stdout);
    const reference = await readCapture(out);
    expect(packets.length).toBe(reference.frames.length);
    expect(packets.length).toBeGreaterThan(0);
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i] as ImportedPacket;
      const frame = reference.frames[i];
      expect(packet.index).toBe(i + 1);
      expect(packet.ts).toBe(frame?.timeUs as number);
      expect(packet.link).toBe("interface-0");
      expect(packet.interface).toBe(0);
      expect(packet.length).toBe(frame?.inclLen as number);
      expect(packet.wireLength).toBe(frame?.origLen as number);
      expect(packet.l2?.src).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
      expect(packet.l2?.dst).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
      expect(packet.l2?.etherType).toBeGreaterThanOrEqual(0x0600);
    }

    // The fixture's traceroute is ICMP over IPv4, so the L3 summary decodes.
    const ipv4 = packets.filter((packet) => packet.l3?.type === "ipv4");
    expect(ipv4.length).toBeGreaterThan(0);
    expect(ipv4.some((packet) => packet.l3?.src === "10.0.0.2")).toBe(true);
    expect(ipv4.some((packet) => packet.l3?.dst === "10.0.1.2")).toBe(true);
    expect(ipv4.some((packet) => packet.l3?.protocolName === "icmp")).toBe(
      true,
    );
  });

  test("a pcapng capture keeps the interface names", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "import-ng.pcapng");
    expect(
      (
        await captureRun([
          SCENARIO,
          "-o",
          out,
          "--until",
          "100ms",
          "--format",
          "pcapng",
        ])
      ).code,
    ).toBe(0);
    const captured = await captureImport([out, "--format", "json"]);
    expect(captured.code).toBe(0);
    const packets = jsonLines(captured.stdout);
    expect(packets.length).toBeGreaterThan(0);
    expect(new Set(packets.map((packet) => packet.link))).toEqual(
      new Set([L1_NAME, L2_NAME]),
    );
    expect(new Set(packets.map((packet) => packet.interface))).toEqual(
      new Set([0, 1]),
    );
  });

  test("the default human output prints a line per packet", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "import-human.pcap");
    expect(
      (await captureRun([SCENARIO, "-o", out, "--until", "20ms"])).code,
    ).toBe(0);
    const captured = await captureImport([out]);
    expect(captured.code).toBe(0);
    const lines = captured.stdout.split("\n").filter((line) => line.length > 0);
    const packets = jsonLines(
      (await captureImport([out, "--format", "json"])).stdout,
    );
    expect(lines.length).toBe(packets.length + 1);
    expect(captured.stdout).toContain("eth");
    expect(captured.stdout).toContain("imported");
  });

  test("a file that is neither format exits 2 with a typed message", async () => {
    const bad = await fixture("not-a-capture.bin", "definitely not a capture");
    const captured = await captureImport([bad, "--format", "json"]);
    expect(captured.code).toBe(2);
    expect(captured.stderr).toContain("not a pcap or pcapng capture");
  });

  test("a truncated pcapng exits 2 with the parser's offset", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "import-truncated.pcapng");
    expect(
      (
        await captureRun([
          SCENARIO,
          "-o",
          out,
          "--until",
          "20ms",
          "--format",
          "pcapng",
        ])
      ).code,
    ).toBe(0);
    const bytes = await readFile(out);
    const cut = join(FIXTURES, "import-cut.pcapng");
    await writeFile(cut, bytes.subarray(0, bytes.length - 6));
    const captured = await captureImport([cut, "--format", "json"]);
    expect(captured.code).toBe(2);
    expect(captured.stderr).toContain("truncated");
    expect(captured.stderr).toContain("offset");
  });

  test("a frame that is not Ethernet decodes to a typed error, not a crash", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "import-short-frame.pcap");
    await writeFile(
      out,
      writePcap([{ timeUs: 0, bytes: Uint8Array.from([1, 2, 3, 4]) }]),
    );
    const captured = await captureImport([out, "--format", "json"]);
    expect(captured.code).toBe(0);
    const [packet] = jsonLines(captured.stdout);
    expect(packet?.length).toBe(4);
    expect(packet?.l2).toBeNull();
    expect(packet?.l3).toBeNull();
    expect(packet?.decodeError).toBe("truncated");
    const human = await captureImport([out]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("truncated");
  });

  test("a big-endian classic capture is named for what it is", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const be = join(FIXTURES, "import-big-endian.pcap");
    const bytes = new Uint8Array(24);
    bytes.set([0xa1, 0xb2, 0xc3, 0xd4], 0);
    await writeFile(be, bytes);
    const captured = await captureImport([be]);
    expect(captured.code).toBe(2);
    expect(captured.stderr).toContain("big-endian");
  });

  test("an unreadable capture exits 1", async () => {
    await mkdir(FIXTURES, { recursive: true });
    const captured = await captureImport([
      join(FIXTURES, "does-not-exist.pcap"),
    ]);
    expect(captured.code).toBe(1);
    expect(captured.stderr).toContain("cannot read");
  });

  test("missing <capture> and a bad --format are usage errors", async () => {
    const missing = await captureImport([]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing <capture>");
    const bad = await captureImport([
      join(FIXTURES, "x.pcap"),
      "--format",
      "yaml",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--format");
  });

  test("--help prints the usage and exits 0", async () => {
    const captured = await captureImport(["--help"]);
    expect(captured.code).toBe(0);
    expect(captured.stdout).toContain("netlab pcap-import");
  });
});

describe("netlab entrypoint", () => {
  test("lists and routes pcap-import", async () => {
    const help = await captureMain(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("pcap-import");

    await mkdir(FIXTURES, { recursive: true });
    const out = join(FIXTURES, "routed.pcapng");
    expect(
      (
        await captureRun([
          SCENARIO,
          "-o",
          out,
          "--until",
          "10ms",
          "--format",
          "pcapng",
        ])
      ).code,
    ).toBe(0);
    const imported = await captureMain([
      "pcap-import",
      out,
      "--format",
      "json",
    ]);
    expect(imported.code).toBe(0);
    expect(jsonLines(imported.stdout).length).toBeGreaterThan(0);
  });
});
