/**
 * Wireshark-style hexdump for the packet inspector.
 *
 * Offsets print lowercase hex (min width 4); bytes print uppercase.
 * Non-printable ASCII (outside 0x20-0x7e) renders as `.`. The ascii column
 * stays aligned on short final rows via padding. Empty input yields `""`
 * (no rows), and rows join with `\n` (no trailing newline).
 */

export interface HexdumpOptions {
  /** Bytes per row. Default 16. Must be a positive integer. */
  bytesPerRow?: number;
  /** Byte offset of the first row, e.g. a capture offset. Default 0. */
  baseOffset?: number;
}

function checkOptions(bytesPerRow: number, baseOffset: number): void {
  if (!Number.isInteger(bytesPerRow) || bytesPerRow <= 0) {
    throw new RangeError(
      `bytesPerRow must be a positive integer: ${bytesPerRow}`,
    );
  }
  if (!Number.isInteger(baseOffset) || baseOffset < 0) {
    throw new RangeError(
      `baseOffset must be a non-negative integer: ${baseOffset}`,
    );
  }
}

/** Render `data` as offset/hex/ascii rows. */
export function hexdump(data: Uint8Array, options?: HexdumpOptions): string {
  const bytesPerRow = options?.bytesPerRow ?? 16;
  const baseOffset = options?.baseOffset ?? 0;
  checkOptions(bytesPerRow, baseOffset);

  const hexWidth = bytesPerRow * 3 - 1;
  const rows: Array<string> = [];
  for (let row = 0; row * bytesPerRow < data.length; row++) {
    const offset = baseOffset + row * bytesPerRow;
    const chunk = data.subarray(row * bytesPerRow, (row + 1) * bytesPerRow);
    const hex = Array.from(chunk, (b) =>
      b.toString(16).toUpperCase().padStart(2, "0"),
    ).join(" ");
    const ascii = Array.from(chunk, (b) =>
      b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".",
    ).join("");
    const off = offset.toString(16).padStart(4, "0");
    rows.push(`${off}  ${hex.padEnd(hexWidth, " ")}  ${ascii}`);
  }
  return rows.join("\n");
}
