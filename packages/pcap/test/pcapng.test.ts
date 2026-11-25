/**
 * pcapng writer and reader (F-121, F-122).
 *
 * The writer's blocks are pinned byte by byte: a pcapng that Wireshark or
 * `tshark` cannot open is a bug in these offsets, not in the scenario. Every
 * block is a `type`, a `total length`, a body padded to 4 bytes and the same
 * `total length` again, and the section's byte order is declared by the
 * Section Header Block — so both layouts are exercised here.
 *
 * The parser is the half `netlab pcap-import` (F-123) and the web inspector
 * share, so it is total like every other NetLab codec: unknown blocks are
 * skipped by their length, truncated and inconsistent files return a typed
 * error carrying the byte offset, and nothing ever throws.
 */

import { describe, expect, test } from "bun:test";
import {
  PCAP_SNAPLEN,
  PCAPNG_BLOCK_HEADER_LENGTH,
  PCAPNG_BYTE_ORDER_MAGIC,
  PCAPNG_EPB_TYPE,
  PCAPNG_IDB_TYPE,
  PCAPNG_SHB_TYPE,
  PCAPNG_TSRESOL_MICROSECONDS,
  type PcapngFile,
  type PcapngParseResult,
  parsePcapng,
  writePcapng,
} from "../src";

function payload(...values: Array<number>): Uint8Array {
  return Uint8Array.from(values);
}

/** The parsed file or a loud failure: tests should not branch on errors. */
function parsed(result: PcapngParseResult): PcapngFile {
  if (!result.ok) {
    throw new Error(
      `parse failed: ${result.error.code} at offset ${result.error.offset}`,
    );
  }
  return result.value;
}

/** One little-endian block, body padded to a 4-byte boundary. */
function block(type: number, body: Array<number>): Uint8Array {
  const padded = body.slice();
  while (padded.length % 4 !== 0) {
    padded.push(0);
  }
  const total = PCAPNG_BLOCK_HEADER_LENGTH + padded.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, total, true);
  out.set(Uint8Array.from(padded), 8);
  view.setUint32(total - 4, total, true);
  return out;
}

/** Byte offset of the first block of `type`, or -1. */
function findBlock(data: Uint8Array, type: number): number {
  let offset = 0;
  while (offset + PCAPNG_BLOCK_HEADER_LENGTH <= data.length) {
    const blockType = new DataView(data.buffer).getUint32(offset, true);
    if (blockType === type) {
      return offset;
    }
    const total = new DataView(data.buffer).getUint32(offset + 4, true);
    if (total < PCAPNG_BLOCK_HEADER_LENGTH) {
      return -1;
    }
    offset += total;
  }
  return -1;
}

/** Offsets where a block starts/ends, i.e. where a cut is still valid. */
function blockBoundaries(data: Uint8Array): Array<number> {
  const boundaries = [0];
  let offset = 0;
  while (offset < data.length) {
    const total = new DataView(data.buffer).getUint32(offset + 4, true);
    offset += total;
    boundaries.push(offset);
  }
  return boundaries;
}

/** The exact 44 bytes an empty capture starts with. */
const SECTION_HEADER_BYTES = [
  0x0a,
  0x0d,
  0x0d,
  0x0a, // block type 0x0a0d0d0a (same in both byte orders)
  0x2c,
  0x00,
  0x00,
  0x00, // total length 44
  0x4d,
  0x3c,
  0x2b,
  0x1a, // byte-order magic 0x1a2b3c4d, little-endian
  0x01,
  0x00, // version major 1
  0x00,
  0x00, // version minor 0
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff, // section length -1 (unspecified)
  0x04,
  0x00,
  0x06,
  0x00, // shb_userappl, 6 bytes
  0x6e,
  0x65,
  0x74,
  0x6c,
  0x61,
  0x62, // "netlab"
  0x00,
  0x00, // padding to 4
  0x00,
  0x00,
  0x00,
  0x00, // opt_endofopt
  0x2c,
  0x00,
  0x00,
  0x00, // total length 44, repeated
];

