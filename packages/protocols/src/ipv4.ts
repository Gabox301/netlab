/**
 * IPv4 header codec (RFC 791, F-30/F-31).
 *
 * Wire layout (all big-endian): `version/ihl(1) tos(1) totalLen(2) id(2)
 * flags/offset(2) ttl(1) protocol(1) checksum(2) src(4) dst(4) options(ihl*4-20)`.
 * Like {@link parseEthernet}, the parser never throws: short buffers are
 * `truncated`, and version, IHL, length, checksum or TTL problems are typed
 * `invalid` errors carrying the reason. Serializers may throw `RangeError`
 * on out-of-range fields, following `BufferWriter`.
 *
 * Notes:
 * - `totalLength` delimits the packet: bytes past it (Ethernet zero padding)
 *   are ignored and returned as nothing — `payload` is exactly
 *   `data[headerLen..totalLength]`.
 * - `serializeIpv4` derives IHL, total length and the checksum from the
 *   options and payload it is given, ignoring the `ihl`, `totalLength` and
 *   `checksum` fields of the input header.
 * - Options are preserved opaquely (`options` holds `ihl*4-20` raw bytes);
 *   `serializeIpv4` requires their length to be a multiple of 4.
 */

import {
  BufferReader,
  BufferWriter,
  Ipv4Address,
  internetChecksum,
  TruncatedError,
} from "@netlab/bytes";
import { type ParseResult, parseErr, parseOk } from "./ethernet";

/** IP version this stack speaks. */
export const IPV4_VERSION = 4;

/** Header bytes without options. */
export const IPV4_MIN_HEADER_LENGTH = 20;

/** IP protocol number for ICMP (RFC 790). */
export const IPV4_PROTOCOL_ICMP = 1;

/** IP protocol number for TCP (RFC 790). */
export const IPV4_PROTOCOL_TCP = 6;

/** IP protocol number for UDP (RFC 790). */
export const IPV4_PROTOCOL_UDP = 17;

/** Fragmentation flags of an IPv4 header. */
export interface Ipv4Flags {
  /** Reserved bit (must be zero on the wire; preserved, not enforced). */
  reserved: boolean;
  /** Don't fragment. */
  dontFragment: boolean;
  /** More fragments follow. */
  moreFragments: boolean;
}

/** A decoded IPv4 header. */
export interface Ipv4Header {
  version: number;
  /** Header length in 32-bit words (>= 5). */
  ihl: number;
  /** Differentiated services code point (top 6 bits of TOS). */
  dscp: number;
  /** Explicit congestion notification (low 2 bits of TOS). */
  ecn: number;
  /** Whole datagram length in bytes, header included. */
  totalLength: number;
  identification: number;
  flags: Ipv4Flags;
  /** Fragment offset in 8-byte units. */
  fragmentOffset: number;
  ttl: number;
  protocol: number;
  /** Checksum value as stored on the wire. */
  checksum: number;
  src: Ipv4Address;
  dst: Ipv4Address;
  /** Raw option bytes (`ihl*4-20`), meaning ignored. */
  options: Uint8Array;
}

/** A decoded IPv4 datagram: header plus its payload. */
export interface Ipv4Packet {
  header: Ipv4Header;
  payload: Uint8Array;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be a byte 0..255: ${value}`);
  }
}

function checkU16(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be 0..65535: ${value}`);
  }
}

/**
 * Parse an IPv4 datagram.
 *
 * `truncated` below 20 bytes or when `totalLength` exceeds the available
 * bytes; `invalid` for a non-IPv4 version, IHL below 5, a total length
 * shorter than the header, a bad header checksum or a zero TTL. The parser
 * never throws.
 */
