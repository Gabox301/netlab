import { describe, expect, test } from "bun:test";
import { Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  ARP_HTYPE_ETHERNET,
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ARP_PTYPE_IPV4,
  type ArpPacket,
  parseArp,
  serializeArp,
} from "../src/arp";
import type { ParseError, ParseResult } from "../src/ethernet";

const MAC_A = MacAddress.parse("02:00:00:00:00:01");
const MAC_B = MacAddress.parse("02:00:00:00:00:02");
const MAC_UNKNOWN = MacAddress.parse("00:00:00:00:00:00");
const IP_A = Ipv4Address.parse("192.168.1.10");
const IP_B = Ipv4Address.parse("192.168.1.1");

const REQUEST: ArpPacket = {
  oper: ARP_OP_REQUEST,
  senderMac: MAC_A,
  senderIp: IP_A,
  targetMac: MAC_UNKNOWN,
  targetIp: IP_B,
};

const REPLY: ArpPacket = {
  oper: ARP_OP_REPLY,
  senderMac: MAC_B,
  senderIp: IP_B,
  targetMac: MAC_A,
  targetIp: IP_A,
};

function unwrap(result: ParseResult<ArpPacket>): ArpPacket {
  if (!result.ok) {
    throw new Error(
      `expected a parsed ARP packet, got ${result.error.code}: ${result.error.message}`,
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

/** Copy `wire` and overwrite bytes at `offset`. */
function patch(wire: Uint8Array, offset: number, values: number[]): Uint8Array {
  const copy = wire.slice();
  copy.set(values, offset);
  return copy;
}

function expectSamePacket(actual: ArpPacket, expected: ArpPacket): void {
  expect(actual.oper).toBe(expected.oper);
  expect(actual.senderMac.equals(expected.senderMac)).toBe(true);
  expect(actual.senderIp.equals(expected.senderIp)).toBe(true);
  expect(actual.targetMac.equals(expected.targetMac)).toBe(true);
  expect(actual.targetIp.equals(expected.targetIp)).toBe(true);
}

describe("ARP constants", () => {
  test("matches RFC 826 for Ethernet/IPv4", () => {
    expect(ARP_HTYPE_ETHERNET).toBe(1);
    expect(ARP_PTYPE_IPV4).toBe(0x0800);
    expect(ARP_OP_REQUEST).toBe(1);
    expect(ARP_OP_REPLY).toBe(2);
  });
});

describe("serializeArp", () => {
  test("writes the exact 28-byte request layout, big-endian", () => {
    const wire = serializeArp(REQUEST);
    expect(wire.length).toBe(28);
    expect(wire).toEqual(
      new Uint8Array([
        // htype 1, ptype 0x0800
        0x00, 0x01, 0x08, 0x00,
        // hlen 6, plen 4
        0x06, 0x04,
        // oper 1
        0x00, 0x01,
        // sender MAC 02:00:00:00:00:01
        0x02, 0x00, 0x00, 0x00, 0x00, 0x01,
        // sender IP 192.168.1.10
        0xc0, 0xa8, 0x01, 0x0a,
        // target MAC 00:00:00:00:00:00
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // target IP 192.168.1.1
        0xc0, 0xa8, 0x01, 0x01,
      ]),
    );
  });

  test("writes operation 2 for a reply", () => {
    const wire = serializeArp(REPLY);
    expect(wire.length).toBe(28);
    expect(wire[6]).toBe(0x00);
    expect(wire[7]).toBe(0x02);
    expect(wire.subarray(8, 14)).toEqual(MAC_B.toBytes());
  });
});

describe("parseArp", () => {
  test("round-trips a request", () => {
    const wire = serializeArp(REQUEST);
    const parsed = unwrap(parseArp(wire));
    expectSamePacket(parsed, REQUEST);
    expect(serializeArp(parsed)).toEqual(wire);
  });

  test("round-trips a reply", () => {
    const wire = serializeArp(REPLY);
    const parsed = unwrap(parseArp(wire));
    expectSamePacket(parsed, REPLY);
    expect(parsed.oper).toBe(ARP_OP_REPLY);
    expect(serializeArp(parsed)).toEqual(wire);
  });

  test("ignores trailing Ethernet padding", () => {
    const wire = serializeArp(REQUEST);
    const padded = new Uint8Array(wire.length + 18);
    padded.set(wire, 0);
    const parsed = unwrap(parseArp(padded));
    expectSamePacket(parsed, REQUEST);
  });

  test("returns a truncated error below 28 bytes", () => {
    for (const length of [0, 1, 8, 27]) {
      const error = unwrapError(parseArp(new Uint8Array(length)));
      expect(error.code).toBe("truncated");
      expect(error.message).toContain("28");
    }
  });

  test("rejects a non-Ethernet hardware type", () => {
    const error = unwrapError(
      parseArp(patch(serializeArp(REQUEST), 0, [0x00, 0x06])),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/hardware type/i);
  });

  test("rejects a non-IPv4 protocol type", () => {
    const error = unwrapError(
      parseArp(patch(serializeArp(REQUEST), 2, [0x86, 0xdd])),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/protocol type/i);
  });

  test("rejects a hardware address length other than 6", () => {
    const error = unwrapError(
      parseArp(patch(serializeArp(REQUEST), 4, [0x08])),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/hardware address length/i);
  });

  test("rejects a protocol address length other than 4", () => {
    const error = unwrapError(
      parseArp(patch(serializeArp(REQUEST), 5, [0x06])),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/protocol address length/i);
  });

  test("rejects operation 0 and operation 3", () => {
    for (const oper of [0, 3, 0xffff]) {
      const error = unwrapError(
        parseArp(
          patch(serializeArp(REQUEST), 6, [(oper >> 8) & 0xff, oper & 0xff]),
        ),
      );
      expect(error.code).toBe("invalid");
      expect(error.message).toMatch(/operation/i);
    }
  });

  test("never throws on malformed input", () => {
    for (const length of [0, 1, 27, 28]) {
      expect(() => parseArp(new Uint8Array(length))).not.toThrow();
    }
  });
});