/** The exact 40 bytes of the IDB written for a link named "l1". */
const IDB_L1_BYTES = [
  0x01,
  0x00,
  0x00,
  0x00, // block type 1 = IDB
  0x28,
  0x00,
  0x00,
  0x00, // total length 40
  0x01,
  0x00, // link type 1 = LINKTYPE_ETHERNET
  0x00,
  0x00, // reserved
  0x00,
  0x00,
  0x04,
  0x00, // snaplen 262144
  0x02,
  0x00,
  0x02,
  0x00, // if_name, 2 bytes
  0x6c,
  0x31,
  0x00,
  0x00, // "l1" + padding
  0x09,
  0x00,
  0x01,
  0x00, // if_tsresol, 1 byte
  0x06,
  0x00,
  0x00,
  0x00, // 10^-6 = microseconds
  0x00,
  0x00,
  0x00,
  0x00, // opt_endofopt
  0x28,
  0x00,
  0x00,
  0x00, // total length 40, repeated
];

describe("section header block", () => {
  test("an empty capture is just the 44-byte section header", () => {
    const out = writePcapng([], []);
    expect(Array.from(out)).toEqual(SECTION_HEADER_BYTES);
    expect(out.length).toBe(44);
  });

  test("parse reads the section fields the writer emitted", () => {
    const file = parsed(parsePcapng(writePcapng([], [])));
    expect(file.sections.length).toBe(1);
    expect(file.sections[0]?.byteOrder).toBe("little");
    expect(file.sections[0]?.versionMajor).toBe(1);
    expect(file.sections[0]?.versionMinor).toBe(0);
    expect(file.sections[0]?.sectionLength).toBe(-1);
    expect(file.sections[0]?.offset).toBe(0);
    expect(file.interfaces).toEqual([]);
    expect(file.packets).toEqual([]);
  });
});

describe("interface description block", () => {
  test("one link becomes one little-endian Ethernet IDB with name and tsresol", () => {
    const out = writePcapng([], [{ id: "eth0" }]);
    expect(Array.from(out.slice(SECTION_HEADER_BYTES.length))).toEqual([
      0x01,
      0x00,
      0x00,
      0x00, // block type 1 = IDB
      0x28,
      0x00,
      0x00,
      0x00, // total length 40
      0x01,
      0x00, // link type 1 = LINKTYPE_ETHERNET
      0x00,
      0x00, // reserved
      0x00,
      0x00,
      0x04,
      0x00, // snaplen 262144
      0x02,
      0x00,
      0x04,
      0x00, // if_name, 4 bytes
      0x65,
      0x74,
      0x68,
      0x30, // "eth0"
      0x09,
      0x00,
      0x01,
      0x00, // if_tsresol, 1 byte
      0x06,
      0x00,
      0x00,
      0x00, // 10^-6 = microseconds
      0x00,
      0x00,
      0x00,
      0x00, // opt_endofopt
      0x28,
      0x00,
      0x00,
      0x00, // total length 40, repeated
    ]);
  });

  test("the name falls back to the link id and is padded to 4 bytes", () => {
    const out = writePcapng([], [{ id: "l1" }]);
    expect(Array.from(out.slice(SECTION_HEADER_BYTES.length))).toEqual(
      IDB_L1_BYTES,
    );
    const file = parsed(parsePcapng(out));
    expect(file.interfaces[0]?.name).toBe("l1");
    expect(file.interfaces[0]?.tsResolution).toBe(1_000_000);
    expect(file.interfaces[0]?.snaplen).toBe(PCAP_SNAPLEN);
  });

  test("links define the interface ids in the order they are given", () => {
    const links = [{ id: "l1" }, { id: "l2", name: "h2" }, { id: "l3" }];
    const file = parsed(parsePcapng(writePcapng([], links)));
    expect(file.interfaces.map((iface) => iface.id)).toEqual([0, 1, 2]);
    expect(file.interfaces.map((iface) => iface.name)).toEqual([
      "l1",
      "h2",
      "l3",
    ]);
    expect(file.interfaces.map((iface) => iface.linkType)).toEqual([1, 1, 1]);
  });

  test("duplicate link ids are rejected instead of silently merged", () => {
    expect(() => writePcapng([], [{ id: "l1" }, { id: "l1" }])).toThrow(
      RangeError,
    );
  });
});

