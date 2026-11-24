/**
 * ICMP codec (RFC 792, F-37/F-38/F-39).
 *
 * Every message starts with `type(1) code(1) checksum(2)`; the checksum
 * covers the whole message and verifies to zero. Echo (F-37) carries
 * `identifier(2) sequence(2)` plus opaque data; error messages (F-38/F-39)
 * carry 4 bytes of context (`unused`, whose low 16 bits are the next-hop
 * MTU for fragmentation-needed per RFC 1191) plus the start of the
 * offending datagram. Types beyond echo and the two error kinds are kept
 * whole in an `unknown` variant so the parser stays total as the stack
 * grows. Like the other codecs, the parser never throws.
 */

import {
  BufferReader,
  BufferWriter,
  internetChecksum,
  TruncatedError,
} from "@netlab/bytes";
import { type ParseResult, parseErr, parseOk } from "./ethernet";

/** ICMP type: echo reply (RFC 792). */
export const ICMP_TYPE_ECHO_REPLY = 0;

/** ICMP type: destination unreachable (RFC 792). */
export const ICMP_TYPE_DEST_UNREACHABLE = 3;

/** ICMP type: echo request (RFC 792). */
export const ICMP_TYPE_ECHO_REQUEST = 8;

/** ICMP type: time exceeded (RFC 792). */
export const ICMP_TYPE_TIME_EXCEEDED = 11;

/** Unreachable code: network unreachable. */
export const ICMP_CODE_NET_UNREACHABLE = 0;

/** Unreachable code: host unreachable. */
export const ICMP_CODE_HOST_UNREACHABLE = 1;

/** Unreachable code: protocol unreachable. */
export const ICMP_CODE_PROTOCOL_UNREACHABLE = 2;

/** Unreachable code: port unreachable. */
export const ICMP_CODE_PORT_UNREACHABLE = 3;

/** Unreachable code: fragmentation needed and DF set (MTU in `unused`). */
export const ICMP_CODE_FRAG_NEEDED = 4;

/** Time exceeded code: TTL expired in transit. */
export const ICMP_CODE_TTL_EXCEEDED = 0;

/** Time exceeded code: fragment reassembly time exceeded. */
export const ICMP_CODE_FRAG_REASSEMBLY = 1;

/** Bytes of an ICMP header before any type-specific body. */
export const ICMP_HEADER_LENGTH = 4;

/** A decoded ICMP message. */
export type IcmpMessage =
  | {
      kind: "echo";
      type: typeof ICMP_TYPE_ECHO_REQUEST | typeof ICMP_TYPE_ECHO_REPLY;
      code: number;
      identifier: number;
      sequence: number;
      data: Uint8Array;
    }
  | {
      kind: "error";
      type: typeof ICMP_TYPE_DEST_UNREACHABLE | typeof ICMP_TYPE_TIME_EXCEEDED;
      code: number;
      /** Context bytes: next-hop MTU (low 16 bits) for frag-needed. */
      unused: number;
      /** Start of the offending datagram (header + leading payload). */
      embedded: Uint8Array;
    }
  | {
      kind: "unknown";
      type: number;
      code: number;
      data: Uint8Array;
    };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse an ICMP message.
 *
 * `truncated` below 4 bytes (or below 8 for echo/error bodies); `invalid`
 * for a bad checksum. Unknown types are preserved, never rejected. The
 * parser never throws.
 */
export function parseIcmp(data: Uint8Array): ParseResult<IcmpMessage> {
  if (data.length < ICMP_HEADER_LENGTH) {
    return parseErr(
      "truncated",
      `icmp needs at least ${ICMP_HEADER_LENGTH} bytes, got ${data.length}`,
    );
  }
  try {
    const reader = new BufferReader(data);
    const type = reader.u8();
    const code = reader.u8();
    reader.u16be();
    const needsBody =
      type === ICMP_TYPE_ECHO_REQUEST ||
      type === ICMP_TYPE_ECHO_REPLY ||
      type === ICMP_TYPE_DEST_UNREACHABLE ||
      type === ICMP_TYPE_TIME_EXCEEDED;
    if (needsBody && data.length < 8) {
      return parseErr(
        "truncated",
        `icmp type ${type} needs at least 8 bytes, got ${data.length}`,
      );
    }
    if (internetChecksum(data) !== 0) {
      return parseErr("invalid", "icmp bad checksum");
    }
    if (type === ICMP_TYPE_ECHO_REQUEST || type === ICMP_TYPE_ECHO_REPLY) {
      const identifier = reader.u16be();
      const sequence = reader.u16be();
      return parseOk({
        kind: "echo",
        type,
        code,
        identifier,
        sequence,
        data: data.slice(8),
      });
    }
    if (
      type === ICMP_TYPE_DEST_UNREACHABLE ||
      type === ICMP_TYPE_TIME_EXCEEDED
    ) {
      const unused = reader.u32be();
      return parseOk({
        kind: "error",
        type,
        code,
        unused,
        embedded: data.slice(8),
      });
    }
    return parseOk({ kind: "unknown", type, code, data: data.slice(4) });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `icmp truncated: ${errorMessage(err)}`);
    }
    return parseErr("invalid", `icmp invalid: ${errorMessage(err)}`);
  }
}

/**
 * Serialize an ICMP message, computing the checksum.
 * Throws `RangeError` on out-of-range type/code/identifier/sequence.
 */
export function serializeIcmp(message: IcmpMessage): Uint8Array {
  const checkByte = (name: string, value: number): void => {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`${name} must be a byte 0..255: ${value}`);
    }
  };
  const writer = new BufferWriter();
  if (message.kind === "echo") {
    checkByte("type", message.type);
    checkByte("code", message.code);
    if (
      !Number.isInteger(message.identifier) ||
      message.identifier < 0 ||
      message.identifier > 0xffff
    ) {
      throw new RangeError(
        `identifier must be 0..65535: ${message.identifier}`,
      );
    }
    if (
      !Number.isInteger(message.sequence) ||
      message.sequence < 0 ||
      message.sequence > 0xffff
    ) {
      throw new RangeError(`sequence must be 0..65535: ${message.sequence}`);
    }
    writer.u8(message.type);
    writer.u8(message.code);
    writer.u16be(0);
    writer.u16be(message.identifier);
    writer.u16be(message.sequence);
    writer.bytes(message.data);
  } else if (message.kind === "error") {
    checkByte("type", message.type);
    checkByte("code", message.code);
    if (
      !Number.isInteger(message.unused) ||
      message.unused < 0 ||
      message.unused > 0xffffffff
    ) {
      throw new RangeError(`unused must be a u32: ${message.unused}`);
    }
    writer.u8(message.type);
    writer.u8(message.code);
    writer.u16be(0);
    writer.u32be(message.unused);
    writer.bytes(message.embedded);
  } else {
    checkByte("type", message.type);
    checkByte("code", message.code);
    writer.u8(message.type);
    writer.u8(message.code);
    writer.u16be(0);
    writer.bytes(message.data);
  }
  const out = writer.toBytes();
  const checksum = internetChecksum(out);
  out[2] = checksum >> 8;
  out[3] = checksum & 0xff;
  return out;
}
