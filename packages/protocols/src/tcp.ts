/**
 * TCP segments (RFC 9293, F-53).
 *
 * 20-byte header: `srcPort(2) dstPort(2) seq(4) ack(4) dataOffset/reserved(1)
 * flags(1) window(2) checksum(2) urgent(2)`, big-endian, followed by options
 * (`dataOffset*4 - 20` bytes) and the payload. The checksum covers the IPv4
 * pseudo-header plus the whole segment; a received checksum of zero means
 * "not computed" and is accepted without verification.
 *
 * A TCP segment carries no length field of its own: the IPv4 layer delimits
 * it, so `payload` runs from the end of the header to the end of the buffer
 * and any trailing padding passed in by the caller is indistinguishable.
 *
 * Like every NetLab codec, the parser is total: it never throws.
 */

import {
  BufferReader,
  BufferWriter,
  type Ipv4Address,
  TruncatedError,
  transportChecksum,
} from "@netlab/bytes";
import { type ParseResult, parseErr, parseOk } from "./ethernet";
import { IPV4_PROTOCOL_TCP } from "./ipv4";

/** Bytes of a TCP header without options. */
export const TCP_HEADER_LENGTH = 20;

/** Smallest legal data offset, in 32-bit words. */
const TCP_MIN_DATA_OFFSET = 5;

/** Option kind for the Maximum Segment Size option (RFC 9293 §3.2). */
const TCP_OPTION_MSS = 2;

/** Option kinds with a one-byte encoding: End of option list, No-op. */
const TCP_OPTION_END = 0;
const TCP_OPTION_NOP = 1;

/** Control bits of a TCP segment. */
export interface TcpFlags {
  fin: boolean;
  syn: boolean;
  rst: boolean;
  psh: boolean;
  ack: boolean;
  urg: boolean;
}

/** A decoded TCP segment. */
export interface TcpSegment {
  srcPort: number;
  dstPort: number;
  /** Sequence number (32-bit, unsigned). */
  seq: number;
  /** Acknowledgment number (32-bit, unsigned); meaningless without ACK. */
  ack: number;
  flags: TcpFlags;
  /** Advertised receive window. */
  window: number;
  /** Urgent pointer; meaningless without URG. */
  urgent: number;
  /** MSS option value when the segment carried a well-formed one. */
  mss?: number;
  /** Bytes after the header (a copy: mutating it cannot corrupt the frame). */
  payload: Uint8Array;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkU16(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be 0..65535: ${value}`);
  }
}

function checkU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be 0..4294967295: ${value}`);
  }
}

function flagsFromByte(byte: number): TcpFlags {
  return {
    fin: (byte & 0x01) !== 0,
    syn: (byte & 0x02) !== 0,
    rst: (byte & 0x04) !== 0,
    psh: (byte & 0x08) !== 0,
    ack: (byte & 0x10) !== 0,
    urg: (byte & 0x20) !== 0,
  };
}

function flagsToByte(flags: TcpFlags): number {
  return (
    (flags.fin ? 0x01 : 0) |
    (flags.syn ? 0x02 : 0) |
    (flags.rst ? 0x04 : 0) |
    (flags.psh ? 0x08 : 0) |
    (flags.ack ? 0x10 : 0) |
    (flags.urg ? 0x20 : 0)
  );
}

/** Scan the option block for a well-formed MSS option. */
function findMss(options: Uint8Array): number | undefined {
  let i = 0;
  while (i < options.length) {
    const kind = options[i] as number;
    if (kind === TCP_OPTION_END) {
      return undefined;
    }
    if (kind === TCP_OPTION_NOP) {
      i += 1;
      continue;
    }
    const length = options[i + 1];
    if (length === undefined || length < 2 || i + length > options.length) {
      return undefined;
    }
    if (kind === TCP_OPTION_MSS && length === 4) {
      return ((options[i + 2] as number) << 8) | (options[i + 3] as number);
    }
    i += length;
  }
  return undefined;
}

/**
 * Parse one TCP segment.
 *
 * `truncated` below 20 bytes or when the data offset points past the buffer;
 * `invalid` for a data offset below five words or a bad checksum (only
 * verified when `opts` carries both addresses and the checksum is nonzero).
 * The parser never throws.
 */
