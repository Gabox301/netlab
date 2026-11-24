import { describe, expect, test } from "bun:test";
import { MacAddress } from "@netlab/bytes";
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_VLAN,
  type EthernetFrame,
  type ParseError,
  type ParseResult,
  parseEthernet,
  serializeEthernet,
  shouldAccept,
} from "../src/ethernet";

const HEADER_LEN = 14;
const MIN_FRAME_LEN = 60;

const SRC = MacAddress.parse("02:00:00:00:00:01");
const OWN = MacAddress.parse("02:00:00:00:00:02");
const OTHER_UNICAST = MacAddress.parse("02:00:00:00:00:03");
const JOINED_MULTICAST = MacAddress.parse("01:00:5e:00:00:01");
const UNJOINED_MULTICAST = MacAddress.parse("01:00:5e:00:00:02");

/** `00 01 02 ...` pattern of the requested length. */
function sequence(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => i & 0xff);
}

function headerBytes(
  dst: MacAddress,
  src: MacAddress,
  etherType: number,
): Uint8Array {
  const out = new Uint8Array(HEADER_LEN);
  out.set(dst.toBytes(), 0);
  out.set(src.toBytes(), 6);
  out[12] = (etherType >> 8) & 0xff;
  out[13] = etherType & 0xff;
  return out;
}

function buildFrame(
  dst: MacAddress,
  src: MacAddress,
  etherType: number,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(HEADER_LEN + payload.length);
  frame.set(headerBytes(dst, src, etherType), 0);
  frame.set(payload, HEADER_LEN);
  return frame;
}

