/**
 * Big-endian binary cursor helpers.
 *
 * `BufferReader` throws {@link TruncatedError} when a read goes past the
 * end of the buffer. Protocol parsers built on top of this module must catch
 * that error at their boundary and convert it into a typed parse `Result`
 * (never let raw exceptions cross the protocol layer). `bytes()` returns a
 * `subarray` view: no copy happens, so treat the result as read-only unless
 * aliasing is intended.
 */

/** A read past the end of the buffer. Carries positions for clear errors. */
export class TruncatedError extends Error {
  readonly position: number;
  readonly needed: number;
  readonly available: number;

  constructor(position: number, needed: number, available: number) {
    super(
      `truncated buffer: need ${needed} byte(s) at position ${position}, ` +
        `${available} available`,
    );
    this.name = "TruncatedError";
    this.position = position;
    this.needed = needed;
    this.available = available;
  }
}

function checkOffset(position: number, length: number, needed: number): void {
  if (needed < 0 || !Number.isInteger(needed)) {
    throw new RangeError(
      `byte count must be a non-negative integer: ${needed}`,
    );
  }
  if (position + needed > length) {
    throw new TruncatedError(position, needed, length - position);
  }
}

/** Big-endian read cursor over a fixed `Uint8Array`. */
export class BufferReader {
  private readonly data: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /** Total buffer length in bytes. */
  get length(): number {
    return this.data.length;
  }

  /** Current cursor position. */
  get position(): number {
    return this.pos;
  }

  /** Bytes left to read. */
  get remaining(): number {
    return this.data.length - this.pos;
  }

  /** Read one unsigned byte. */
  u8(): number {
    checkOffset(this.pos, this.data.length, 1);
    const value = this.data[this.pos];
    // checkOffset guarantees the index is in bounds.
    this.pos += 1;
    return value as number;
  }

  /** Read one big-endian unsigned 16-bit word. */
  u16be(): number {
    checkOffset(this.pos, this.data.length, 2);
    const data = this.data;
    const p = this.pos;
    const value = ((data[p] as number) << 8) | (data[p + 1] as number);
    this.pos += 2;
    return value;
  }

  /** Read one big-endian unsigned 32-bit word. */
  u32be(): number {
    checkOffset(this.pos, this.data.length, 4);
    const data = this.data;
    const p = this.pos;
    // >>> 0 keeps the result unsigned (avoids negative int32).
    const value =
      (((data[p] as number) << 24) |
        ((data[p + 1] as number) << 16) |
        ((data[p + 2] as number) << 8) |
        (data[p + 3] as number)) >>>
      0;
    this.pos += 4;
    return value;
  }

  /**
   * Consume `n` bytes and return them as a view (no copy).
   * The view aliases the original buffer.
   */
  bytes(n: number): Uint8Array {
    checkOffset(this.pos, this.data.length, n);
    const view = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return view;
  }

  /** Advance the cursor by `n` bytes. */
  skip(n: number): void {
    checkOffset(this.pos, this.data.length, n);
    this.pos += n;
  }

  /** Move the cursor to an absolute position. */
  seek(pos: number): void {
    if (!Number.isInteger(pos) || pos < 0 || pos > this.data.length) {
      throw new RangeError(`seek out of bounds: ${pos}`);
    }
    this.pos = pos;
  }
}

function checkValue(value: number, max: number, width: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${width} out of range: ${value}`);
  }
}

/** Growable big-endian writer. `toBytes()` returns an exact-length copy. */
export class BufferWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 64) {
    if (!Number.isInteger(initialCapacity) || initialCapacity < 0) {
      throw new RangeError(
        `initial capacity must be a non-negative integer: ${initialCapacity}`,
      );
    }
    this.buf = new Uint8Array(initialCapacity);
  }

  /** Bytes written so far. */
  get length(): number {
    return this.len;
  }

  private grow(needed: number): void {
    if (this.len + needed <= this.buf.length) {
      return;
    }
    let capacity = Math.max(this.buf.length * 2, 1);
    while (capacity < this.len + needed) {
      capacity *= 2;
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  /** Append one unsigned byte. */
  u8(value: number): void {
    checkValue(value, 0xff, "u8");
    this.grow(1);
    this.buf[this.len] = value;
    this.len += 1;
  }

  /** Append one big-endian unsigned 16-bit word. */
  u16be(value: number): void {
    checkValue(value, 0xffff, "u16be");
    this.grow(2);
    this.buf[this.len] = (value >> 8) & 0xff;
    this.buf[this.len + 1] = value & 0xff;
    this.len += 2;
  }

  /** Append one big-endian unsigned 32-bit word. */
  u32be(value: number): void {
    checkValue(value, 0xffffffff, "u32be");
    this.grow(4);
    this.buf[this.len] = (value >>> 24) & 0xff;
    this.buf[this.len + 1] = (value >>> 16) & 0xff;
    this.buf[this.len + 2] = (value >>> 8) & 0xff;
    this.buf[this.len + 3] = value & 0xff;
    this.len += 4;
  }

  /** Append raw bytes (copied into the writer). */
  bytes(data: Uint8Array): void {
    this.grow(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  /** Snapshot of everything written. The result is a copy. */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
