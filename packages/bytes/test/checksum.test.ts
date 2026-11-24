import { describe, expect, test } from "bun:test";
import { Ipv4Address } from "../src/addresses";
import {
  ChecksumAccumulator,
  crc32,
  internetChecksum,
  ipv4PseudoHeader,
  transportChecksum,
} from "../src/checksum";

// RFC 791 §3.1 example header (checksum field zeroed): checksum is 0xb861.
const RFC791_HEADER_ZEROED = new Uint8Array([
  0x45, 0x00, 0x00, 0x73, 0x00, 0x00, 0x40, 0x00, 0x40, 0x11, 0x00, 0x00, 0xc0,
  0xa8, 0x00, 0x01, 0xc0, 0xa8, 0x00, 0xc7,
]);

const RFC791_HEADER_FULL = new Uint8Array([
  0x45, 0x00, 0x00, 0x73, 0x00, 0x00, 0x40, 0x00, 0x40, 0x11, 0xb8, 0x61, 0xc0,
  0xa8, 0x00, 0x01, 0xc0, 0xa8, 0x00, 0xc7,
]);

describe("internetChecksum (RFC 1071)", () => {
  test("matches the RFC 791 header example", () => {
    expect(internetChecksum(RFC791_HEADER_ZEROED)).toBe(0xb861);
  });

  test("a header carrying its checksum verifies to zero", () => {
    expect(internetChecksum(RFC791_HEADER_FULL)).toBe(0x0000);
  });

  test("handles edge cases", () => {
    expect(internetChecksum(new Uint8Array([]))).toBe(0xffff);
    expect(internetChecksum(new Uint8Array([0xff, 0xff]))).toBe(0x0000);
    expect(internetChecksum(new Uint8Array([0x00, 0x00]))).toBe(0xffff);
    // Odd length: last byte is padded as the high-order octet.
    expect(internetChecksum(new Uint8Array([0x01]))).toBe(0xfeff);
    expect(internetChecksum(new Uint8Array([0x01, 0x02, 0x03]))).toBe(
      internetChecksum(new Uint8Array([0x01, 0x02, 0x03, 0x00])),
    );
  });

  test("folds carries from the end-around sum", () => {
    // 0xffff + 0x0001 wraps with end-around carry to 0x0001 -> complement 0xfffe.
    expect(internetChecksum(new Uint8Array([0xff, 0xff, 0x00, 0x01]))).toBe(
      0xfffe,
    );
  });
});

describe("ChecksumAccumulator (incremental, RFC 1071)", () => {
  test("matches one-shot over odd chunk splits", () => {
    const splits: Array<Array<Uint8Array>> = [
      [RFC791_HEADER_ZEROED],
      [
        RFC791_HEADER_ZEROED.subarray(0, 7),
        RFC791_HEADER_ZEROED.subarray(7, 13),
        RFC791_HEADER_ZEROED.subarray(13),
      ],
      [RFC791_HEADER_ZEROED.subarray(0, 1), RFC791_HEADER_ZEROED.subarray(1)],
    ];
    for (const chunks of splits) {
      const acc = new ChecksumAccumulator();
      for (const c of chunks) {
        acc.add(c);
      }
      expect(acc.digest()).toBe(0xb861);
    }
  });

  test("digest() finalizes and resets for reuse", () => {
    const acc = new ChecksumAccumulator();
    acc.add(RFC791_HEADER_ZEROED);
    expect(acc.digest()).toBe(0xb861);
    // After digest the accumulator is reusable from zero.
    acc.add(new Uint8Array([0xff, 0xff]));
    expect(acc.digest()).toBe(0x0000);
  });

  test("single-byte-at-a-time matches one-shot", () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42]);
    const acc = new ChecksumAccumulator();
    for (const b of data) {
      acc.add(new Uint8Array([b]));
    }
    expect(acc.digest()).toBe(internetChecksum(data));
  });
});

describe("pseudo-header (TCP/UDP)", () => {
  test("lays out the 12-byte pseudo-header explicitly", () => {
    const src = Ipv4Address.parse("192.168.0.1");
    const dst = Ipv4Address.parse("192.168.0.199");
    const header = ipv4PseudoHeader(src, dst, 17, 12);
    expect(header).toEqual(
      new Uint8Array([192, 168, 0, 1, 192, 168, 0, 199, 0x00, 17, 0x00, 12]),
    );
  });

  test("embedded checksum verifies end-to-end", () => {
    // Simulate sender: checksum over pseudo-header + segment with zero field.
    const src = Ipv4Address.parse("10.0.0.10");
    const dst = Ipv4Address.parse("10.0.1.20");
    const segment = new Uint8Array([0x12, 0x34, 0x00, 0x00, 0xde, 0xad]);
    const cksum = transportChecksum(src, dst, 17, segment);
    // Embed big-endian at offset 2, then the receiver check must pass.
    const sent = segment.slice();
    sent[2] = (cksum >> 8) & 0xff;
    sent[3] = cksum & 0xff;
    expect(transportChecksum(src, dst, 17, sent)).toBe(0x0000);
  });
});

describe("crc32 (IEEE, FCS Ethernet)", () => {
  test("matches standard check values", () => {
    expect(crc32(new Uint8Array([]))).toBe(0x00000000);
    const ascii = new TextEncoder().encode("123456789");
    expect(crc32(ascii)).toBe(0xcbf43926);
    expect(crc32(new Uint8Array([0x00]))).toBe(0xd202ef8d);
  });

  test("detects single-bit changes", () => {
    const a = new TextEncoder().encode("netlab");
    const b = a.slice();
    const first = b[0];
    if (first === undefined) {
      throw new Error("unreachable: netlab is non-empty");
    }
    b[0] = first ^ 0x01;
    expect(crc32(b)).not.toBe(crc32(a));
  });
});
