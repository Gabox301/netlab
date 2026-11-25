/**
 * Classic libpcap ("savefile", magic `0xa1b2c3d4`) writer and reader for
 * LINKTYPE_ETHERNET captures.
 *
 * Layout, in little-endian byte order:
 *
 * - 24-byte global header: magic, version 2.4, `thiszone`/`sigfigs` 0,
 *   snaplen {@link PCAP_SNAPLEN} and network {@link PCAP_LINKTYPE_ETHERNET}.
 * - One 16-byte record header per packet: `ts_sec`, `ts_usec`, `incl_len`
 *   (bytes stored) and `orig_len` (frame size on the wire), then the bytes.
 *
 * Timestamps come from the simulation clock in microseconds, so a frame at
 * `1_234_567` becomes `ts_sec = 1`, `ts_usec = 234_567`. PCAP has no
 * sub-microsecond precision and the simulation has no wall clock.
 *
 * Snap length: a frame longer than {@link PCAP_SNAPLEN} is stored truncated
 * to the snaplen and `orig_len` keeps the real size, exactly as a NIC with a
 * snapshot length records it. Readers see a short packet; nothing is
 * silently re-sized.
 *
 * The parser is total, like every other NetLab codec: malformed input
 * returns a typed {@link PcapParseResult} error carrying the byte offset
 * where decoding stopped, and never throws. Only little-endian classic
 * captures are accepted; the big-endian magic and the pcapng magic are
 * rejected with a message that names them (pcapng arrives in F-121).
 *
 * No `@netlab/bytes` here: its cursor is big-endian and PCAP is
 * little-endian, so reusing it would mean byte-swapping every field anyway.
 * The package stays dependency-free and engine-agnostic.
 */

/** Magic of a little-endian classic capture, as the 32-bit word it encodes. */
export const PCAP_MAGIC = 0xa1b2c3d4;

/** Magic of a big-endian classic capture (rejected, named in the error). */
const PCAP_MAGIC_BIG_ENDIAN = 0xd4c3b2a1;

/** First block type of a pcapng capture (F-121, rejected for now). */
export const PCAPNG_MAGIC = 0x0a0d0d0a;

/** PCAP major version this package writes and accepts. */
export const PCAP_VERSION_MAJOR = 2;

/** PCAP minor version this package writes. */
export const PCAP_VERSION_MINOR = 4;

/** Bytes of the global header that starts every classic capture. */
export const PCAP_GLOBAL_HEADER_LENGTH = 24;

/** Bytes of every per-packet record header. */
export const PCAP_RECORD_HEADER_LENGTH = 16;

/** Snapshot length: frames longer than this are stored truncated. */
export const PCAP_SNAPLEN = 262_144;

/** `network` value for Ethernet II frames (LINKTYPE_ETHERNET). */
export const PCAP_LINKTYPE_ETHERNET = 1;

const MICROS_PER_SECOND = 1_000_000;
const MAX_U32 = 0xffffffff;

/** One packet to write: a simulation timestamp and the bytes on the wire. */
export interface PcapFrameInput {
  /** Simulation time in microseconds. Stored as `ts_sec` + `ts_usec`. */
  timeUs: number;
  /** Frame bytes. Longer than the snaplen is truncated on write. */
  bytes: Uint8Array;
}

/** Decoded global header. */
export interface PcapGlobalHeader {
  versionMajor: number;
  versionMinor: number;
  /** GMT-to-local correction in seconds (0: the simulation is UTC). */
  thisZone: number;
  sigFigs: number;
  snaplen: number;
  network: number;
}

/** One decoded packet record. */
export interface PcapRecord {
  /** Whole seconds of the record timestamp. */
  tsSec: number;
  /** Microseconds of the record timestamp, `0..999999`. */
  tsUsec: number;
  /** `tsSec * 1_000_000 + tsUsec`, the simulation timestamp. */
  timeUs: number;
  /** Bytes stored in the file (`min(origLen, snaplen)`). */
  inclLen: number;
  /** Frame size the sender reported. */
  origLen: number;
  /** Captured bytes, a view over the parsed buffer (no copy). */
  bytes: Uint8Array;
}

/** A decoded classic capture. */
export interface PcapFile {
  header: PcapGlobalHeader;
  frames: Array<PcapRecord>;
}

/** Why a parser refused the bytes. */
export type PcapParseErrorCode =
  | "truncated"
  | "bad-magic"
  | "unsupported-version"
  | "unsupported-linktype"
  | "invalid-record"
  | "invalid";

/** Typed parse failure; `offset` is where decoding stopped. */
export interface PcapParseError {
  code: PcapParseErrorCode;
  message: string;
  /** Byte offset of the field (or the start of the structure) that failed. */
  offset: number;
}

/** Total result of parsing untrusted capture bytes. */
export type PcapParseResult =
  | { ok: true; value: PcapFile }
  | { ok: false; error: PcapParseError };