export function parseTcp(
  data: Uint8Array,
  opts: { src?: Ipv4Address; dst?: Ipv4Address } = {},
): ParseResult<TcpSegment> {
  if (data.length < TCP_HEADER_LENGTH) {
    return parseErr(
      "truncated",
      `tcp needs at least ${TCP_HEADER_LENGTH} bytes, got ${data.length}`,
    );
  }
  try {
    const reader = new BufferReader(data);
    const srcPort = reader.u16be();
    const dstPort = reader.u16be();
    const seq = reader.u32be();
    const ack = reader.u32be();
    const offsetByte = reader.u8();
    const dataOffset = offsetByte >> 4;
    if (dataOffset < TCP_MIN_DATA_OFFSET) {
      return parseErr(
        "invalid",
        `tcp data offset must be >= ${TCP_MIN_DATA_OFFSET} words, ` +
          `got ${dataOffset}`,
      );
    }
    const headerLength = dataOffset * 4;
    if (data.length < headerLength) {
      return parseErr(
        "truncated",
        `tcp header needs ${headerLength} bytes, got ${data.length}`,
      );
    }
    const flags = flagsFromByte(reader.u8());
    const window = reader.u16be();
    const checksum = reader.u16be();
    const urgent = reader.u16be();
    const options = reader.bytes(headerLength - TCP_HEADER_LENGTH);
    if (
      checksum !== 0 &&
      opts.src !== undefined &&
      opts.dst !== undefined &&
      transportChecksum(opts.src, opts.dst, IPV4_PROTOCOL_TCP, data) !== 0
    ) {
      return parseErr("invalid", "tcp bad checksum");
    }
    const mss = findMss(options);
    const payload = data.slice(headerLength);
    if (mss === undefined) {
      return parseOk({
        srcPort,
        dstPort,
        seq,
        ack,
        flags,
        window,
        urgent,
        payload,
      });
    }
    return parseOk({
      srcPort,
      dstPort,
      seq,
      ack,
      flags,
      window,
      urgent,
      mss,
      payload,
    });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `truncated tcp segment: ${err.message}`);
    }
    return parseErr("invalid", `invalid tcp segment: ${errorMessage(err)}`);
  }
}

/**
 * Serialize one TCP segment for `src -> dst`.
 *
 * The data offset and checksum are derived from `mss` and the payload; a
 * segment carrying an MSS option gets a 4-byte options block, so its header
 * grows to 24 bytes. A computed checksum of zero is sent as `0xFFFF` per
 * RFC 9293. Throws `RangeError` on out-of-range header fields or an oversized
 * segment.
 */
export function serializeTcp(
  segment: TcpSegment,
  src: Ipv4Address,
  dst: Ipv4Address,
): Uint8Array {
  checkU16("srcPort", segment.srcPort);
  checkU16("dstPort", segment.dstPort);
  checkU32("seq", segment.seq);
  checkU32("ack", segment.ack);
  checkU16("window", segment.window);
  checkU16("urgent", segment.urgent);
  if (segment.mss !== undefined) {
    checkU16("mss", segment.mss);
  }
  const optionBytes = segment.mss === undefined ? 0 : 4;
  const headerLength = TCP_HEADER_LENGTH + optionBytes;
  const totalLength = headerLength + segment.payload.length;
  if (totalLength > 0xffff) {
    throw new RangeError(`tcp segment too long: ${totalLength} bytes`);
  }
  const writer = new BufferWriter(totalLength);
  writer.u16be(segment.srcPort);
  writer.u16be(segment.dstPort);
  writer.u32be(segment.seq);
  writer.u32be(segment.ack);
  writer.u8((headerLength / 4) << 4);
  writer.u8(flagsToByte(segment.flags));
  writer.u16be(segment.window);
  writer.u16be(0);
  writer.u16be(segment.urgent);
  if (segment.mss !== undefined) {
    writer.u8(TCP_OPTION_MSS);
    writer.u8(4);
    writer.u16be(segment.mss);
  }
  writer.bytes(segment.payload);
  const bytes = writer.toBytes();
  let checksum = transportChecksum(src, dst, IPV4_PROTOCOL_TCP, bytes);
  if (checksum === 0) {
    checksum = 0xffff;
  }
  bytes[16] = (checksum >> 8) & 0xff;
  bytes[17] = checksum & 0xff;
  return bytes;
}