function unwrap(result: ParseResult<EthernetFrame>): EthernetFrame {
  if (!result.ok) {
    throw new Error(
      `expected a parsed frame, got ${result.error.code}: ${result.error.message}`,
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

describe("parseEthernet", () => {
  test("parses a hand-built Ethernet II frame", () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const frame = unwrap(
      parseEthernet(
        buildFrame(MacAddress.BROADCAST, SRC, ETHERTYPE_IPV4, payload),
      ),
    );
    expect(frame.dst.isBroadcast()).toBe(true);
    expect(frame.src.equals(SRC)).toBe(true);
    expect(frame.etherType).toBe(ETHERTYPE_IPV4);
    expect(frame.payload).toEqual(payload);
  });

  test("reports the ARP EtherType and keeps the payload verbatim", () => {
    const payload = sequence(28);
    const frame = unwrap(
      parseEthernet(buildFrame(OWN, SRC, ETHERTYPE_ARP, payload)),
    );
    expect(frame.dst.equals(OWN)).toBe(true);
    expect(frame.etherType).toBe(0x0806);
    expect(frame.payload).toEqual(payload);
  });

  test("accepts a minimal 14-byte frame with an empty payload", () => {
    const frame = unwrap(
      parseEthernet(buildFrame(OWN, SRC, ETHERTYPE_IPV4, new Uint8Array(0))),
    );
    expect(frame.payload.length).toBe(0);
  });

  test("keeps zero padding as part of the payload", () => {
    // Padding is indistinguishable from payload without an IPv4/IPv6 length
    // field, so the parser must hand it over untouched.
    const wire = serializeEthernet(
      { dst: OWN, src: SRC, etherType: ETHERTYPE_IPV4 },
      new Uint8Array([0x11, 0x22]),
    );
    expect(wire.length).toBe(MIN_FRAME_LEN);
    const frame = unwrap(parseEthernet(wire));
    expect(frame.payload.length).toBe(MIN_FRAME_LEN - HEADER_LEN);
    expect(frame.payload.subarray(0, 2)).toEqual(new Uint8Array([0x11, 0x22]));
    expect(Array.from(frame.payload.subarray(2)).every((b) => b === 0)).toBe(
      true,
    );
  });

  test("returns a truncated error below 14 bytes", () => {
    for (const length of [0, 1, 6, 13]) {
      const error = unwrapError(parseEthernet(new Uint8Array(length)));
      expect(error.code).toBe("truncated");
      expect(error.message).toContain("14");
    }
  });

  test("never throws on malformed input", () => {
    for (const length of [0, 1, 13, 14, 20]) {
      expect(() => parseEthernet(new Uint8Array(length))).not.toThrow();
    }
  });

  test("rejects 802.1Q tagged frames instead of misparsing them", () => {
    // dst/src, 0x8100, TCI 0x0064 (VID 100), inner EtherType 0x0800, ...
    const tagged = buildFrame(
      MacAddress.BROADCAST,
      SRC,
      ETHERTYPE_VLAN,
      new Uint8Array([0x00, 0x64, 0x08, 0x00, 0x45, 0x00]),
    );
    const error = unwrapError(parseEthernet(tagged));
    expect(error.code).toBe("unsupported-tagged");
    expect(error.message).toMatch(/0x8100|802\.1Q/);
  });

  test("exports the standard EtherType constants", () => {
    expect(ETHERTYPE_IPV4).toBe(0x0800);
    expect(ETHERTYPE_ARP).toBe(0x0806);
    expect(ETHERTYPE_VLAN).toBe(0x8100);
  });
});

describe("serializeEthernet", () => {
  const header = { dst: OWN, src: SRC, etherType: ETHERTYPE_IPV4 };

  test("writes dst, src and a big-endian EtherType", () => {
    const wire = serializeEthernet(header, sequence(46));
    expect(wire.subarray(0, 6)).toEqual(OWN.toBytes());
    expect(wire.subarray(6, 12)).toEqual(SRC.toBytes());
    expect(wire[12]).toBe(0x08);
    expect(wire[13]).toBe(0x00);
  });

  test("zero-pads short frames to 60 bytes total", () => {
    for (const length of [0, 1, 4, 45]) {
      const wire = serializeEthernet(header, sequence(length));
      expect(wire.length).toBe(MIN_FRAME_LEN);
      const padding = wire.subarray(HEADER_LEN + length);
      expect(padding.length).toBeGreaterThan(0);
      expect(Array.from(padding).every((b) => b === 0)).toBe(true);
    }
  });

  test("does not pad frames at or above 60 bytes", () => {
    expect(serializeEthernet(header, sequence(46)).length).toBe(60);
    expect(serializeEthernet(header, sequence(47)).length).toBe(61);
    expect(serializeEthernet(header, sequence(100)).length).toBe(114);
  });

  test("round-trips payloads of 46 bytes or more exactly", () => {
    for (const length of [46, 60, 100]) {
      const payload = sequence(length);
      const wire = serializeEthernet(header, payload);
      const frame = unwrap(parseEthernet(wire));
      expect(frame.payload).toEqual(payload);
      expect(serializeEthernet(frame, frame.payload)).toEqual(wire);
    }
  });
});

describe("shouldAccept", () => {
  function frameTo(dst: MacAddress): EthernetFrame {
    return {
      dst,
      src: SRC,
      etherType: ETHERTYPE_IPV4,
      payload: new Uint8Array(0),
    };
  }

  test("accepts the interface's own unicast MAC", () => {
    expect(shouldAccept(OWN, frameTo(OWN))).toBe(true);
  });

  test("always accepts broadcast", () => {
    expect(shouldAccept(OWN, frameTo(MacAddress.BROADCAST))).toBe(true);
    expect(
      shouldAccept(OWN, frameTo(MacAddress.BROADCAST), {
        promiscuous: false,
        multicastGroups: [],
      }),
    ).toBe(true);
  });

  test("accepts multicast only when the group is joined", () => {
    expect(
      shouldAccept(OWN, frameTo(JOINED_MULTICAST), {
        multicastGroups: [UNJOINED_MULTICAST, JOINED_MULTICAST],
      }),
    ).toBe(true);
    expect(
      shouldAccept(OWN, frameTo(UNJOINED_MULTICAST), {
        multicastGroups: [JOINED_MULTICAST],
      }),
    ).toBe(false);
    expect(shouldAccept(OWN, frameTo(JOINED_MULTICAST))).toBe(false);
  });

  test("promiscuous mode accepts every destination", () => {
    expect(
      shouldAccept(OWN, frameTo(OTHER_UNICAST), { promiscuous: true }),
    ).toBe(true);
    expect(
      shouldAccept(OWN, frameTo(JOINED_MULTICAST), { promiscuous: true }),
    ).toBe(true);
  });

  test("drops other unicast addresses by default", () => {
    expect(shouldAccept(OWN, frameTo(OTHER_UNICAST))).toBe(false);
    expect(
      shouldAccept(OWN, frameTo(OTHER_UNICAST), {
        promiscuous: false,
        multicastGroups: [JOINED_MULTICAST],
      }),
    ).toBe(false);
  });
});
