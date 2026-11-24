import { describe, expect, test } from "bun:test";
import { BufferReader, BufferWriter, TruncatedError } from "../src/buffer";

describe("BufferReader", () => {
  test("reads u8/u16be/u32be big-endian in sequence", () => {
    const r = new BufferReader(
      new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    );
    expect(r.u8()).toBe(0x01);
    expect(r.u16be()).toBe(0x0203);
    expect(r.u32be()).toBe(0x04050607);
    expect(r.remaining).toBe(0);
  });

  test("reads boundary values", () => {
    const r = new BufferReader(
      new Uint8Array([0x00, 0xff, 0xff, 0x00, 0xff, 0xff, 0xff, 0xff]),
    );
    expect(r.u8()).toBe(0);
    expect(r.u8()).toBe(255);
    expect(r.u16be()).toBe(0xff00);
    expect(r.u32be()).toBe(0xffffffff);
  });

  test("tracks position and remaining", () => {
    const r = new BufferReader(new Uint8Array([0xaa, 0xbb, 0xcc]));
    expect(r.position).toBe(0);
    expect(r.remaining).toBe(3);
    r.u8();
    expect(r.position).toBe(1);
    expect(r.remaining).toBe(2);
  });

  test("throws TruncatedError with detail on overread", () => {
    const r = new BufferReader(new Uint8Array([0x01]));
    expect(() => r.u16be()).toThrow(TruncatedError);
    try {
      r.u16be();
    } catch (err) {
      expect(err).toBeInstanceOf(TruncatedError);
      const e = err as TruncatedError;
      expect(e.position).toBe(0);
      expect(e.needed).toBe(2);
      expect(e.available).toBe(1);
      expect(e.message).toMatch(/position 0/);
    }
    expect(() => new BufferReader(new Uint8Array([])).u8()).toThrow(
      /truncated buffer/,
    );
  });

  test("bytes() returns a view without copying", () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const r = new BufferReader(data);
    const view = r.bytes(2);
    expect(view).toEqual(new Uint8Array([0x01, 0x02]));
    expect(r.position).toBe(2);
    // View aliases the original buffer: no copy happened.
    view[0] = 0x99;
    expect(data[0]).toBe(0x99);
  });

  test("bytes() rejects negative or overlong requests", () => {
    const r = new BufferReader(new Uint8Array([0x01, 0x02, 0x03]));
    expect(() => r.bytes(5)).toThrow(TruncatedError);
    expect(() => r.bytes(-1)).toThrow(RangeError);
  });

  test("skip() and seek() move the cursor with bounds checks", () => {
    const r = new BufferReader(new Uint8Array([0xaa, 0xbb, 0xcc]));
    r.skip(2);
    expect(r.u8()).toBe(0xcc);
    r.seek(0);
    expect(r.u8()).toBe(0xaa);
    expect(() => r.skip(5)).toThrow(TruncatedError);
    expect(() => r.seek(-1)).toThrow(RangeError);
    expect(() => r.seek(4)).toThrow(RangeError);
  });
});

describe("BufferWriter", () => {
  test("writes and round-trips through a reader", () => {
    const w = new BufferWriter();
    w.u8(0x01);
    w.u16be(0x0203);
    w.u32be(0x04050607);
    const bytes = w.toBytes();
    expect(bytes).toEqual(
      new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    );
    const r = new BufferReader(bytes);
    expect(r.u8()).toBe(0x01);
    expect(r.u16be()).toBe(0x0203);
    expect(r.u32be()).toBe(0x04050607);
  });

  test("grows beyond initial capacity", () => {
    const w = new BufferWriter(2);
    for (let i = 0; i < 100; i++) {
      w.u8(i & 0xff);
    }
    expect(w.length).toBe(100);
    const out = w.toBytes();
    expect(out.length).toBe(100);
    expect(out[99]).toBe(99);
  });

  test("toBytes() returns an exact-length copy", () => {
    const w = new BufferWriter();
    w.bytes(new Uint8Array([0x01, 0x02]));
    const out = w.toBytes();
    expect(out.length).toBe(2);
    out[0] = 0xff;
    // Mutating the snapshot must not affect the writer.
    expect(w.toBytes()[0]).toBe(0x01);
  });

  test("validates value ranges", () => {
    const w = new BufferWriter();
    expect(() => w.u8(256)).toThrow(RangeError);
    expect(() => w.u8(-1)).toThrow(RangeError);
    expect(() => w.u8(1.5)).toThrow(RangeError);
    expect(() => w.u16be(0x10000)).toThrow(RangeError);
    expect(() => w.u32be(0x100000000)).toThrow(RangeError);
    expect(() => w.u32be(-1)).toThrow(RangeError);
  });

  test("accepts max u32 without sign issues", () => {
    const w = new BufferWriter();
    w.u32be(0xffffffff);
    expect(w.toBytes()).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  });
});
