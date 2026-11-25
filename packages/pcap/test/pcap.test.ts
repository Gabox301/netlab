/**
 * Classic libpcap writer and reader (magic 0xa1b2c3d4, little-endian,
 * LINKTYPE_ETHERNET).
 *
 * The writer's 24-byte global header and 16-byte record headers are pinned
 * byte by byte: a capture that Wireshark cannot open is a bug in these
 * offsets, not in the scenario. The parser is the half the CLI and (F-123)
 * the inspector share, so it is fed every truncation of a valid file and
 * seeded garbage: it never throws, it returns a typed error carrying the
 * byte offset where decoding stopped.
 */

import { describe, expect, test } from "bun:test";
import {
  PCAP_GLOBAL_HEADER_LENGTH,
  PCAP_LINKTYPE_ETHERNET,
  PCAP_RECORD_HEADER_LENGTH,
  PCAP_SNAPLEN,
  type PcapFile,
  type PcapParseResult,
  parsePcap,
  writePcap,
} from "../src";

/** The exact 24 bytes a reader has to see for a little-endian v2.4 file. */
const GLOBAL_HEADER_BYTES = [
  0xd4,
  0xc3,
  0xb2,
  0xa1, // magic 0xa1b2c3d4, written little-endian
  0x02,
  0x00, // version major 2
  0x04,
  0x00, // version minor 4
  0x00,
  0x00,
  0x00,
  0x00, // thiszone 0 (UTC)
  0x00,
  0x00,
  0x00,
  0x00, // sigfigs 0
  0x00,
  0x00,
  0x04,
  0x00, // snaplen 262144
  0x01,
  0x00,
  0x00,
  0x00, // network 1 = LINKTYPE_ETHERNET
];

function payload(...values: Array<number>): Uint8Array {
  return Uint8Array.from(values);
}

/** The parsed file or a loud failure: tests should not branch on errors. */
function parsed(result: PcapParseResult): PcapFile {
  if (!result.ok) {
    throw new Error(
      `parse failed: ${result.error.code} at offset ${result.error.offset}`,
    );
  }
  return result.value;
}

describe("global header", () => {
  test("an empty capture is the 24-byte little-endian v2.4 header", () => {
    const out = writePcap([]);
    expect(Array.from(out)).toEqual(GLOBAL_HEADER_BYTES);
    expect(out.length).toBe(PCAP_GLOBAL_HEADER_LENGTH);
  });

  test("parse reads the header fields the writer emitted", () => {
    const file = parsed(parsePcap(writePcap([])));
    expect(file.header.versionMajor).toBe(2);
    expect(file.header.versionMinor).toBe(4);
    expect(file.header.thisZone).toBe(0);
    expect(file.header.sigFigs).toBe(0);
    expect(file.header.snaplen).toBe(PCAP_SNAPLEN);
    expect(file.header.network).toBe(PCAP_LINKTYPE_ETHERNET);
    expect(file.frames).toEqual([]);
  });

  test("no frames means no record headers", () => {
    expect(writePcap([]).length).toBe(PCAP_GLOBAL_HEADER_LENGTH);
  });
});

describe("record header", () => {
  test("timestamps split into whole seconds and microseconds", () => {
    const frame = payload(0xaa, 0xbb, 0xcc, 0xdd);
    const out = writePcap([{ timeUs: 1_234_567, bytes: frame }]);
    expect(Array.from(out.slice(PCAP_GLOBAL_HEADER_LENGTH))).toEqual([
      0x01,
      0x00,
      0x00,
      0x00, // ts_sec = 1
      0x47,
      0x94,
      0x03,
      0x00, // ts_usec = 234567
      0x04,
      0x00,
      0x00,
      0x00, // incl_len = 4
      0x04,
      0x00,
      0x00,
      0x00, // orig_len = 4
      0xaa,
      0xbb,
      0xcc,
      0xdd,
    ]);
  });

  test("sub-second frames keep ts_sec 0", () => {
    const out = writePcap([{ timeUs: 999_999, bytes: payload(1) }]);
    const file = parsed(parsePcap(out));
    const [record] = file.frames;
    expect(record?.tsSec).toBe(0);
    expect(record?.tsUsec).toBe(999_999);
    expect(record?.timeUs).toBe(999_999);
  });

  test("whole-second frames keep ts_usec 0", () => {
    const out = writePcap([{ timeUs: 2_000_000, bytes: payload(1) }]);
    const [record] = parsed(parsePcap(out)).frames;
    expect(record?.tsSec).toBe(2);
    expect(record?.tsUsec).toBe(0);
    expect(record?.timeUs).toBe(2_000_000);
  });

  test("rejects a negative or fractional timeUs instead of wrapping", () => {
    expect(() => writePcap([{ timeUs: -1, bytes: payload(1) }])).toThrow();
    expect(() => writePcap([{ timeUs: 1.5, bytes: payload(1) }])).toThrow();
  });
});

