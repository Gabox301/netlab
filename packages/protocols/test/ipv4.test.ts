import { describe, expect, test } from "bun:test";
import { Ipv4Address } from "@netlab/bytes";
import type { ParseError } from "../src/ethernet";
import {
  IPV4_MIN_HEADER_LENGTH,
  type Ipv4Header,
  parseIpv4,
  serializeIpv4,
} from "../src/ipv4";

// RFC 791 §3.1 example header: version 4, IHL 5, TOS 0, len 115, id 0,
// flags DF, offset 0, TTL 64, proto 17 (UDP), 192.168.0.1 -> 192.168.0.199.
const RFC791_HEADER = new Uint8Array([
  0x45, 0x00, 0x00, 0x73, 0x00, 0x00, 0x40, 0x00, 0x40, 0x11, 0xb8, 0x61, 0xc0,
  0xa8, 0x00, 0x01, 0xc0, 0xa8, 0x00, 0xc7,
]);

const IP_A = Ipv4Address.parse("10.0.0.1");
const IP_B = Ipv4Address.parse("10.0.0.2");

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: ParseError },
): T {
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function unwrapError(
  result: { ok: true; value: unknown } | { ok: false; error: ParseError },
): ParseError {
  if (result.ok) {
    throw new Error("expected error, got ok");
  }
  return result.error;
}

/** Overwrite bytes at `offset` with `values`. */
function patch(
  wire: Uint8Array,
  offset: number,
  values: Array<number>,
): Uint8Array {
  const out = wire.slice();
  for (let i = 0; i < values.length; i++) {
    out[offset + i] = values[i] as number;
  }
  return out;
}

function smallHeader(): Ipv4Header {
  return {
    version: 4,
    ihl: 5,
    dscp: 0,
    ecn: 0,
    totalLength: 0,
    identification: 0x1234,
    flags: { reserved: false, dontFragment: false, moreFragments: false },
    fragmentOffset: 0,
    ttl: 64,
    protocol: 1,
    checksum: 0,
    src: IP_A,
    dst: IP_B,
    options: new Uint8Array([]),
  };
}

function rfc791Packet(extraPayload: number): Uint8Array {
  const out = new Uint8Array(RFC791_HEADER.length + extraPayload);
  out.set(RFC791_HEADER);
  return out;
}

describe("parseIpv4", () => {
  test("parses the RFC 791 header example", () => {
    // totalLength is 115 but only 20 bytes are present: truncated.
    expect(unwrapError(parseIpv4(RFC791_HEADER)).code).toBe("truncated");
    const packet = unwrap(parseIpv4(rfc791Packet(95)));
    expect(packet.header.version).toBe(4);
    expect(packet.header.ihl).toBe(5);
    expect(packet.header.dscp).toBe(0);
    expect(packet.header.ecn).toBe(0);
    expect(packet.header.totalLength).toBe(0x73);
    expect(packet.header.identification).toBe(0);
    expect(packet.header.flags).toEqual({
      reserved: false,
      dontFragment: true,
      moreFragments: false,
    });
    expect(packet.header.fragmentOffset).toBe(0);
    expect(packet.header.ttl).toBe(64);
    expect(packet.header.protocol).toBe(17);
    expect(packet.header.checksum).toBe(0xb861);
    expect(packet.header.src.toString()).toBe("192.168.0.1");
    expect(packet.header.dst.toString()).toBe("192.168.0.199");
    expect(packet.header.options).toEqual(new Uint8Array([]));
    expect(packet.payload).toHaveLength(95);
  });

  test("splits TOS into DSCP and ECN", () => {
    const wire = serializeIpv4(
      { ...smallHeader(), dscp: 0x2e, ecn: 0x03 },
      new Uint8Array([]),
    );
    expect(wire[1]).toBe(0xbb);
    const back = unwrap(parseIpv4(wire));
    expect(back.header.dscp).toBe(0x2e);
    expect(back.header.ecn).toBe(3);
  });

  test("ignores tail bytes past totalLength (Ethernet padding)", () => {
    const wire = serializeIpv4(smallHeader(), new Uint8Array(20).fill(7));
    expect(wire).toHaveLength(40);
    const padded = new Uint8Array(60);
    padded.set(wire);
    const back = unwrap(parseIpv4(padded));
    expect(back.payload).toEqual(new Uint8Array(20).fill(7));
  });

  test("preserves options but ignores their meaning", () => {
    const options = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const header: Ipv4Header = {
      version: 4,
      ihl: 6,
      dscp: 0,
      ecn: 0,
      totalLength: 24,
      identification: 1,
      flags: { reserved: false, dontFragment: false, moreFragments: false },
      fragmentOffset: 0,
      ttl: 64,
      protocol: 1,
      checksum: 0,
      src: IP_A,
      dst: IP_B,
      options,
    };
    const wire = serializeIpv4(header, new Uint8Array([]));
    expect(wire).toHaveLength(24);
    const back = unwrap(parseIpv4(wire));
    expect(back.header.ihl).toBe(6);
    expect(back.header.options).toEqual(options);
  });

  test("rejects short buffers as truncated", () => {
    const full = rfc791Packet(95);
    for (let len = 0; len < IPV4_MIN_HEADER_LENGTH; len++) {
      const error = unwrapError(parseIpv4(full.slice(0, len)));
      expect(error.code).toBe("truncated");
    }
  });

  test("rejects totalLength beyond the available bytes", () => {
    expect(unwrapError(parseIpv4(RFC791_HEADER)).code).toBe("truncated");
  });

  test("rejects a non-IPv4 version", () => {
    const error = unwrapError(parseIpv4(patch(rfc791Packet(95), 0, [0x60])));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/version/i);
  });

  test("rejects IHL below 5", () => {
    const error = unwrapError(parseIpv4(patch(rfc791Packet(95), 0, [0x44])));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/ihl/i);
  });

  test("rejects a bad header checksum", () => {
    const error = unwrapError(parseIpv4(patch(rfc791Packet(95), 10, [0x00])));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/checksum/i);
  });

  test("rejects TTL zero", () => {
    const wire = serializeIpv4(
      { ...smallHeader(), ttl: 0 },
      new Uint8Array([1]),
    );
    const error = unwrapError(parseIpv4(wire));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/ttl/i);
  });

  test("never throws on malformed input", () => {
    for (let len = 0; len <= 32; len++) {
      const junk = new Uint8Array(len).fill(0xff);
      const result = parseIpv4(junk);
      expect(typeof result.ok).toBe("boolean");
    }
  });
});

