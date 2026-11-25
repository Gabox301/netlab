/**
 * `netlab pcap` and `netlab pcap-import` entrypoints (F-120 to F-123).
 *
 * Export: run a scenario and write its wire traffic as a capture, classic
 * libpcap (F-120) by default or pcapng (F-121) with
 * `--format pcapng`. Capture decision: one record per `frame_tx` trace,
 * ordered by simulation time. `frame_tx` is the frame an endpoint hands to
 * its link — what would be seen leaving that NIC — while `frame_rx` is the
 * same transmission seen from the other end and `frame_drop` never reached
 * the wire at all. The exporter therefore records each transmission exactly
 * once, in wire order; the sort is stable, so frames that share a timestamp
 * keep their emission order.
 *
 * Per-interface capture (F-122): every link becomes one interface. pcapng
 * writes an IDB per link, named after the devices it joins
 * (`h1:eth0-r1:p0`), and `--link` keeps only the selected links — repeatable,
 * and the whole network when absent. Classic pcap has a single interface, so
 * there `--link` only filters the records.
 *
 * Import (F-123): `netlab pcap-import` reads either format — the magic word
 * picks the parser — decodes Ethernet and, when the EtherType says IPv4, the
 * network header with `@netlab/protocols`, and prints one line per packet
 * with its index, timestamp, interface, length and L2/L3 summary. That line
 * is the shape the web inspector's "Analizar" mode will consume; wiring it
 * into the UI is out of scope here.
 *
 * Timestamps are the scenario's virtual microseconds, not a wall clock: the
 * capture is reproducible from the seed and the horizon. An imported capture
 * reports its own timestamps in microseconds.
 *
 * Usage: netlab pcap <scenario.json> -o <out.pcap> [--seed N] [--until 10s]
 *                                     [--format human|json|pcap|pcapng]
 *                                     [--link <id>]...
 *        netlab pcap-import <capture.pcap|capture.pcapng> [--format human|json]
 * Exit codes: 0 written or imported · 1 scenario, run, read or write failure ·
 * 2 usage or parse error.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { Trace } from "@netlab/core";
import {
  PCAP_MAGIC,
  PCAPNG_MAGIC,
  type PcapFrameInput,
  type PcapngLink,
  parsePcap,
  parsePcapng,
  writePcap,
  writePcapng,
} from "@netlab/pcap";
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_VLAN,
  IPV4_PROTOCOL_ICMP,
  IPV4_PROTOCOL_TCP,
  IPV4_PROTOCOL_UDP,
  parseEthernet,
  parseIpv4,
} from "@netlab/protocols";
import { type RunResult, runScenario } from "./run";
import {
  parseDurationToUs,
  parseScenarioText,
  type Scenario,
} from "./scenario";

/** Capture encoding `netlab pcap` writes. */
export type CaptureFormat = "pcap" | "pcapng";

export const PCAP_USAGE =
  "Usage: netlab pcap <scenario.json> -o <out.pcap> [--seed N] [--until 10s] [--format human|json|pcap|pcapng] [--link <id>]...\n" +
  "  run a scenario and write its frame_tx traffic as a capture (classic pcap by default)\n" +
  "  --until overrides the scenario horizon (e.g. 10s, 100ms)\n" +
  "  --format human|json selects the summary line; --format pcap|pcapng selects the capture encoding\n" +
  "  --link <id> captures only that link's frames; repeatable, default is the whole network\n" +
  "  exit 0 when the capture is written, 1 on a run or write failure, 2 on usage or parse errors\n";

export const PCAP_IMPORT_USAGE =
  "Usage: netlab pcap-import <capture.pcap|capture.pcapng> [--format human|json]\n" +
  "  parse a classic pcap or pcapng capture and describe one packet per line\n" +
  "  --format json prints one JSON object per packet (index, ts, link, length, L2/L3)\n" +
  "  exit 0 when the capture is read, 1 on a read failure, 2 on usage or parse errors\n";