describe("round-trip", () => {
  test("write then parse preserves order, timestamps and bytes", () => {
    const frames = [
      { timeUs: 0, bytes: payload(0x01, 0x02, 0x03) },
      { timeUs: 1, bytes: payload(0x04) },
      { timeUs: 1_000_000, bytes: payload(0x05, 0x06) },
      { timeUs: 4_294_967_295_000_000 - 1, bytes: payload(0x07) },
    ];
    const file = parsed(parsePcap(writePcap(frames)));
    expect(file.frames.length).toBe(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const expected = frames[i];
      const record = file.frames[i];
      expect(record?.timeUs).toBe(expected?.timeUs as number);
      expect(Array.from(record?.bytes as Uint8Array)).toEqual(
        Array.from(expected?.bytes as Uint8Array),
      );
      expect(record?.inclLen).toBe(expected?.bytes.length as number);
      expect(record?.origLen).toBe(expected?.bytes.length as number);
    }
  });

  test("keeps caller order untouched: the writer never sorts", () => {
    const frames = [
      { timeUs: 30, bytes: payload(30) },
      { timeUs: 10, bytes: payload(10) },
      { timeUs: 20, bytes: payload(20) },
    ];
    const file = parsed(parsePcap(writePcap(frames)));
    expect(file.frames.map((record) => record.timeUs)).toEqual([30, 10, 20]);
  });

  test("equal timestamps stay in insertion order", () => {
    const frames = [
      { timeUs: 7, bytes: payload(1) },
      { timeUs: 7, bytes: payload(2) },
      { timeUs: 7, bytes: payload(3) },
    ];
    const file = parsed(parsePcap(writePcap(frames)));
    expect(file.frames.map((record) => record.bytes[0])).toEqual([1, 2, 3]);
  });

  test("a record is exactly one header plus the captured bytes", () => {
    const out = writePcap([{ timeUs: 0, bytes: payload(1, 2, 3, 4, 5) }]);
    expect(out.length).toBe(
      PCAP_GLOBAL_HEADER_LENGTH + PCAP_RECORD_HEADER_LENGTH + 5,
    );
  });
});

describe("snaplen", () => {
  test("caps incl_len and keeps orig_len as the real frame size", () => {
    const big = new Uint8Array(PCAP_SNAPLEN + 4096);
    big.fill(0xab);
    const file = parsed(parsePcap(writePcap([{ timeUs: 5, bytes: big }])));
    const record = file.frames[0];
    expect(record?.inclLen).toBe(PCAP_SNAPLEN);
    expect(record?.origLen).toBe(PCAP_SNAPLEN + 4096);
    expect(record?.bytes.length).toBe(PCAP_SNAPLEN);
    expect(record?.bytes[0]).toBe(0xab);
    expect(record?.bytes[PCAP_SNAPLEN - 1]).toBe(0xab);
    expect(file.frames.length).toBe(1);
  });

  test("a frame at exactly snaplen is captured whole", () => {
    const exact = new Uint8Array(PCAP_SNAPLEN);
    exact.fill(0x5a);
    const [record] = parsed(
      parsePcap(writePcap([{ timeUs: 0, bytes: exact }])),
    ).frames;
    expect(record?.inclLen).toBe(PCAP_SNAPLEN);
    expect(record?.origLen).toBe(PCAP_SNAPLEN);
  });
});

