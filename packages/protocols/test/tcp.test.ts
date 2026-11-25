/**
 * TCP codec (F-53): header with flags, sequence numbers, window, MSS option
 * and pseudo-header checksum. Parsers are total; serializers throw
 * `RangeError` on out-of-range fields.
 */

import { describe, expect, test } from "bun:test";
import { Ipv4Address } from "@netlab/bytes";
import {
  parseTcp,
  serializeTcp,
  TCP_HEADER_LENGTH,
  type TcpFlags,
  type TcpSegment,
} from "../src/tcp";

const SRC = Ipv4Address.parse("10.0.0.2");
const DST = Ipv4Address.parse("10.0.0.3");

const NO_FLAGS: TcpFlags = {
  fin: false,
  syn: false,
  rst: false,
  psh: false,
  ack: false,
  urg: false,
};

function segment(overrides: Partial<TcpSegment> = {}): TcpSegment {
  return {
    srcPort: 40000,
    dstPort: 80,
    seq: 1000,
    ack: 2000,
    flags: { ...NO_FLAGS, syn: true, ack: true },
    window: 65535,
    urgent: 0,
    payload: new Uint8Array(0),
    ...overrides,
  };
}

function parsed(bytes: Uint8Array): TcpSegment {
  const result = parseTcp(bytes, { src: SRC, dst: DST });
  if (!result.ok) {
    throw new Error(`expected a valid segment, got ${result.error.code}`);
  }
  return result.value;
}