interface PcapArgs {
  file: string;
  output: string;
  seed: number | undefined;
  untilUs: number | undefined;
  /** Summary line format. */
  format: "human" | "json";
  /** Capture encoding written to `output`. */
  captureFormat: CaptureFormat;
  /** Link ids to capture; empty means every link. */
  links: Array<string>;
}

/** What `--format json` promises and the human line summarises. */
export interface PcapSummary {
  /** The scenario that was run. */
  scenario: string;
  /** The capture file that was written. */
  output: string;
  /** Capture encoding: classic pcap or pcapng. */
  format: CaptureFormat;
  /** Interfaces (links) the capture declares. */
  interfaces: number;
  /** Records in the capture (one per `frame_tx` trace). */
  packets: number;
  /** Size of the capture file in bytes, headers included. */
  bytes: number;
  seed: number;
  untilUs: number;
  /** Simulation time the run reached. */
  finalTime: number;
}

/** One captured frame: the trace payload plus the link it was seen on. */
export interface CapturedFrame extends PcapFrameInput {
  /** Link the frame was transmitted on; becomes the pcapng interface. */
  link: string;
}

/** One interface a capture declares: a link and the devices it joins. */
export interface CaptureLink extends PcapngLink {
  /** `if_name`: `node:iface-node:iface`, the devices the link connects. */
  name: string;
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
  let captureFormat: CaptureFormat = "pcap";
  const links: Array<string> = [];
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
      if (raw === "human" || raw === "json") {
        format = raw;
      } else if (raw === "pcap" || raw === "pcapng") {
        captureFormat = raw;
      } else {
        throw usageError(
          `--format must be "human", "json", "pcap" or "pcapng", got ` +
            JSON.stringify(raw),
        );
      }
    } else if (arg === "--link") {
      const raw = argv[++i];
      if (raw === undefined || raw.length === 0) {
        throw usageError("--link needs a link id");
      }
      links.push(raw);
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
  return { file, output, seed, untilUs, format, captureFormat, links };
}

/**
 * The frames a capture keeps: `frame_tx` traces, stable-sorted by time.
 *
 * `links` restricts the capture to those links (F-122); empty keeps the whole
 * network. Frames travel by reference in the trace bus, so the returned
 * `bytes` are views over the traces. The runner never reuses a frame buffer
 * after `send()`, and the writers copy what they store.
 */
export function captureFrames(
  traces: ReadonlyArray<Trace>,
  links: ReadonlyArray<string> = [],
): Array<CapturedFrame> {
  const wanted = links.length > 0 ? new Set(links) : undefined;
  const frames: Array<CapturedFrame> = [];
  for (const trace of traces) {
    if (trace.kind !== "frame_tx") {
      continue;
    }
    if (wanted !== undefined && !wanted.has(trace.link)) {
      continue;
    }
    frames.push({ timeUs: trace.t, bytes: trace.frame, link: trace.link });
  }
  frames.sort((a, b) => a.timeUs - b.timeUs);
  return frames;
}

/**
 * The interfaces a capture declares, in scenario order.
 *
 * `selected` is `--link`: when given, every selected link gets an interface
 * even if it carried no frame (an empty but valid capture of that link);
 * when empty, only links that actually saw traffic are declared.
 */
export function captureLinks(
  scenario: Scenario,
  frames: ReadonlyArray<CapturedFrame>,
  selected: ReadonlyArray<string>,
): Array<CaptureLink> {
  const wanted =
    selected.length > 0
      ? new Set(selected)
      : new Set(frames.map((frame) => frame.link));
  return scenario.links
    .filter((link) => wanted.has(link.id))
    .map((link) => ({
      id: link.id,
      name: `${link.a.node}:${link.a.iface}-${link.b.node}:${link.b.iface}`,
    }));
}