/** Thrown internally when a read runs past the end of the buffer. */
class TruncatedRead extends Error {
  readonly offset: number;

  constructor(offset: number, needed: number, available: number) {
    super(
      `truncated capture: need ${needed} byte(s) at offset ${offset}, ` +
        `${available} available`,
    );
    this.name = "TruncatedRead";
    this.offset = offset;
  }
}

function checkRange(data: Uint8Array, offset: number, needed: number): void {
  if (offset + needed > data.length) {
    throw new TruncatedRead(offset, needed, data.length - offset);
  }
}

function readU16le(data: Uint8Array, offset: number): number {
  checkRange(data, offset, 2);
  return (data[offset] as number) | ((data[offset + 1] as number) << 8);
}

function readU32le(data: Uint8Array, offset: number): number {
  checkRange(data, offset, 4);
  return (
    ((data[offset] as number) |
      ((data[offset + 1] as number) << 8) |
      ((data[offset + 2] as number) << 16) |
      ((data[offset + 3] as number) << 24)) >>>
    0
  );
}

function writeU16le(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32le(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function parseOk(value: PcapFile): PcapParseResult {
  return { ok: true, value };
}

function parseErr(
  code: PcapParseErrorCode,
  message: string,
  offset: number,
): PcapParseResult {
  return { ok: false, error: { code, message, offset } };
}

/**
 * Split a simulation timestamp into the PCAP pair.
 *
 * Throws `RangeError` when `timeUs` is not a non-negative integer or its
 * seconds do not fit in the 32-bit `ts_sec` field: a writer with an
 * unrepresentable timestamp must fail loudly instead of wrapping the date.
 */
export function splitTimestamp(timeUs: number): {
  tsSec: number;
  tsUsec: number;
} {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new RangeError(
      `pcap timestamp must be a non-negative integer of microseconds: ${timeUs}`,
    );
  }
  const tsSec = Math.floor(timeUs / MICROS_PER_SECOND);
  if (tsSec > MAX_U32) {
    throw new RangeError(`pcap ts_sec does not fit in 32 bits: ${timeUs}us`);
  }
  return { tsSec, tsUsec: timeUs - tsSec * MICROS_PER_SECOND };
}

/**
 * Serialize frames as a classic capture.
 *
 * Records follow the caller's order: the writer never sorts, because only
 * the caller knows what order the wire saw (the CLI sorts `frame_tx` traces
 * by simulation time before calling this). Each record captures
 * `min(bytes.length, PCAP_SNAPLEN)` bytes and stores `bytes.length` in
 * `orig_len`; the result is a copy, so later writes to the source frames do
 * not touch the capture.
 *
 * Throws `RangeError` on a frame that cannot be represented (a negative or
 * fractional timestamp, or a size that does not fit the 32-bit fields).
 */
export function writePcap(frames: ReadonlyArray<PcapFrameInput>): Uint8Array {
  const capturedLengths: Array<number> = [];
  let total = PCAP_GLOBAL_HEADER_LENGTH;
  for (const frame of frames) {
    splitTimestamp(frame.timeUs);
    if (frame.bytes.length > MAX_U32) {
      throw new RangeError(
        `pcap orig_len does not fit in 32 bits: ${frame.bytes.length}`,
      );
    }
    const inclLen = Math.min(frame.bytes.length, PCAP_SNAPLEN);
    capturedLengths.push(inclLen);
    total += PCAP_RECORD_HEADER_LENGTH + inclLen;
  }

  const out = new Uint8Array(total);
  writeU32le(out, 0, PCAP_MAGIC);
  writeU16le(out, 4, PCAP_VERSION_MAJOR);
  writeU16le(out, 6, PCAP_VERSION_MINOR);
  writeU32le(out, 8, 0); // thiszone
  writeU32le(out, 12, 0); // sigfigs
  writeU32le(out, 16, PCAP_SNAPLEN);
  writeU32le(out, 20, PCAP_LINKTYPE_ETHERNET);

  let offset = PCAP_GLOBAL_HEADER_LENGTH;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i] as PcapFrameInput;
    const inclLen = capturedLengths[i] as number;
    const { tsSec, tsUsec } = splitTimestamp(frame.timeUs);
    writeU32le(out, offset, tsSec);
    writeU32le(out, offset + 4, tsUsec);
    writeU32le(out, offset + 8, inclLen);
    writeU32le(out, offset + 12, frame.bytes.length);
    out.set(
      frame.bytes.subarray(0, inclLen),
      offset + PCAP_RECORD_HEADER_LENGTH,
    );
    offset += PCAP_RECORD_HEADER_LENGTH + inclLen;
  }
  return out;
}