describe("tcp codec (F-53)", () => {
  test("round-trips ports, sequence numbers, flags and payload", () => {
    const bytes = serializeTcp(
      segment({
        flags: { ...NO_FLAGS, syn: true, ack: true, psh: true },
        payload: new Uint8Array([1, 2, 3, 4]),
      }),
      SRC,
      DST,
    );
    expect(bytes.length).toBe(TCP_HEADER_LENGTH + 4);

    const decoded = parsed(bytes);
    expect(decoded.srcPort).toBe(40000);
    expect(decoded.dstPort).toBe(80);
    expect(decoded.seq).toBe(1000);
    expect(decoded.ack).toBe(2000);
    expect(decoded.window).toBe(65535);
    expect(decoded.urgent).toBe(0);
    expect(decoded.flags).toEqual({
      fin: false,
      syn: true,
      rst: false,
      psh: true,
      ack: true,
      urg: false,
    });
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4]);
    expect(decoded.mss).toBeUndefined();
  });

  test("round-trips every flag including FIN/RST/URG", () => {
    const flags: TcpFlags = {
      fin: true,
      syn: false,
      rst: true,
      psh: false,
      ack: true,
      urg: true,
    };
    const decoded = parsed(
      serializeTcp(segment({ flags, urgent: 7 }), SRC, DST),
    );
    expect(decoded.flags).toEqual(flags);
    expect(decoded.urgent).toBe(7);
  });

  test("carries the MSS option and grows the header by one word", () => {
    const withMss = serializeTcp(segment({ mss: 1460 }), SRC, DST);
    expect(withMss.length).toBe(TCP_HEADER_LENGTH + 4);
    // dataOffset is the high nibble of byte 12, in 32-bit words.
    expect((withMss[12] as number) >> 4).toBe(6);

    const decoded = parsed(withMss);
    expect(decoded.mss).toBe(1460);
    // The 8 bytes after the fixed header are options, not payload.
    expect(decoded.payload.length).toBe(0);
  });

  test("keeps the payload after an MSS option", () => {
    const decoded = parsed(
      serializeTcp(
        segment({ mss: 536, payload: new Uint8Array([0xaa, 0xbb]) }),
        SRC,
        DST,
      ),
    );
    expect(decoded.mss).toBe(536);
    expect(Array.from(decoded.payload)).toEqual([0xaa, 0xbb]);
  });

  test("ignores option padding but still finds the MSS", () => {
    // Hand-built header: 7 words (28 bytes) = MSS option + NOP + EOL padding
    // so the option block is not exactly one MSS.
    const base = serializeTcp(
      segment({ mss: 900, payload: new Uint8Array([1]) }),
      SRC,
      DST,
    );
    const options = [2, 4, 0x03, 0x84, 1, 0, 0, 0];
    const bytes = new Uint8Array(base.length + 4);
    bytes.set(base.subarray(0, TCP_HEADER_LENGTH), 0);
    bytes[12] = 7 << 4;
    bytes.set(options, TCP_HEADER_LENGTH);
    bytes.set(base.subarray(TCP_HEADER_LENGTH), TCP_HEADER_LENGTH + 4);

    const decoded = parseTcp(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.mss).toBe(900);
    expect(Array.from(decoded.value.payload)).toEqual([1]);
    // The checksum was computed for the old header, so verification refuses it.
    expect(parseTcp(bytes, { src: SRC, dst: DST }).ok).toBe(false);
  });

  test("verifies the checksum only when both addresses are known", () => {
    const bytes = serializeTcp(
      { ...segment(), payload: new Uint8Array([9, 9]) },
      SRC,
      DST,
    );
    expect(parseTcp(bytes, { src: SRC, dst: DST }).ok).toBe(true);
    // No addresses: nothing to verify against, so the bytes parse.
    expect(parseTcp(bytes).ok).toBe(true);

    bytes[16] = (bytes[16] as number) ^ 0xff;
    const corrupt = parseTcp(bytes, { src: SRC, dst: DST });
    expect(corrupt.ok).toBe(false);
    if (corrupt.ok) {
      return;
    }
    expect(corrupt.error.code).toBe("invalid");
    expect(corrupt.error.message).toMatch(/checksum/i);
  });

  test("treats a zero checksum as not computed", () => {
    const bytes = serializeTcp(segment(), SRC, DST);
    bytes[16] = 0;
    bytes[17] = 0;
    expect(parsed(bytes).srcPort).toBe(40000);
  });

  test("reports short buffers as truncated without throwing", () => {
    const result = parseTcp(new Uint8Array(TCP_HEADER_LENGTH - 1));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("truncated");
  });

  test("reports a data offset past the buffer as truncated", () => {
    const bytes = serializeTcp(segment(), SRC, DST);
    // dataOffset 15 means a 60-byte header; the buffer has only 20.
    bytes[12] = 15 << 4;
    const result = parseTcp(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("truncated");
  });

  test("rejects a data offset below five words", () => {
    const bytes = serializeTcp(segment(), SRC, DST);
    bytes[12] = 4 << 4;
    const result = parseTcp(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("invalid");
    expect(result.error.message).toMatch(/data offset|dataOffset/i);
  });

  test("never throws on arbitrary bytes", () => {
    let state = 0x12345678;
    for (let length = 0; length <= 64; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        bytes[i] = (state >>> 16) & 0xff;
      }
      const result = parseTcp(bytes, { src: SRC, dst: DST });
      expect(typeof result.ok).toBe("boolean");
    }
  });

  test("rejects out-of-range fields when serializing", () => {
    expect(() => serializeTcp(segment({ srcPort: 65536 }), SRC, DST)).toThrow(
      RangeError,
    );
    expect(() => serializeTcp(segment({ dstPort: -1 }), SRC, DST)).toThrow(
      RangeError,
    );
    expect(() => serializeTcp(segment({ seq: -1 }), SRC, DST)).toThrow(
      RangeError,
    );
    expect(() =>
      serializeTcp(segment({ ack: 0x1_0000_0000 }), SRC, DST),
    ).toThrow(RangeError);
    expect(() => serializeTcp(segment({ window: 65536 }), SRC, DST)).toThrow(
      RangeError,
    );
    expect(() => serializeTcp(segment({ urgent: 65536 }), SRC, DST)).toThrow(
      RangeError,
    );
  });
});
