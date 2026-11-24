import { describe, expect, test } from "bun:test";
import type { ParseError } from "../src/ethernet";
import {
  ICMP_CODE_FRAG_NEEDED,
  ICMP_CODE_PORT_UNREACHABLE,
  ICMP_CODE_TTL_EXCEEDED,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  type IcmpMessage,
  parseIcmp,
  serializeIcmp,
} from "../src/icmp";

function unwrap(
  result: { ok: true; value: IcmpMessage } | { ok: false; error: ParseError },
): IcmpMessage {
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function unwrapError(
  result: { ok: true; value: IcmpMessage } | { ok: false; error: ParseError },
): ParseError {
  if (result.ok) {
    throw new Error("expected error, got ok");
  }
  return result.error;
}

describe("parseIcmp", () => {
  test("parses an echo request (type 8)", () => {
    // Checksum of 08 00 00 00 00 00 00 00 is 0xf7ff.
    const msg = unwrap(
      parseIcmp(new Uint8Array([8, 0, 0xf7, 0xff, 0, 0, 0, 0])),
    );
    expect(msg).toEqual({
      kind: "echo",
      type: ICMP_TYPE_ECHO_REQUEST,
      code: 0,
      identifier: 0,
      sequence: 0,
      data: new Uint8Array([]),
    });
  });

  test("parses an echo request with odd-length data", () => {
    // "hello" after id 1 / seq 1: checksum 0xb42b.
    const wire = new Uint8Array([
      8, 0, 0xb4, 0x2b, 0, 1, 0, 1, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
    ]);
    const msg = unwrap(parseIcmp(wire));
    expect(msg).toEqual({
      kind: "echo",
      type: ICMP_TYPE_ECHO_REQUEST,
      code: 0,
      identifier: 1,
      sequence: 1,
      data: new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    });
  });

  test("parses destination unreachable (port)", () => {
    const wire = new Uint8Array([
      3, 3, 0x77, 0xde, 0, 0, 0, 0,
      // Embedded: start of the offending IPv4 header.
      0x45, 0x00, 0x00, 0x1c, 0x00, 0x01, 0x00, 0x00, 0x40, 0x01,
    ]);
    const msg = unwrap(parseIcmp(wire));
    expect(msg).toEqual({
      kind: "error",
      type: ICMP_TYPE_DEST_UNREACHABLE,
      code: ICMP_CODE_PORT_UNREACHABLE,
      unused: 0,
      embedded: new Uint8Array([
        0x45, 0x00, 0x00, 0x1c, 0x00, 0x01, 0x00, 0x00, 0x40, 0x01,
      ]),
    });
  });

  test("parses time exceeded (TTL)", () => {
    const wire = new Uint8Array([
      11, 0, 0xf4, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const msg = unwrap(parseIcmp(wire));
    expect(msg).toEqual({
      kind: "error",
      type: ICMP_TYPE_TIME_EXCEEDED,
      code: ICMP_CODE_TTL_EXCEEDED,
      unused: 0,
      embedded: new Uint8Array(8),
    });
  });

  test("keeps unknown types with their raw bytes", () => {
    // Type 42, code 0, data 09 09 09 09: checksum 0xc3ed.
    const wire = new Uint8Array([42, 0, 0xc3, 0xed, 9, 9, 9, 9]);
    const msg = unwrap(parseIcmp(wire));
    expect(msg).toEqual({
      kind: "unknown",
      type: 42,
      code: 0,
      data: new Uint8Array([9, 9, 9, 9]),
    });
  });

  test("rejects short buffers as truncated", () => {
    for (let len = 0; len < 4; len++) {
      expect(unwrapError(parseIcmp(new Uint8Array(len))).code).toBe(
        "truncated",
      );
    }
    // Echo needs identifier + sequence.
    const shortEcho = new Uint8Array([8, 0, 0, 0, 0, 0]);
    expect(unwrapError(parseIcmp(shortEcho)).code).toBe("truncated");
  });

  test("rejects a bad checksum", () => {
    const wire = new Uint8Array([8, 0, 0, 0, 0, 0, 0, 0]);
    const error = unwrapError(parseIcmp(wire));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/checksum/i);
  });

  test("never throws on malformed input", () => {
    for (let len = 0; len <= 16; len++) {
      const junk = new Uint8Array(len).fill(0xa5);
      const result = parseIcmp(junk);
      expect(typeof result.ok).toBe("boolean");
    }
  });
});

describe("serializeIcmp", () => {
  test("emits an echo reply with a valid checksum", () => {
    const wire = serializeIcmp({
      kind: "echo",
      type: ICMP_TYPE_ECHO_REPLY,
      code: 0,
      identifier: 1,
      sequence: 1,
      data: new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    });
    expect(wire).toEqual(
      new Uint8Array([
        0, 0, 0xbc, 0x2b, 0, 1, 0, 1, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
      ]),
    );
  });

  test("round-trips error messages", () => {
    const original: IcmpMessage = {
      kind: "error",
      type: ICMP_TYPE_DEST_UNREACHABLE,
      code: ICMP_CODE_FRAG_NEEDED,
      unused: 1500,
      embedded: new Uint8Array([0x45, 0x00, 0x00, 0x1c]),
    };
    expect(unwrap(parseIcmp(serializeIcmp(original)))).toEqual(original);
  });
});
