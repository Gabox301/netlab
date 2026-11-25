/**
 * UDP datagrams (RFC 768).
 *
 * 8-byte header: `srcPort(2) dstPort(2) length(2) checksum(2)`, big-endian,
 * followed by `length - 8` payload bytes. The checksum covers the IPv4
 * pseudo-header plus the whole datagram; a received checksum of zero means
 * "not computed" and is accepted without verification.
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
import { IPV4_PROTOCOL_UDP } from "./ipv4";

/** Bytes of a UDP header. */
export const UDP_HEADER_LENGTH = 8;

/** A decoded UDP datagram. */
export interface UdpDatagram {
  srcPort: number;
  dstPort: number;
  /** Header + payload, as carried in the length field. */
  length: number;
  /** Checksum as received (0 = not computed). */
  checksum: number;
  /** `length - 8` payload bytes (view into the parsed buffer). */
  payload: Uint8Array;
}

/** Input for {@link serializeUdp}: ports plus the payload to carry. */
export interface UdpSegment {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkPort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be 0..65535: ${value}`);
  }
}

/**
 * Parse one UDP datagram.
 *
 * `truncated` below 8 bytes or when the length field exceeds the available
 * bytes; `invalid` for a length below 8 or a bad checksum (only verified
 * when `opts` carries both addresses and the checksum is nonzero).
 * Trailing bytes after `length` (Ethernet padding) are ignored.
 */
export function parseUdp(
  data: Uint8Array,
  opts: { src?: Ipv4Address; dst?: Ipv4Address } = {},
): ParseResult<UdpDatagram> {
  if (data.length < UDP_HEADER_LENGTH) {
    return parseErr(
      "truncated",
      `udp needs at least ${UDP_HEADER_LENGTH} bytes, got ${data.length}`,
    );
  }
  try {
    const reader = new BufferReader(data);
    const srcPort = reader.u16be();
    const dstPort = reader.u16be();
    const length = reader.u16be();
    const checksum = reader.u16be();
    if (length < UDP_HEADER_LENGTH) {
      return parseErr(
        "invalid",
        `udp length must be >= ${UDP_HEADER_LENGTH}, got ${length}`,
      );
    }
    if (data.length < length) {
      return parseErr(
        "truncated",
        `udp datagram needs ${length} bytes, got ${data.length}`,
      );
    }
    if (
      checksum !== 0 &&
      opts.src !== undefined &&
      opts.dst !== undefined &&
      transportChecksum(
        opts.src,
        opts.dst,
        IPV4_PROTOCOL_UDP,
        data.slice(0, length),
      ) !== 0
    ) {
      return parseErr("invalid", "udp bad checksum");
    }
    return parseOk({
      srcPort,
      dstPort,
      length,
      checksum,
      payload: data.slice(UDP_HEADER_LENGTH, length),
    });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `truncated udp datagram: ${err.message}`);
    }
    return parseErr("invalid", `invalid udp datagram: ${errorMessage(err)}`);
  }
}

/**
 * Serialize one UDP datagram for `src -> dst`.
 *
 * Length and checksum are derived from the payload; a computed checksum of
 * zero is sent as `0xFFFF` per RFC 768. Throws `RangeError` on out-of-range
 * ports or an oversized datagram.
 */
export function serializeUdp(
  segment: UdpSegment,
  src: Ipv4Address,
  dst: Ipv4Address,
): Uint8Array {
  checkPort("srcPort", segment.srcPort);
  checkPort("dstPort", segment.dstPort);
  const length = UDP_HEADER_LENGTH + segment.payload.length;
  if (length > 0xffff) {
    throw new RangeError(`udp datagram too long: ${length} bytes`);
  }
  const writer = new BufferWriter(length);
  writer.u16be(segment.srcPort);
  writer.u16be(segment.dstPort);
  writer.u16be(length);
  writer.u16be(0);
  writer.bytes(segment.payload);
  const bytes = writer.toBytes();
  let checksum = transportChecksum(src, dst, IPV4_PROTOCOL_UDP, bytes);
  if (checksum === 0) {
    checksum = 0xffff;
  }
  bytes[6] = (checksum >> 8) & 0xff;
  bytes[7] = checksum & 0xff;
  return bytes;
}