/** One line: where the capture went and what it contains. */
export function formatPcapHuman(summary: PcapSummary): string {
  return (
    `wrote ${summary.output}: ${summary.packets} packets, ` +
    `${summary.bytes} bytes (${summary.format}, ` +
    `${summary.interfaces} interface(s), seed=${summary.seed}, ` +
    `until=${summary.untilUs}us, final t=${summary.finalTime}us)\n`
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

  const declared = new Set(scenario.links.map((link) => link.id));
  for (const id of args.links) {
    if (!declared.has(id)) {
      process.stderr.write(
        `unknown link ${JSON.stringify(id)}: the scenario declares ` +
          `${[...declared].join(", ")}\n${PCAP_USAGE}`,
      );
      return 2;
    }
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

  const frames = captureFrames(result.traces, args.links);
  const links = captureLinks(scenario, frames, args.links);
  let capture: Uint8Array;
  try {
    capture =
      args.captureFormat === "pcapng"
        ? writePcapng(frames, links)
        : writePcap(frames);
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
    format: args.captureFormat,
    interfaces: args.captureFormat === "pcapng" ? links.length : 1,
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

// --------------------------------------------------------------------------
// Import (F-123)
// --------------------------------------------------------------------------

/** One interface a decoded capture reports. */
export interface ImportedL2 {
  dst: string;
  src: string;
  etherType: number;
  etherTypeName: string;
}

/** The IPv4 header summary of a decoded packet. */
export interface ImportedL3 {
  type: "ipv4";
  src: string;
  dst: string;
  ttl: number;
  /** IP protocol number (1 = ICMP, 6 = TCP, 17 = UDP). */
  protocol: number;
  protocolName: string;
  /** Datagram length in bytes, header included. */
  length: number;
}

/** One decoded packet: the JSON shape `--format json` prints per line. */
export interface ImportedPacket {
  /** 1-based frame number, as dissectors count them. */
  index: number;
  /** Packet timestamp in microseconds. */
  ts: number;
  /** Interface name (pcapng `if_name`) or `interface-<n>` when unnamed. */
  link: string;
  /** Interface position in the capture; classic pcap always has one. */
  interface: number;
  /** Captured bytes (shorter than `wireLength` on a snapped capture). */
  length: number;
  /** Frame size on the wire. */
  wireLength: number;
  /** Decoded Ethernet header, or null when the frame is not decodable. */
  l2: ImportedL2 | null;
  /** Decoded IPv4 header, or null when the frame is not IPv4. */
  l3: ImportedL3 | null;
  /** Why a header could not be decoded, or null. */
  decodeError: string | null;
}

/** A capture read back from bytes. */
export interface ImportedCapture {
  format: CaptureFormat;
  /** Interfaces the capture declares. */
  interfaces: number;
  packets: Array<ImportedPacket>;
}

/** Typed failure of the import reader. */
export interface CaptureImportError {
  code: string;
  message: string;
  offset: number;
}

/** Total result of importing untrusted capture bytes. */
export type CaptureImportResult =
  | { ok: true; value: ImportedCapture }
  | { ok: false; error: CaptureImportError };

/** Magic of a big-endian classic capture, named when it shows up. */
const PCAP_MAGIC_BIG_ENDIAN = 0xd4c3b2a1;

function readMagic(data: Uint8Array): number | undefined {
  if (data.length < 4) {
    return undefined;
  }
  return (
    ((data[0] as number) |
      ((data[1] as number) << 8) |
      ((data[2] as number) << 16) |
      ((data[3] as number) << 24)) >>>
    0
  );
}

/** Which format the first four bytes announce, by magic word. */
export function captureFormatOf(data: Uint8Array): CaptureFormat | "unknown" {
  const magic = readMagic(data);
  if (magic === PCAPNG_MAGIC) {
    return "pcapng";
  }
  if (magic === PCAP_MAGIC || magic === PCAP_MAGIC_BIG_ENDIAN) {
    return "pcap";
  }
  return "unknown";
}

function etherTypeName(etherType: number): string {
  switch (etherType) {
    case ETHERTYPE_IPV4:
      return "ipv4";
    case ETHERTYPE_ARP:
      return "arp";
    case ETHERTYPE_VLAN:
      return "vlan";
    case 0x86dd:
      return "ipv6";
    default:
      return `0x${etherType.toString(16).padStart(4, "0")}`;
  }
}

function protocolName(protocol: number): string {
  switch (protocol) {
    case IPV4_PROTOCOL_ICMP:
      return "icmp";
    case IPV4_PROTOCOL_TCP:
      return "tcp";
    case IPV4_PROTOCOL_UDP:
      return "udp";
    default:
      return `ip/${protocol}`;
  }
}

/** Decode Ethernet and, when it is IPv4, the network header. Never throws. */
function decodeFrame(bytes: Uint8Array): {
  l2: ImportedL2 | null;
  l3: ImportedL3 | null;
  decodeError: string | null;
} {
  const ethernet = parseEthernet(bytes);
  if (!ethernet.ok) {
    return { l2: null, l3: null, decodeError: ethernet.error.code };
  }
  const header = ethernet.value;
  const l2: ImportedL2 = {
    dst: header.dst.toString(),
    src: header.src.toString(),
    etherType: header.etherType,
    etherTypeName: etherTypeName(header.etherType),
  };
  if (header.etherType !== ETHERTYPE_IPV4) {
    return { l2, l3: null, decodeError: null };
  }
  const ipv4 = parseIpv4(header.payload);
  if (!ipv4.ok) {
    return { l2, l3: null, decodeError: ipv4.error.code };
  }
  const ip = ipv4.value.header;
  return {
    l2,
    l3: {
      type: "ipv4",
      src: ip.src.toString(),
      dst: ip.dst.toString(),
      ttl: ip.ttl,
      protocol: ip.protocol,
      protocolName: protocolName(ip.protocol),
      length: ip.totalLength,
    },
    decodeError: null,
  };
}

function buildPacket(
  index: number,
  ts: number,
  link: string,
  interfaceIndex: number,
  bytes: Uint8Array,
  wireLength: number,
): ImportedPacket {
  const decoded = decodeFrame(bytes);
  return {
    index,
    ts,
    link,
    interface: interfaceIndex,
    length: bytes.length,
    wireLength,
    l2: decoded.l2,
    l3: decoded.l3,
    decodeError: decoded.decodeError,
  };
}

/**
 * Read a capture of either format and decode every packet. Never throws.
 *
 * The magic word picks the parser, so a pcapng is never fed to the classic
 * reader and vice versa; failures keep the parser's typed code, message and
 * byte offset. Packet text is not part of this layer: callers print
 * {@link ImportedPacket} as JSON or as a human line.
 */
export function importCapture(data: Uint8Array): CaptureImportResult {
  const format = captureFormatOf(data);
  if (format === "unknown") {
    const magic = readMagic(data);
    return {
      ok: false,
      error: {
        code: "bad-magic",
        message:
          "not a pcap or pcapng capture: magic " +
          (magic === undefined
            ? `missing (${data.length} byte(s))`
            : `0x${magic.toString(16).padStart(8, "0")}`),
        offset: 0,
      },
    };
  }
  if (format === "pcapng") {
    const parsed = parsePcapng(data);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const file = parsed.value;
    const packets = file.packets.map((packet, i) => {
      const iface = file.interfaces[packet.interfaceIndex];
      return buildPacket(
        i + 1,
        packet.timeUs,
        iface?.name ?? `interface-${packet.interfaceIndex}`,
        packet.interfaceIndex,
        packet.bytes,
        packet.wirelen,
      );
    });
    return {
      ok: true,
      value: { format, interfaces: file.interfaces.length, packets },
    };
  }
  const parsed = parsePcap(data);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  // Classic pcap has a single implicit interface and no names for it.
  const packets = parsed.value.frames.map((record, i) =>
    buildPacket(
      i + 1,
      record.timeUs,
      `interface-0`,
      0,
      record.bytes,
      record.origLen,
    ),
  );
  return { ok: true, value: { format, interfaces: 1, packets } };
}

/** The packet as one JSON line. */
export function formatImportJson(packet: ImportedPacket): string {
  return `${JSON.stringify(packet)}\n`;
}

/** The packet as one human line: index, time, interface, lengths, L2/L3. */
export function formatImportHuman(packet: ImportedPacket): string {
  const l2 =
    packet.l2 === null
      ? `eth <${packet.decodeError ?? "undecodable"}>`
      : `eth ${packet.l2.src} > ${packet.l2.dst} ${packet.l2.etherTypeName}`;
  const l3 =
    packet.l3 === null
      ? ""
      : ` | ipv4 ${packet.l3.src} > ${packet.l3.dst} ` +
        `${packet.l3.protocolName} ttl=${packet.l3.ttl}`;
  return (
    `#${packet.index} t=${packet.ts}us ${packet.link} ` +
    `${packet.length}B ${l2}${l3}\n`
  );
}

interface PcapImportArgs {
  file: string;
  format: "human" | "json";
}

function importUsageError(message: string): Error {
  return new Error(`${message}\n${PCAP_IMPORT_USAGE}`);
}

/** Parse `netlab pcap-import` arguments (without the command word). */
export function parsePcapImportArgs(argv: Array<string>): PcapImportArgs {
  if (argv[0] === "-h" || argv[0] === "--help") {
    throw Object.assign(
      importUsageError("netlab pcap-import needs a capture file."),
      { code: "HELP" },
    );
  }
  let file: string | undefined;
  let format: "human" | "json" = "human";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--format") {
      const raw = argv[++i];
      if (raw !== "human" && raw !== "json") {
        throw importUsageError(
          `--format must be "human" or "json", got ${JSON.stringify(raw)}`,
        );
      }
      format = raw;
    } else if (arg.startsWith("-")) {
      throw importUsageError(`unknown flag ${JSON.stringify(arg)}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw importUsageError(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }
  if (file === undefined) {
    throw importUsageError("missing <capture>");
  }
  return { file, format };
}

/** Run `netlab pcap-import` and return the process exit code. */
export async function runPcapImport(argv: Array<string>): Promise<number> {
  let args: PcapImportArgs;
  try {
    args = parsePcapImportArgs(argv);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "HELP") {
      process.stdout.write(PCAP_IMPORT_USAGE);
      return 0;
    }
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(args.file));
  } catch (error) {
    process.stderr.write(`cannot read ${args.file}: ${errorMessage(error)}\n`);
    return 1;
  }

  const imported = importCapture(data);
  if (!imported.ok) {
    // Name the typed code and the offset: a corrupt capture is a parse error
    // (2), and the caller has to know where decoding stopped.
    process.stderr.write(
      `${imported.error.message} ` +
        `(${imported.error.code} at offset ${imported.error.offset})\n`,
    );
    return 2;
  }

  const { format, interfaces, packets } = imported.value;
  if (args.format === "json") {
    for (const packet of packets) {
      process.stdout.write(formatImportJson(packet));
    }
  } else {
    for (const packet of packets) {
      process.stdout.write(formatImportHuman(packet));
    }
  }
  const summary =
    `imported ${packets.length} packet(s) from ${args.file} ` +
    `(${format}, ${interfaces} interface(s))`;
  if (args.format === "json") {
    // Stdout stays pure JSON lines; the counters go where they do for `run`.
    process.stderr.write(`${summary}\n`);
  } else {
    process.stdout.write(`${summary}\n`);
  }
  return 0;
}