/**
 * Parse a classic capture. Never throws.
 *
 * Failures are typed and carry the offset where decoding stopped:
 * `truncated` (the file ends inside the global header, a record header or a
 * frame body), `bad-magic` (including big-endian and pcapng captures, named
 * in the message), `unsupported-version` (major other than 2),
 * `unsupported-linktype` (anything but LINKTYPE_ETHERNET), `invalid-record`
 * (`ts_usec` out of range, `incl_len > orig_len` or than the snaplen) and
 * `invalid` as the catch-all.
 *
 * A file that ends cleanly between records parses as a shorter capture: that
 * is exactly what a capture cut at a record boundary looks like. A global
 * snaplen of 0 is treated as unlimited, as some writers use it. Captured
 * bytes are views over `data`; treat them as read-only.
 */
export function parsePcap(data: Uint8Array): PcapParseResult {
  if (data.length < PCAP_GLOBAL_HEADER_LENGTH) {
    return parseErr(
      "truncated",
      `classic pcap needs a ${PCAP_GLOBAL_HEADER_LENGTH}-byte global header, ` +
        `got ${data.length}`,
      0,
    );
  }
  try {
    const magic = readU32le(data, 0);
    if (magic !== PCAP_MAGIC) {
      if (magic === PCAPNG_MAGIC) {
        return parseErr(
          "bad-magic",
          "pcapng capture (magic 0x0a0d0d0a): F-120 reads and writes " +
            "classic libpcap only",
          0,
        );
      }
      if (magic === PCAP_MAGIC_BIG_ENDIAN) {
        return parseErr(
          "bad-magic",
          "big-endian classic pcap (magic 0xa1b2c3d4): NetLab writes and " +
            "reads little-endian captures only",
          0,
        );
      }
      return parseErr(
        "bad-magic",
        `not a classic pcap file: magic ${hex32(magic)} ` +
          `(expected ${hex32(PCAP_MAGIC)})`,
        0,
      );
    }

    const versionMajor = readU16le(data, 4);
    const versionMinor = readU16le(data, 6);
    if (versionMajor !== PCAP_VERSION_MAJOR) {
      return parseErr(
        "unsupported-version",
        `pcap version ${versionMajor}.${versionMinor}: expected major ` +
          `version ${PCAP_VERSION_MAJOR}`,
        4,
      );
    }

    const thisZone = readU32le(data, 8) | 0;
    const sigFigs = readU32le(data, 12);
    const snaplen = readU32le(data, 16);
    const network = readU32le(data, 20);
    if (network !== PCAP_LINKTYPE_ETHERNET) {
      return parseErr(
        "unsupported-linktype",
        `network ${network}: only LINKTYPE_ETHERNET ` +
          `(${PCAP_LINKTYPE_ETHERNET}) is supported`,
        20,
      );
    }

    const frames: Array<PcapRecord> = [];
    let offset = PCAP_GLOBAL_HEADER_LENGTH;
    while (offset < data.length) {
      const recordStart = offset;
      checkRange(data, recordStart, PCAP_RECORD_HEADER_LENGTH);
      const tsSec = readU32le(data, recordStart);
      const tsUsec = readU32le(data, recordStart + 4);
      const inclLen = readU32le(data, recordStart + 8);
      const origLen = readU32le(data, recordStart + 12);
      if (tsUsec >= MICROS_PER_SECOND) {
        return parseErr(
          "invalid-record",
          `record at offset ${recordStart} has ts_usec ${tsUsec}: ` +
            `expected 0..999999`,
          recordStart + 4,
        );
      }
      if (inclLen > origLen) {
        return parseErr(
          "invalid-record",
          `record at offset ${recordStart} captures ${inclLen} byte(s) ` +
            `of a ${origLen}-byte frame`,
          recordStart,
        );
      }
      if (snaplen !== 0 && inclLen > snaplen) {
        return parseErr(
          "invalid-record",
          `record at offset ${recordStart} captures ${inclLen} byte(s), ` +
            `more than the ${snaplen}-byte snaplen`,
          recordStart + 8,
        );
      }
      const bodyStart = recordStart + PCAP_RECORD_HEADER_LENGTH;
      checkRange(data, bodyStart, inclLen);
      frames.push({
        tsSec,
        tsUsec,
        timeUs: tsSec * MICROS_PER_SECOND + tsUsec,
        inclLen,
        origLen,
        bytes: data.subarray(bodyStart, bodyStart + inclLen),
      });
      offset = bodyStart + inclLen;
    }

    return parseOk({
      header: {
        versionMajor,
        versionMinor,
        thisZone,
        sigFigs,
        snaplen,
        network,
      },
      frames,
    });
  } catch (error) {
    if (error instanceof TruncatedRead) {
      return parseErr("truncated", error.message, error.offset);
    }
    return parseErr(
      "invalid",
      error instanceof Error ? error.message : String(error),
      0,
    );
  }
}