describe("enhanced packet block", () => {
  test("one frame is one little-endian EPB with its interface and timestamp", () => {
    const out = writePcapng(
      [
        {
          timeUs: 1_234_567,
          bytes: payload(0xaa, 0xbb, 0xcc, 0xdd),
          link: "l1",
        },
      ],
      [{ id: "l1" }],
    );
    const epb = out.slice(SECTION_HEADER_BYTES.length + IDB_L1_BYTES.length);
    expect(Array.from(epb)).toEqual([
      0x06,
      0x00,
      0x00,
      0x00, // block type 6 = EPB
      0x24,
      0x00,
      0x00,
      0x00, // total length 36
      0x00,
      0x00,
      0x00,
      0x00, // interface id 0
      0x00,
      0x00,
      0x00,
      0x00, // timestamp high 0
      0x87,
      0xd6,
      0x12,
      0x00, // timestamp low 1234567
      0x04,
      0x00,
      0x00,
      0x00, // captured length 4
      0x04,
      0x00,
      0x00,
      0x00, // original length 4
      0xaa,
      0xbb,
      0xcc,
      0xdd, // frame bytes
      0x24,
      0x00,
      0x00,
      0x00, // total length 36, repeated
    ]);
  });

  test("a frame is padded to 4 bytes but its lengths stay exact", () => {
    const out = writePcapng(
      [{ timeUs: 0, bytes: payload(1, 2, 3), link: "l1" }],
      [{ id: "l1" }],
    );
    const epb = out.slice(SECTION_HEADER_BYTES.length + IDB_L1_BYTES.length);
    expect(epb.length).toBe(36);
    expect(Array.from(epb.slice(28))).toEqual([
      0x01,
      0x02,
      0x03,
      0x00, // 3 bytes of frame + 1 padding byte
      0x24,
      0x00,
      0x00,
      0x00, // total length 36, repeated
    ]);
    const packet = parsed(parsePcapng(out)).packets[0];
    expect(packet?.caplen).toBe(3);
    expect(packet?.bytes.length).toBe(3);
  });

  test("frames carry the interface id of their link", () => {
    const frames = [
      { timeUs: 3, bytes: payload(3), link: "l2" },
      { timeUs: 1, bytes: payload(1), link: "l1" },
    ];
    const file = parsed(
      parsePcapng(writePcapng(frames, [{ id: "l1" }, { id: "l2" }])),
    );
    expect(file.packets.map((packet) => packet.interfaceId)).toEqual([1, 0]);
    expect(file.packets.map((packet) => packet.interfaceIndex)).toEqual([1, 0]);
    // The writer never sorts: the caller owns wire order.
    expect(file.packets.map((packet) => packet.timeUs)).toEqual([3, 1]);
  });

  test("timestamps wider than 32 bits split into high and low words", () => {
    const timeUs = 4_294_967_296 + 5;
    const out = writePcapng(
      [{ timeUs, bytes: payload(1), link: "l1" }],
      [{ id: "l1" }],
    );
    const packet = parsed(parsePcapng(out)).packets[0];
    expect(packet?.timestampHigh).toBe(1);
    expect(packet?.timestampLow).toBe(5);
    expect(packet?.timeUs).toBe(timeUs);
  });

  test("a frame longer than the snaplen keeps its wire length", () => {
    const big = new Uint8Array(PCAP_SNAPLEN + 64);
    big.fill(0x5a);
    const file = parsed(
      parsePcapng(
        writePcapng([{ timeUs: 1, bytes: big, link: "l1" }], [{ id: "l1" }]),
      ),
    );
    const packet = file.packets[0];
    expect(packet?.caplen).toBe(PCAP_SNAPLEN);
    expect(packet?.wirelen).toBe(PCAP_SNAPLEN + 64);
    expect(packet?.bytes.length).toBe(PCAP_SNAPLEN);
  });

  test("a frame on an undeclared link is rejected, not written orphaned", () => {
    expect(() =>
      writePcapng(
        [{ timeUs: 0, bytes: payload(1), link: "nope" }],
        [{ id: "l1" }],
      ),
    ).toThrow(RangeError);
  });

  test("rejects a negative or fractional timeUs instead of wrapping", () => {
    const links = [{ id: "l1" }];
    expect(() =>
      writePcapng([{ timeUs: -1, bytes: payload(1), link: "l1" }], links),
    ).toThrow(RangeError);
    expect(() =>
      writePcapng([{ timeUs: 1.5, bytes: payload(1), link: "l1" }], links),
    ).toThrow(RangeError);
  });
});