describe("serializeIpv4", () => {
  test("emits an exact byte layout with a valid checksum", () => {
    const header: Ipv4Header = {
      version: 4,
      ihl: 5,
      dscp: 0,
      ecn: 0,
      totalLength: 25,
      identification: 0x1234,
      flags: { reserved: false, dontFragment: false, moreFragments: false },
      fragmentOffset: 0,
      ttl: 64,
      protocol: 1,
      checksum: 0,
      src: IP_A,
      dst: IP_B,
      options: new Uint8Array([]),
    };
    expect(serializeIpv4(header, new TextEncoder().encode("hello"))).toEqual(
      new Uint8Array([
        // version/IHL, TOS, total length
        0x45, 0x00, 0x00, 0x19,
        // identification, flags/offset
        0x12, 0x34, 0x00, 0x00,
        // TTL, protocol, checksum 0x54ae
        0x40, 0x01, 0x54, 0xae,
        // src 10.0.0.1, dst 10.0.0.2
        0x0a, 0x00, 0x00, 0x01, 0x0a, 0x00, 0x00, 0x02,
        // "hello"
        0x68, 0x65, 0x6c, 0x6c, 0x6f,
      ]),
    );
  });

  test("round-trips parse(serialize(x))", () => {
    const header: Ipv4Header = {
      version: 4,
      ihl: 5,
      dscp: 0x2e,
      ecn: 0,
      totalLength: 0,
      identification: 0xabcd,
      flags: { reserved: false, dontFragment: true, moreFragments: false },
      fragmentOffset: 0,
      ttl: 128,
      protocol: 6,
      checksum: 0,
      src: IP_A,
      dst: IP_B,
      options: new Uint8Array([]),
    };
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const wire = serializeIpv4(header, payload);
    const back = unwrap(parseIpv4(wire));
    expect(back.header.totalLength).toBe(20 + payload.length);
    expect(back.header.dscp).toBe(0x2e);
    expect(back.header.identification).toBe(0xabcd);
    expect(back.header.flags.dontFragment).toBe(true);
    expect(back.header.ttl).toBe(128);
    expect(back.payload).toEqual(payload);
  });
});
