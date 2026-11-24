/**
 * Internet checksum (RFC 1071), TCP/UDP pseudo-headers and CRC-32.
 *
 * `internetChecksum` returns the value to *store*: the ones-complement of the
 * 16-bit big-endian sum (odd trailing byte padded as the high-order octet).
 * A buffer that already carries its checksum therefore verifies to `0x0000`.
 * `ChecksumAccumulator` supports incremental computation across chunk
 * boundaries, including odd splits: it carries a pending byte internally.
 */

import type { Ipv4Address } from "./addresses";

/** Ones-complement 16-bit checksum over `data` (RFC 1071 §2). */
export function internetChecksum(data: Uint8Array): number {
  let sum = 0;
  const len = data.length;
  let i = 0;
  for (; i + 1 < len; i += 2) {
    sum += ((data[i] as number) << 8) | (data[i + 1] as number);
    // Fold periodically so `sum` stays within safe-integer range.
    if (sum > 0xffffff) {
      sum = (sum & 0xffff) + (sum >>> 16);
    }
  }
  if (i < len) {
    // Odd trailing byte: padded with a zero low-order octet.
    sum += (data[i] as number) << 8;
  }
  // End-around carry fold.
  while (sum >>> 16 !== 0) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum & 0xffff) >>> 0;
}

/**
 * Incremental RFC 1071 checksum. Chunk boundaries (even odd ones) do not
 * affect the result. `digest()` returns the checksum and resets the
 * accumulator for reuse.
 */
export class ChecksumAccumulator {
  private sum = 0;
  private pending: number | undefined = undefined;

  /** Feed the next chunk. */
  add(data: Uint8Array): void {
    let i = 0;
    if (this.pending !== undefined && data.length > 0) {
      this.sum += (this.pending << 8) | (data[0] as number);
      this.pending = undefined;
      i = 1;
    }
    for (; i + 1 < data.length; i += 2) {
      this.sum += ((data[i] as number) << 8) | (data[i + 1] as number);
      if (this.sum > 0xffffff) {
        this.sum = (this.sum & 0xffff) + (this.sum >>> 16);
      }
    }
    if (i < data.length) {
      this.pending = data[i] as number;
    }
  }

  /** Finalize, return the checksum, and reset. */
  digest(): number {
    let sum = this.sum;
    if (this.pending !== undefined) {
      sum += this.pending << 8;
      this.pending = undefined;
    }
    while (sum >>> 16 !== 0) {
      sum = (sum & 0xffff) + (sum >>> 16);
    }
    this.sum = 0;
    return (~sum & 0xffff) >>> 0;
  }
}

function checkProtocol(protocol: number): void {
  if (!Number.isInteger(protocol) || protocol < 0 || protocol > 255) {
    throw new RangeError(`protocol must be 0-255: ${protocol}`);
  }
}

function checkLength(length: number): void {
  if (!Number.isInteger(length) || length < 0 || length > 0xffff) {
    throw new RangeError(`segment length must fit u16: ${length}`);
  }
}

/**
 * The 12-byte IPv4 pseudo-header: src(4) dst(4) zero protocol(1) length(2).
 * Layout is asserted byte-for-byte in tests.
 */
export function ipv4PseudoHeader(
  src: Ipv4Address,
  dst: Ipv4Address,
  protocol: number,
  length: number,
): Uint8Array {
  checkProtocol(protocol);
  checkLength(length);
  const out = new Uint8Array(12);
  out.set(src.toBytes(), 0);
  out.set(dst.toBytes(), 4);
  out[8] = 0;
  out[9] = protocol;
  out[10] = (length >> 8) & 0xff;
  out[11] = length & 0xff;
  return out;
}

/**
 * Checksum over `pseudo-header || segment` (segment length must be the real
 * byte length passed for `pseudo-header` consistency; callers pass
 * `segment.length`). Works for TCP (`protocol` 6) and UDP (17).
 */
export function transportChecksum(
  src: Ipv4Address,
  dst: Ipv4Address,
  protocol: number,
  segment: Uint8Array,
): number {
  const acc = new ChecksumAccumulator();
  acc.add(ipv4PseudoHeader(src, dst, protocol, segment.length));
  acc.add(segment);
  return acc.digest();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** IEEE CRC-32 (Ethernet FCS). Returns an unsigned 32-bit word. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] as number;
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (~crc >>> 0) as number;
}