describe("round-trip", () => {
  test("write then parse preserves interfaces, order, timestamps and bytes", () => {
    const links = [
      { id: "l1", name: "h1:eth0-r1:p0" },
      { id: "l2", name: "h2:eth0-r1:p1" },
    ];
    const frames = [
      { timeUs: 0, bytes: payload(1, 2, 3), link: "l1" },
      { timeUs: 10, bytes: payload(4, 5), link: "l2" },
      { timeUs: 10, bytes: payload(6), link: "l1" },
      { timeUs: 1_000_001, bytes: payload(7, 8, 9, 10), link: "l2" },
    ];
    const file = parsed(parsePcapng(writePcapng(frames, links)));
    expect(file.interfaces.map((iface) => iface.name)).toEqual([
      "h1:eth0-r1:p0",
      "h2:eth0-r1:p1",
    ]);
    expect(file.interfaces.map((iface) => iface.tsResolution)).toEqual([
      1_000_000, 1_000_000,
    ]);
    expect(file.packets.map((packet) => packet.interfaceId)).toEqual([
      0, 1, 0, 1,
    ]);
    expect(file.packets.map((packet) => packet.timeUs)).toEqual([
      0, 10, 10, 1_000_001,
    ]);
    expect(file.packets.map((packet) => Array.from(packet.bytes))).toEqual([
      [1, 2, 3],
      [4, 5],
      [6],
      [7, 8, 9, 10],
    ]);
    expect(
      file.packets.every((packet) => packet.caplen === packet.wirelen),
    ).toBe(true);
  });

  test("the capture copies its bytes: later frame writes cannot reach it", () => {
    const source = { timeUs: 7, bytes: payload(1), link: "l1" };
    const out = writePcapng([source], [{ id: "l1" }]);
    source.bytes.set([0xff]);
    const packet = parsed(parsePcapng(out)).packets[0];
    expect(Array.from(packet?.bytes ?? [])).toEqual([1]);
  });

  test("the same frames and links always produce the same bytes", () => {
    const links = [{ id: "l1", name: "eth0" }, { id: "l2" }];
    const frames = [
      { timeUs: 7, bytes: payload(1), link: "l1" },
      { timeUs: 8, bytes: payload(2), link: "l2" },
    ];
    expect(Array.from(writePcapng(frames, links))).toEqual(
      Array.from(writePcapng(frames, links)),
    );
  });
});

