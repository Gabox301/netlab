/**
 * 802.1Q tag codec (F-17, S1/S2/S5).
 *
 * The tag lives between the source MAC and the inner EtherType:
 * `dst(6) src(6) TPID=0x8100(2) TCI(2) innerType(2) payload`. The TCI packs
 * PCP(3) | DEI(1) | VID(12). Scope is one tag per frame (S4: no QinQ), so a
 * second tag stays where it is: inside the payload.
 *
 * `parseEthernet()` is untouched and still refuses `0x8100` with
 * `unsupported-tagged`; the VLAN-aware parsers here are opt-in.
 */

import { describe, expect, test } from "bun:test";
import { MacAddress } from "@netlab/bytes";
import {
  ETHERTYPE_IPV4,
  ETHERTYPE_VLAN,
  type ParseError,
  type ParseResult,
  parseEthernet,
  serializeEthernet,
} from "../src/ethernet";
import {
  parseEthernetWithVlan,
  parseTaggedEthernet,
  parseVlanTag,
  serializeTaggedEthernet,
  serializeVlanTag,
  VLAN_MIN_FRAME_LENGTH,
  VLAN_TPID,
} from "../src/vlan";

const SRC = MacAddress.parse("02:00:00:00:00:01");
const DST = MacAddress.parse("02:00:00:00:00:02");
const BROADCAST = MacAddress.BROADCAST;

/** `00 01 02 ...` pattern of the requested length. */
function sequence(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => i & 0xff);
}

/** 46-byte payload: exactly the Ethernet minimum, so nothing gets padded. */
function payload(text: string): Uint8Array {
  const bytes = new Uint8Array(46);
  for (let i = 0; i < 46; i++) {
    bytes[i] = i < text.length ? text.charCodeAt(i) : 0x2e;
  }
  return bytes;
}

function tci(pcp: number, dei: number, vid: number): number {
  return ((pcp & 0x07) << 13) | ((dei & 0x01) << 12) | (vid & 0x0fff);
}