describe("parse is total", () => {
  const valid = writePcap([
    { timeUs: 0, bytes: payload(1, 2, 3, 4, 5, 6) },
    { timeUs: 12, bytes: payload(7, 8) },
    { timeUs: 1_000_000, bytes: payload(9) },
  ]);

  test("every truncation of a valid capture returns a typed result, never throws", () => {
    // Cutting exactly between two records yields a valid shorter capture;
    // every other cut has to fail instead of half-parsing a record.
    const recordBoundaries = new Set([
      PCAP_GLOBAL_HEADER_LENGTH,
      PCAP_GLOBAL_HEADER_LENGTH + PCAP_RECORD_HEADER_LENGTH + 6,
      PCAP_GLOBAL_HEADER_LENGTH + 2 * PCAP_RECORD_HEADER_LENGTH + 6 + 2,
    ]);
    for (let cut = 0; cut < valid.length; cut++) {
      const prefix = valid.slice(0, cut);
      expect(() => parsePcap(prefix)).not.toThrow();
      const result = parsePcap(prefix);
      if (result.ok) {
        expect(recordBoundaries.has(cut)).toBe(true);
      } else {
        expect(result.error.offset).toBeGreaterThanOrEqual(0);
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    }
  });

  test("seeded garbage of every length returns a typed result, never throws", () => {
    for (let length = 0; length <= 64; length++) {
      const garbage = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        garbage[i] = (length * 31 + i * 17 + 7) & 0xff;
      }
      expect(() => parsePcap(garbage)).not.toThrow();
      const result = parsePcap(garbage);
      if (!result.ok) {
        expect(typeof result.error.code).toBe("string");
        expect(result.error.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("a short global header is truncated at offset 0", () => {
    const result = parsePcap(valid.slice(0, PCAP_GLOBAL_HEADER_LENGTH - 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("truncated");
      expect(result.error.offset).toBe(0);
    }
  });

  test("a short record header is truncated at the record start", () => {
    const result = parsePcap(
      valid.slice(0, PCAP_GLOBAL_HEADER_LENGTH + PCAP_RECORD_HEADER_LENGTH - 1),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("truncated");
      expect(result.error.offset).toBe(PCAP_GLOBAL_HEADER_LENGTH);
    }
  });

  test("a short frame body is truncated at the body start", () => {
    const result = parsePcap(valid.slice(0, valid.length - 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("truncated");
      expect(result.error.offset).toBe(
        PCAP_GLOBAL_HEADER_LENGTH + 3 * PCAP_RECORD_HEADER_LENGTH + 6 + 2,
      );
    }
  });

  test("a wrong magic is a typed error at offset 0", () => {
    const bad = writePcap([{ timeUs: 0, bytes: payload(1) }]);
    bad[0] = 0x00;
    const result = parsePcap(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-magic");
      expect(result.error.offset).toBe(0);
    }
  });

  test("the pcapng magic is reported as an unsupported capture, not a crash", () => {
    const ng = new Uint8Array(24);
    ng.set([0x0a, 0x0d, 0x0d, 0x0a], 0);
    const result = parsePcap(ng);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-magic");
      expect(result.error.message).toContain("pcapng");
      expect(result.error.offset).toBe(0);
    }
  });

  test("a big-endian file is named for what it is", () => {
    const be = new Uint8Array(24);
    be.set([0xa1, 0xb2, 0xc3, 0xd4], 0);
    const result = parsePcap(be);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-magic");
      expect(result.error.message).toContain("big-endian");
    }
  });

  test("a non-Ethernet link type is rejected at the network field", () => {
    const bad = writePcap([]);
    bad[20] = 0x65; // 101 = LINKTYPE_RAW
    const result = parsePcap(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported-linktype");
      expect(result.error.offset).toBe(20);
    }
  });

  test("incl_len > orig_len is an inconsistent record at its start", () => {
    const bad = writePcap([{ timeUs: 0, bytes: payload(1, 2, 3, 4) }]);
    bad[PCAP_GLOBAL_HEADER_LENGTH + 12] = 0x02; // orig_len = 2
    const result = parsePcap(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-record");
      expect(result.error.offset).toBe(PCAP_GLOBAL_HEADER_LENGTH);
    }
  });

  test("a microsecond field out of range is an inconsistent record", () => {
    const bad = writePcap([{ timeUs: 0, bytes: payload(1) }]);
    // ts_usec = 1_000_000 (0x0f4240), little-endian at record offset 4.
    bad[PCAP_GLOBAL_HEADER_LENGTH + 4] = 0x40;
    bad[PCAP_GLOBAL_HEADER_LENGTH + 5] = 0x42;
    bad[PCAP_GLOBAL_HEADER_LENGTH + 6] = 0x0f;
    const result = parsePcap(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-record");
      expect(result.error.offset).toBe(PCAP_GLOBAL_HEADER_LENGTH + 4);
    }
  });

  test("a record body past the end is truncated, not silently dropped", () => {
    const out = writePcap([{ timeUs: 0, bytes: payload(1, 2, 3, 4) }]);
    const result = parsePcap(out.slice(0, out.length - 2));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("truncated");
    }
  });

  test("a valid prefix ending mid-record fails instead of half-parsing", () => {
    const result = parsePcap(
      valid.slice(0, PCAP_GLOBAL_HEADER_LENGTH + PCAP_RECORD_HEADER_LENGTH + 3),
    );
    expect(result.ok).toBe(false);
  });
});
