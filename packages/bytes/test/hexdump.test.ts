import { describe, expect, test } from "bun:test";
import { hexdump } from "../src/hexdump";

describe("hexdump (Wireshark style)", () => {
  test("renders a full row exactly", () => {
    expect(hexdump(new Uint8Array([0x48, 0x69]), { bytesPerRow: 2 })).toBe(
      "0000  48 69  Hi",
    );
  });

  test("renders offsets across rows", () => {
    expect(
      hexdump(new Uint8Array([0x45, 0x00, 0x00, 0x73]), { bytesPerRow: 2 }),
    ).toBe("0000  45 00  E.\n0002  00 73  .s");
  });

  test("uppercases hex and dots non-printables", () => {
    expect(
      hexdump(new Uint8Array([0x00, 0x41, 0x7f, 0xff]), { bytesPerRow: 4 }),
    ).toBe("0000  00 41 7F FF  .A..");
  });

  test("keeps ascii aligned on a short final row", () => {
    const out = hexdump(new Uint8Array([0x48, 0x69]), { bytesPerRow: 16 });
    const full = hexdump(
      new Uint8Array([
        0x48, 0x69, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21, 0x21,
        0x21, 0x21, 0x21, 0x21,
      ]),
      { bytesPerRow: 16 },
    );
    // The ascii column starts at the same index in both rows.
    expect(out.indexOf("Hi")).toBe(full.indexOf("Hi!!!!!!!!!!!!!!"));
    expect(out).toBe(`0000  48 69${" ".repeat(42)}  Hi`);
  });

  test("handles empty input and offset base", () => {
    expect(hexdump(new Uint8Array([]))).toBe("");
    expect(
      hexdump(new Uint8Array([0xab]), { baseOffset: 0xab, bytesPerRow: 1 }),
    ).toBe("00ab  AB  .");
  });

  test("validates options", () => {
    expect(() => hexdump(new Uint8Array([0x00]), { bytesPerRow: 0 })).toThrow(
      RangeError,
    );
    expect(() => hexdump(new Uint8Array([0x00]), { baseOffset: -1 })).toThrow(
      RangeError,
    );
  });
});