function tciBytes(pcp: number, dei: number, vid: number): Uint8Array {
  const value = tci(pcp, dei, vid);
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

/** Inner EtherType plus payload. */
function body(etherType: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (etherType >> 8) & 0xff;
  out[1] = etherType & 0xff;
  out.set(bytes, 2);
  return out;
}

/** TPID + TCI followed by `rest`: one tag layer. */
function tagBlock(
  pcp: number,
  dei: number,
  vid: number,
  rest: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(4 + rest.length);
  out[0] = 0x81;
  out[1] = 0x00;
  out.set(tciBytes(pcp, dei, vid), 2);
  out.set(rest, 4);
  return out;
}

/** dst + src followed by `rest`. */
function macFrame(
  dst: MacAddress,
  src: MacAddress,
  rest: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(12 + rest.length);
  out.set(dst.toBytes(), 0);
  out.set(src.toBytes(), 6);
  out.set(rest, 12);
  return out;
}

/** Hand-built single-tag frame. */
function taggedFrame(
  dst: MacAddress,
  src: MacAddress,
  pcp: number,
  dei: number,
  vid: number,
  innerType: number,
  bytes: Uint8Array,
): Uint8Array {
  return macFrame(dst, src, tagBlock(pcp, dei, vid, body(innerType, bytes)));
}

function unwrap<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected a parsed value, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function unwrapError(result: ParseResult<unknown>): ParseError {
  if (result.ok) {
    throw new Error("expected a parse failure, got a parsed value");
  }
  return result.error;
}

describe("parseVlanTag / serializeVlanTag", () => {
  test("decodes PCP, DEI and VID from the two TCI bytes", () => {
    expect(unwrap(parseVlanTag(tciBytes(5, 0, 100)))).toEqual({
      pcp: 5,
      dei: 0,
      vid: 100,
    });
    expect(unwrap(parseVlanTag(tciBytes(1, 1, 10)))).toEqual({
      pcp: 1,
      dei: 1,
      vid: 10,
    });
    expect(unwrap(parseVlanTag(tciBytes(7, 1, 4095)))).toEqual({
      pcp: 7,
      dei: 1,
      vid: 4095,
    });
    // VID 0 is the priority-tagging id: the codec reports it, policy drops it.
    expect(unwrap(parseVlanTag(tciBytes(0, 0, 0)))).toEqual({
      pcp: 0,
      dei: 0,
      vid: 0,
    });
  });

  test("reads exactly the first two bytes and ignores the rest", () => {
    const bytes = new Uint8Array([0xa0, 0x64, 0xff, 0xff]);
    expect(unwrap(parseVlanTag(bytes))).toEqual({ pcp: 5, dei: 0, vid: 100 });
  });

  test("reports a short TCI as truncated instead of throwing", () => {
    for (const length of [0, 1]) {
      const error = unwrapError(parseVlanTag(new Uint8Array(length)));
      expect(error.code).toBe("truncated");
    }
    expect(() => parseVlanTag(new Uint8Array(0))).not.toThrow();
  });

  test("serializes the TCI big-endian and round-trips", () => {
    expect(Array.from(serializeVlanTag({ pcp: 5, dei: 0, vid: 100 }))).toEqual([
      0xa0, 0x64,
    ]);
    expect(Array.from(serializeVlanTag({ pcp: 0, dei: 1, vid: 1 }))).toEqual([
      0x10, 0x01,
    ]);
    for (const tag of [
      { pcp: 0, dei: 0 as const, vid: 1 },
      { pcp: 3, dei: 1 as const, vid: 4094 },
      { pcp: 7, dei: 0 as const, vid: 0 },
    ]) {
      expect(unwrap(parseVlanTag(serializeVlanTag(tag)))).toEqual(tag);
    }
  });

  test("rejects out-of-range fields when serializing", () => {
    expect(() => serializeVlanTag({ pcp: 8, dei: 0, vid: 1 })).toThrow(
      RangeError,
    );
    expect(() => serializeVlanTag({ pcp: 0, dei: 0, vid: 4096 })).toThrow(
      RangeError,
    );
    expect(() => serializeVlanTag({ pcp: 0, dei: 0, vid: -1 })).toThrow(
      RangeError,
    );
    expect(() => serializeVlanTag({ pcp: 0, dei: 2 as 0, vid: 1 })).toThrow(
      RangeError,
    );
  });
});

describe("parseTaggedEthernet", () => {
  test("parses a full 802.1Q frame, inner EtherType and payload intact", () => {
    const bytes = payload("tagged");
    const frame = unwrap(
      parseTaggedEthernet(
        taggedFrame(BROADCAST, SRC, 1, 0, 100, ETHERTYPE_IPV4, bytes),
      ),
    );
    expect(frame.dst.isBroadcast()).toBe(true);
    expect(frame.src.equals(SRC)).toBe(true);
    expect(frame.etherType).toBe(ETHERTYPE_IPV4);
    expect(frame.vlan).toEqual({ pcp: 1, dei: 0, vid: 100 });
    // The four tag bytes are gone from the payload, not left in front of it.
    expect(frame.payload).toEqual(bytes);
  });

  test("accepts a tag-only 18-byte frame with an empty payload", () => {
    const wire = taggedFrame(
      DST,
      SRC,
      0,
      0,
      1,
      ETHERTYPE_IPV4,
      new Uint8Array(0),
    );
    expect(wire.length).toBe(18);
    const frame = unwrap(parseTaggedEthernet(wire));
    expect(frame.payload.length).toBe(0);
    expect(frame.vlan.vid).toBe(1);
  });

  test("rejects an untagged frame as invalid", () => {
    const plain = serializeEthernet(
      { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4 },
      payload("plain"),
    );
    const error = unwrapError(parseTaggedEthernet(plain));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/0x8100|802\.1Q/);
  });

  test("reports short frames as truncated, never throwing", () => {
    for (const length of [0, 1, 13]) {
      expect(
        unwrapError(parseTaggedEthernet(new Uint8Array(length))).code,
      ).toBe("truncated");
    }
    // TPID present but TCI and inner EtherType missing: still truncated.
    for (const length of [14, 15, 16, 17]) {
      const bytes = new Uint8Array(length);
      if (length >= 14) {
        bytes[12] = 0x81;
        bytes[13] = 0x00;
      }
      expect(unwrapError(parseTaggedEthernet(bytes)).code).toBe("truncated");
      expect(() => parseTaggedEthernet(bytes)).not.toThrow();
    }
  });
});