describe("unknown blocks", () => {
  test("a block of an unknown type is skipped by its length", () => {
    const capture = writePcapng(
      [{ timeUs: 5, bytes: payload(1, 2), link: "l1" }],
      [{ id: "l1" }],
    );
    // Splice a 20-byte custom block right after the section header: readers
    // must ignore it and keep the IDB and EPB that follow.
    const unknown = block(0x0000_0bad, [0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]);
    expect(unknown.length).toBe(20);
    const spliced = new Uint8Array(capture.length + unknown.length);
    spliced.set(capture.subarray(0, SECTION_HEADER_BYTES.length), 0);
    spliced.set(unknown, SECTION_HEADER_BYTES.length);
    spliced.set(
      capture.subarray(SECTION_HEADER_BYTES.length),
      SECTION_HEADER_BYTES.length + unknown.length,
    );

    const file = parsed(parsePcapng(spliced));
    expect(file.interfaces.length).toBe(1);
    expect(file.packets.length).toBe(1);
    expect(file.packets[0]?.timeUs).toBe(5);
    expect(Array.from(file.packets[0]?.bytes ?? [])).toEqual([1, 2]);
  });
});

describe("byte order", () => {
  test("a big-endian section declares its order and is read as such", () => {
    const u16be = (value: number): Array<number> => [
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    const u32be = (value: number): Array<number> => [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    const beBlock = (type: number, body: Array<number>): Array<number> => {
      const padded = body.slice();
      while (padded.length % 4 !== 0) {
        padded.push(0);
      }
      const total = PCAPNG_BLOCK_HEADER_LENGTH + padded.length + 4;
      return [...u32be(type), ...u32be(total), ...padded, ...u32be(total)];
    };

    const shb = beBlock(PCAPNG_SHB_TYPE, [
      ...u32be(PCAPNG_BYTE_ORDER_MAGIC),
      ...u16be(1),
      ...u16be(0),
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    ]);
    const idb = beBlock(PCAPNG_IDB_TYPE, [
      ...u16be(1),
      ...u16be(0),
      ...u32be(PCAP_SNAPLEN),
      ...u16be(2),
      ...u16be(3),
      0x62,
      0x65,
      0x30,
      0x00, // if_name "be0"
      ...u16be(9),
      ...u16be(1),
      0x09,
      0x00,
      0x00,
      0x00, // if_tsresol 9 = nanoseconds
      0x00,
      0x00,
      0x00,
      0x00, // opt_endofopt
    ]);
    const epb = beBlock(PCAPNG_EPB_TYPE, [
      ...u32be(0), // interface id
      ...u32be(0), // timestamp high
      ...u32be(1_234_567_000), // timestamp low: 1.234567 s in nanoseconds
      ...u32be(4),
      ...u32be(4),
      0xde,
      0xad,
      0xbe,
      0xef,
    ]);

    const file = parsed(parsePcapng(Uint8Array.from([...shb, ...idb, ...epb])));
    expect(file.sections[0]?.byteOrder).toBe("big");
    expect(file.interfaces[0]?.name).toBe("be0");
    expect(file.interfaces[0]?.tsResolution).toBe(1_000_000_000);
    const packet = file.packets[0];
    expect(packet?.timeUs).toBe(1_234_567);
    expect(Array.from(packet?.bytes ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test("microseconds are the default when if_tsresol is absent", () => {
    const file = parsed(parsePcapng(writePcapng([], [{ id: "l1" }])));
    expect(file.interfaces[0]?.tsResolution).toBe(1_000_000);
    expect(PCAPNG_TSRESOL_MICROSECONDS).toBe(6);
  });
});

describe("parse is total", () => {
  const valid = writePcapng(
    [
      { timeUs: 0, bytes: payload(1, 2, 3, 4, 5, 6), link: "l1" },
      { timeUs: 12, bytes: payload(7, 8), link: "l2" },
      { timeUs: 1_000_000, bytes: payload(9), link: "l1" },
    ],
    [{ id: "l1" }, { id: "l2", name: "h2" }],
  );

  test("every truncation of a valid capture returns a typed result, never throws", () => {
    // Cutting exactly between blocks yields a valid shorter capture; every
    // other cut has to fail instead of half-parsing a block.
    const boundaries = new Set(blockBoundaries(valid));
    for (let cut = 0; cut < valid.length; cut++) {
      expect(() => parsePcapng(valid.slice(0, cut))).not.toThrow();
      const result = parsePcapng(valid.slice(0, cut));
      if (result.ok) {
        expect(boundaries.has(cut)).toBe(true);
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
        garbage[i] = (length * 37 + i * 19 + 3) & 0xff;
      }
      expect(() => parsePcapng(garbage)).not.toThrow();
      const result = parsePcapng(garbage);
      if (!result.ok) {
        expect(typeof result.error.code).toBe("string");
        expect(result.error.offset).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("a file that does not start with a section header is bad magic at 0", () => {
    const classic = new Uint8Array(24);
    classic.set([0xd4, 0xc3, 0xb2, 0xa1], 0);
    const result = parsePcapng(classic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-magic");
      expect(result.error.offset).toBe(0);
    }
  });

  test("a section header cut before its byte-order magic is truncated", () => {
    const result = parsePcapng(valid.slice(0, 20));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("truncated");
      expect(result.error.offset).toBe(0);
    }
  });

  test("a wrong byte-order magic is typed at the magic offset", () => {
    const bad = valid.slice();
    bad[8] = 0x00;
    const result = parsePcapng(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-magic");
      expect(result.error.offset).toBe(8);
    }
  });

  test("a block length that is not a multiple of 4 is rejected", () => {
    const bad = valid.slice();
    bad[4] = 45;
    bad[5] = 0;
    bad[6] = 0;
    bad[7] = 0;
    const result = parsePcapng(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-block");
      expect(result.error.offset).toBe(0);
    }
  });

  test("a block length past the end of the file is truncated", () => {
    const result = parsePcapng(valid.slice(0, valid.length - 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("truncated");
    }
  });

  test("a trailer that disagrees with the block length is rejected", () => {
    const bad = valid.slice();
    const lastBlock = (blockBoundaries(valid).at(-2) as number) ?? 0;
    const total = new DataView(bad.buffer).getUint32(lastBlock + 4, true);
    // The repeated length at the end of the block is zeroed: the block lies
    // about its own size and cannot be trusted.
    bad[lastBlock + total - 4] = 0x00;
    bad[lastBlock + total - 3] = 0x00;
    bad[lastBlock + total - 2] = 0x00;
    bad[lastBlock + total - 1] = 0x00;
    const result = parsePcapng(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-block");
      expect(result.error.offset).toBe(lastBlock + total - 4);
    }
  });

  test("an unsupported section version is typed at the version field", () => {
    const bad = valid.slice();
    bad[12] = 0x02;
    const result = parsePcapng(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported-version");
      expect(result.error.offset).toBe(12);
    }
  });

  test("a non-Ethernet interface is rejected at the link type field", () => {
    const bad = valid.slice();
    bad[52] = 0x65; // link type 101 = LINKTYPE_RAW
    const result = parsePcapng(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported-linktype");
      expect(result.error.offset).toBe(52);
    }
  });

  test("an EPB naming an undeclared interface is an inconsistent record", () => {
    const bad = valid.slice();
    const epb = findBlock(valid, PCAPNG_EPB_TYPE);
    expect(epb).toBeGreaterThan(0);
    bad[epb + 8] = 0x09; // interface id 9, but only two IDBs exist
    const result = parsePcapng(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-record");
      expect(result.error.offset).toBe(epb);
    }
  });

  test("an EPB whose captured length overflows its block is inconsistent", () => {
    const bad = valid.slice();
    const epb = findBlock(valid, PCAPNG_EPB_TYPE);
    expect(epb).toBeGreaterThan(0);
    // captured length at body + 12, well past the 6 bytes the block holds.
    bad[epb + 8 + 12] = 0xff;
    const result = parsePcapng(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-record");
      expect(result.error.offset).toBe(epb);
    }
  });
});