export function parseIpv4(data: Uint8Array): ParseResult<Ipv4Packet> {
  if (data.length < IPV4_MIN_HEADER_LENGTH) {
    return parseErr(
      "truncated",
      `ipv4 needs at least ${IPV4_MIN_HEADER_LENGTH} bytes, got ${data.length}`,
    );
  }
  try {
    const reader = new BufferReader(data);
    const versionIhl = reader.u8();
    const version = versionIhl >> 4;
    if (version !== IPV4_VERSION) {
      return parseErr("invalid", `ipv4 version must be 4, got ${version}`);
    }
    const ihl = versionIhl & 0x0f;
    if (ihl < 5) {
      return parseErr("invalid", `ipv4 ihl must be >= 5, got ${ihl}`);
    }
    const headerLen = ihl * 4;
    if (data.length < headerLen) {
      return parseErr(
        "truncated",
        `ipv4 header needs ${headerLen} bytes (ihl ${ihl}), got ${data.length}`,
      );
    }
    const tos = reader.u8();
    const totalLength = reader.u16be();
    if (totalLength < headerLen) {
      return parseErr(
        "invalid",
        `ipv4 total length ${totalLength} is shorter than its header ${headerLen}`,
      );
    }
    if (data.length < totalLength) {
      return parseErr(
        "truncated",
        `ipv4 datagram needs ${totalLength} bytes, got ${data.length}`,
      );
    }
    const identification = reader.u16be();
    const flagsOffset = reader.u16be();
    const ttl = reader.u8();
    const protocol = reader.u8();
    const checksum = reader.u16be();
    const srcBytes = reader.bytes(4);
    const dstBytes = reader.bytes(4);
    const options =
      headerLen > IPV4_MIN_HEADER_LENGTH
        ? reader.bytes(headerLen - IPV4_MIN_HEADER_LENGTH).slice()
        : new Uint8Array([]);
    if (internetChecksum(data.slice(0, headerLen)) !== 0) {
      return parseErr("invalid", "ipv4 bad header checksum");
    }
    if (ttl === 0) {
      return parseErr("invalid", "ipv4 ttl expired (0)");
    }
    const header: Ipv4Header = {
      version,
      ihl,
      dscp: tos >> 2,
      ecn: tos & 0x03,
      totalLength,
      identification,
      flags: {
        reserved: (flagsOffset & 0x8000) !== 0,
        dontFragment: (flagsOffset & 0x4000) !== 0,
        moreFragments: (flagsOffset & 0x2000) !== 0,
      },
      fragmentOffset: flagsOffset & 0x1fff,
      ttl,
      protocol,
      checksum,
      src: Ipv4Address.fromBytes(srcBytes),
      dst: Ipv4Address.fromBytes(dstBytes),
      options,
    };
    return parseOk({
      header,
      payload: data.slice(headerLen, totalLength),
    });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `ipv4 truncated: ${errorMessage(err)}`);
    }
    return parseErr("invalid", `ipv4 invalid: ${errorMessage(err)}`);
  }
}

/**
 * Serialize an IPv4 datagram.
 *
 * IHL, total length and the checksum are derived from `options` and
 * `payload`; the matching input fields are ignored. `options` must be a
 * multiple of 4 bytes. Throws `RangeError` on out-of-range fields.
 */
export function serializeIpv4(
  header: Ipv4Header,
  payload: Uint8Array,
): Uint8Array {
  if (header.version !== IPV4_VERSION) {
    throw new RangeError(`ipv4 version must be 4, got ${header.version}`);
  }
  if (header.options.length % 4 !== 0) {
    throw new RangeError(
      `ipv4 options must be a multiple of 4 bytes, got ${header.options.length}`,
    );
  }
  if (!Number.isInteger(header.dscp) || header.dscp < 0 || header.dscp > 63) {
    throw new RangeError(`ipv4 dscp must be 0..63: ${header.dscp}`);
  }
  if (!Number.isInteger(header.ecn) || header.ecn < 0 || header.ecn > 3) {
    throw new RangeError(`ipv4 ecn must be 0..3: ${header.ecn}`);
  }
  checkU16("identification", header.identification);
  checkByte("ttl", header.ttl);
  checkByte("protocol", header.protocol);
  if (
    !Number.isInteger(header.fragmentOffset) ||
    header.fragmentOffset < 0 ||
    header.fragmentOffset > 0x1fff
  ) {
    throw new RangeError(
      `ipv4 fragment offset must be 0..8191: ${header.fragmentOffset}`,
    );
  }
  const ihl = 5 + header.options.length / 4;
  if (ihl > 15) {
    throw new RangeError(`ipv4 header too long: ihl ${ihl}`);
  }
  const totalLength = ihl * 4 + payload.length;
  if (totalLength > 0xffff) {
    throw new RangeError(`ipv4 datagram too long: ${totalLength}`);
  }
  const writer = new BufferWriter();
  writer.u8((IPV4_VERSION << 4) | ihl);
  writer.u8((header.dscp << 2) | header.ecn);
  writer.u16be(totalLength);
  writer.u16be(header.identification);
  writer.u16be(
    (header.flags.reserved ? 0x8000 : 0) |
      (header.flags.dontFragment ? 0x4000 : 0) |
      (header.flags.moreFragments ? 0x2000 : 0) |
      header.fragmentOffset,
  );
  writer.u8(header.ttl);
  writer.u8(header.protocol);
  writer.u16be(0);
  writer.bytes(header.src.toBytes());
  writer.bytes(header.dst.toBytes());
  writer.bytes(header.options);
  const head = writer.toBytes();
  const checksum = internetChecksum(head);
  head[10] = checksum >> 8;
  head[11] = checksum & 0xff;
  const out = new Uint8Array(head.length + payload.length);
  out.set(head);
  out.set(payload, head.length);
  return out;
}