describe("parseEthernetWithVlan", () => {
  test("keeps the strict parser's anchor: parseEthernet still refuses 0x8100", () => {
    const wire = taggedFrame(
      BROADCAST,
      SRC,
      0,
      0,
      100,
      ETHERTYPE_IPV4,
      sequence(8),
    );
    expect(unwrapError(parseEthernet(wire)).code).toBe("unsupported-tagged");
    // The opt-in parser is the one that reads it.
    const frame = unwrap(parseEthernetWithVlan(wire));
    expect(frame.vlan).toEqual({ pcp: 0, dei: 0, vid: 100 });
  });

  test("parses untagged frames exactly like parseEthernet", () => {
    const wire = serializeEthernet(
      { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4 },
      payload("untagged"),
    );
    const plain = unwrap(parseEthernet(wire));
    const aware = unwrap(parseEthernetWithVlan(wire));
    expect(aware.dst.equals(plain.dst)).toBe(true);
    expect(aware.src.equals(plain.src)).toBe(true);
    expect(aware.etherType).toBe(plain.etherType);
    expect(aware.payload).toEqual(plain.payload);
    expect(aware.vlan).toBeUndefined();
    expect("vlan" in aware).toBe(false);
  });

  test("treats a second tag as payload (single-tag scope)", () => {
    const bytes = payload("qinq");
    const wire = macFrame(
      BROADCAST,
      SRC,
      tagBlock(2, 0, 10, tagBlock(0, 1, 20, body(ETHERTYPE_IPV4, bytes))),
    );
    const frame = unwrap(parseEthernetWithVlan(wire));
    expect(frame.vlan).toEqual({ pcp: 2, dei: 0, vid: 10 });
    // The inner TPID is an EtherType like any other: the rest is payload.
    expect(frame.etherType).toBe(ETHERTYPE_VLAN);

    // The first tag's TPID and TCI are the header; the second tag's own TCI
    // is the first thing left in the payload.
    expect(frame.payload).toEqual(
      tagBlock(0, 1, 20, body(ETHERTYPE_IPV4, bytes)).subarray(2),
    );
    expect(frame.payload.length).toBe(2 + 2 + bytes.length);

    // Re-serializing one tag reproduces the original bytes exactly.
    const tag = frame.vlan;
    if (tag === undefined) {
      throw new Error("expected the frame to carry a tag");
    }
    expect(
      serializeTaggedEthernet(
        {
          dst: frame.dst,
          src: frame.src,
          etherType: frame.etherType,
          vlan: tag,
        },
        frame.payload,
      ),
    ).toEqual(wire);
  });

  test("never throws on arbitrary bytes", () => {
    for (let length = 0; length <= 24; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = (length * 37 + i * 11) & 0xff;
      }
      expect(() => parseEthernetWithVlan(bytes)).not.toThrow();
      if (length >= 14) {
        // Force the tagged branch as well.
        bytes[12] = 0x81;
        bytes[13] = 0x00;
      }
      expect(() => parseEthernetWithVlan(bytes)).not.toThrow();
      expect(() => parseTaggedEthernet(bytes)).not.toThrow();
    }
  });
});

describe("serializeTaggedEthernet", () => {
  const vlan = { pcp: 5, dei: 1 as const, vid: 100 };

  test("writes TPID, TCI and the inner EtherType", () => {
    const wire = serializeTaggedEthernet(
      { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4, vlan },
      sequence(46),
    );
    expect(wire.subarray(0, 6)).toEqual(DST.toBytes());
    expect(wire.subarray(6, 12)).toEqual(SRC.toBytes());
    expect(wire[12]).toBe(0x81);
    expect(wire[13]).toBe(0x00);
    expect(wire[14]).toBe(0xb0);
    expect(wire[15]).toBe(0x64);
    expect(wire[16]).toBe(0x08);
    expect(wire[17]).toBe(0x00);
  });

  test("pads to the 64-byte tagged minimum", () => {
    for (const length of [0, 1, 45]) {
      const wire = serializeTaggedEthernet(
        { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4, vlan },
        sequence(length),
      );
      expect(wire.length).toBe(VLAN_MIN_FRAME_LENGTH);
      const padding = wire.subarray(18 + length);
      expect(Array.from(padding).every((b) => b === 0)).toBe(true);
    }
  });

  test("does not pad frames at or above 64 bytes", () => {
    expect(
      serializeTaggedEthernet(
        { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4, vlan },
        sequence(46),
      ).length,
    ).toBe(64);
    expect(
      serializeTaggedEthernet(
        { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4, vlan },
        sequence(47),
      ).length,
    ).toBe(65);
  });

  test("round-trips payloads of 46 bytes or more exactly", () => {
    for (const length of [46, 60, 100]) {
      const bytes = sequence(length);
      const wire = serializeTaggedEthernet(
        { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4, vlan },
        bytes,
      );
      const frame = unwrap(parseTaggedEthernet(wire));
      expect(frame.payload).toEqual(bytes);
      expect(
        serializeTaggedEthernet(
          {
            dst: frame.dst,
            src: frame.src,
            etherType: frame.etherType,
            vlan: frame.vlan,
          },
          frame.payload,
        ),
      ).toEqual(wire);
    }
  });

  test("copies the payload instead of aliasing it", () => {
    const bytes = sequence(46);
    const wire = serializeTaggedEthernet(
      { dst: DST, src: SRC, etherType: ETHERTYPE_IPV4, vlan },
      bytes,
    );
    wire[18] = 0xff;
    expect(bytes[0]).toBe(0);
  });
});

describe("802.1Q constants", () => {
  test("names the standard values", () => {
    expect(VLAN_TPID).toBe(0x8100);
    expect(VLAN_TPID).toBe(ETHERTYPE_VLAN);
    expect(VLAN_MIN_FRAME_LENGTH).toBe(64);
  });
});
