/**
 * DHCP codec (F-72/73): BOOTP message plus the magic cookie and the option
 * TLVs the simulator needs. These tests are written before the module exists
 * (strict TDD) and drive the whole surface: round-trips for the four DORA
 * message types, total parsing (bad cookie, chopped TLV, garbage) and
 * RangeError validation in the serializer.
 */

import { describe, expect, test } from "bun:test";
import {
  DHCP_BROADCAST_FLAG,
  DHCP_CHADDR_LENGTH,
  DHCP_CLIENT_PORT,
  DHCP_FILE_LENGTH,
  DHCP_FIXED_LENGTH,
  DHCP_HLEN_ETHERNET,
  DHCP_HTYPE_ETHERNET,
  DHCP_MAGIC_COOKIE,
  DHCP_MESSAGE_ACK,
  DHCP_MESSAGE_DISCOVER,
  DHCP_MESSAGE_NAK,
  DHCP_MESSAGE_OFFER,
  DHCP_MESSAGE_REQUEST,
  DHCP_MIN_MESSAGE_LENGTH,
  DHCP_OP_REPLY,
  DHCP_OP_REQUEST,
  DHCP_OPTION_DNS,
  DHCP_OPTION_END,
  DHCP_OPTION_LEASE_TIME,
  DHCP_OPTION_MESSAGE_TYPE,
  DHCP_OPTION_PAD,
  DHCP_OPTION_REQUESTED_IP,
  DHCP_OPTION_ROUTER,
  DHCP_OPTION_SERVER_ID,
  DHCP_OPTION_SUBNET_MASK,
  DHCP_OPTIONS_OFFSET,
  DHCP_SERVER_PORT,
  DHCP_SNAME_LENGTH,
  type DhcpMessage,
  type DhcpOption,
  dhcpFindOption,
  dhcpHardwareAddress,
  dhcpMessageType,
  parseDhcp,
  serializeDhcp,
} from "../src/dhcp";

const MAC = [0x02, 0x00, 0x00, 0x00, 0x00, 0x0a];

const SERVER_OPTIONS: DhcpOption[] = [
  { kind: "message-type", type: DHCP_MESSAGE_OFFER },
  { kind: "server-id", id: "10.0.0.1" },
  { kind: "subnet-mask", mask: "255.255.255.0" },
  { kind: "router", routers: ["10.0.0.254"] },
  { kind: "dns", servers: ["10.0.0.53", "10.0.0.54"] },
  { kind: "lease-time", seconds: 3600 },
];

function chaddr(octets: number[] = MAC): Uint8Array {
  const bytes = new Uint8Array(DHCP_CHADDR_LENGTH);
  bytes.set(octets.slice(0, DHCP_CHADDR_LENGTH));
  return bytes;
}

function bootp(overrides: Partial<DhcpMessage> = {}): DhcpMessage {
  return {
    op: DHCP_OP_REQUEST,
    htype: DHCP_HTYPE_ETHERNET,
    hlen: DHCP_HLEN_ETHERNET,
    hops: 0,
    xid: 0x1a2b3c4d,
    secs: 0,
    flags: DHCP_BROADCAST_FLAG,
    ciaddr: "0.0.0.0",
    yiaddr: "0.0.0.0",
    siaddr: "0.0.0.0",
    giaddr: "0.0.0.0",
    chaddr: chaddr(),
    sname: new Uint8Array(DHCP_SNAME_LENGTH),
    file: new Uint8Array(DHCP_FILE_LENGTH),
    options: [{ kind: "message-type", type: DHCP_MESSAGE_DISCOVER }],
    ...overrides,
  };
}

function unwrap(result: ReturnType<typeof parseDhcp>): DhcpMessage {
  if (!result.ok) {
    throw new Error(
      `expected ok, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function wire(message: DhcpMessage): Uint8Array {
  return serializeDhcp(message);
}

describe("dhcp codec (F-72/73)", () => {
  test("advertises the standard ports, widths and cookie", () => {
    expect(DHCP_SERVER_PORT).toBe(67);
    expect(DHCP_CLIENT_PORT).toBe(68);
    expect(DHCP_FIXED_LENGTH).toBe(236);
    expect(DHCP_OPTIONS_OFFSET).toBe(240);
    expect(DHCP_MIN_MESSAGE_LENGTH).toBe(241);
    expect(DHCP_MAGIC_COOKIE).toBe(0x63825363);
    expect(DHCP_OPTION_PAD).toBe(0);
    expect(DHCP_OPTION_SUBNET_MASK).toBe(1);
    expect(DHCP_OPTION_ROUTER).toBe(3);
    expect(DHCP_OPTION_DNS).toBe(6);
    expect(DHCP_OPTION_REQUESTED_IP).toBe(50);
    expect(DHCP_OPTION_LEASE_TIME).toBe(51);
    expect(DHCP_OPTION_MESSAGE_TYPE).toBe(53);
    expect(DHCP_OPTION_SERVER_ID).toBe(54);
    expect(DHCP_OPTION_END).toBe(255);
    expect([
      DHCP_MESSAGE_DISCOVER,
      DHCP_MESSAGE_OFFER,
      DHCP_MESSAGE_REQUEST,
      DHCP_MESSAGE_ACK,
      DHCP_MESSAGE_NAK,
    ]).toEqual([1, 2, 3, 5, 6]);
  });

  test("round-trips a Discover", () => {
    const message = bootp();
    const parsed = unwrap(parseDhcp(wire(message)));
    expect(parsed).toEqual(message);
    expect(dhcpMessageType(parsed.options)).toBe(DHCP_MESSAGE_DISCOVER);
  });

  test("round-trips an Offer with subnet, router, DNS and lease time", () => {
    const message = bootp({
      op: DHCP_OP_REPLY,
      yiaddr: "10.0.0.100",
      siaddr: "10.0.0.1",
      options: SERVER_OPTIONS,
    });
    const parsed = unwrap(parseDhcp(wire(message)));
    expect(parsed).toEqual(message);
    expect(dhcpFindOption(parsed.options, "subnet-mask")?.mask).toBe(
      "255.255.255.0",
    );
    expect(dhcpFindOption(parsed.options, "router")?.routers).toEqual([
      "10.0.0.254",
    ]);
    expect(dhcpFindOption(parsed.options, "dns")?.servers).toEqual([
      "10.0.0.53",
      "10.0.0.54",
    ]);
    expect(dhcpFindOption(parsed.options, "lease-time")?.seconds).toBe(3600);
    expect(dhcpFindOption(parsed.options, "message-type")?.type).toBe(
      DHCP_MESSAGE_OFFER,
    );
  });

  test("round-trips a Request with the requested address and server id", () => {
    const message = bootp({
      ciaddr: "0.0.0.0",
      options: [
        { kind: "message-type", type: DHCP_MESSAGE_REQUEST },
        { kind: "requested-ip", ip: "10.0.0.100" },
        { kind: "server-id", id: "10.0.0.1" },
      ],
    });
    const parsed = unwrap(parseDhcp(wire(message)));
    expect(parsed).toEqual(message);
    expect(dhcpFindOption(parsed.options, "requested-ip")?.ip).toBe(
      "10.0.0.100",
    );
  });

  test("round-trips an Ack that fills every fixed field", () => {
    const message = bootp({
      op: DHCP_OP_REPLY,
      hops: 1,
      xid: 0xffffffff,
      secs: 0xffff,
      flags: 0x8000,
      ciaddr: "10.0.0.100",
      yiaddr: "10.0.0.100",
      siaddr: "10.0.0.2",
      giaddr: "10.0.0.254",
      chaddr: chaddr([0x02, 0xff, 0x00, 0x11, 0x22, 0x33]),
      sname: Uint8Array.from({ length: DHCP_SNAME_LENGTH }, (_, i) =>
        i === 0 ? 0x73 : 0,
      ),
      file: Uint8Array.from({ length: DHCP_FILE_LENGTH }, (_, i) =>
        i === 0 ? 0x2f : 0,
      ),
      options: [
        { kind: "message-type", type: DHCP_MESSAGE_ACK },
        ...SERVER_OPTIONS.slice(1),
      ],
    });
    const parsed = unwrap(parseDhcp(wire(message)));
    expect(parsed).toEqual(message);
    expect(dhcpMessageType(parsed.options)).toBe(DHCP_MESSAGE_ACK);
  });

  test("keeps unknown options opaque so they round-trip", () => {
    const message = bootp({
      options: [
        { kind: "message-type", type: DHCP_MESSAGE_REQUEST },
        { kind: "raw", code: 12, data: new Uint8Array([0x6e, 0x65, 0x74]) },
      ],
    });
    const parsed = unwrap(parseDhcp(wire(message)));
    expect(parsed).toEqual(message);
  });

  test("skips pad bytes between options", () => {
    const message = bootp({
      options: [
        { kind: "message-type", type: DHCP_MESSAGE_REQUEST },
        { kind: "server-id", id: "10.0.0.1" },
      ],
    });
    const bytes = wire(message);
    // Insert a pad option right after the message-type TLV, before the end.
    const view = [];
    for (let i = 0; i < bytes.length; i++) {
      view.push(bytes[i] as number);
    }
    const endAt = view.indexOf(DHCP_OPTION_END, DHCP_OPTIONS_OFFSET);
    expect(endAt).toBeGreaterThan(0);
    view.splice(endAt, 0, DHCP_OPTION_PAD, DHCP_OPTION_PAD);

    const parsed = unwrap(parseDhcp(Uint8Array.from(view)));
    expect(parsed.options).toEqual(message.options);
  });

  test("exposes chaddr trimmed to hlen", () => {
    const message = bootp();
    const parsed = unwrap(parseDhcp(wire(message)));
    expect([...dhcpHardwareAddress(parsed)]).toEqual(MAC);
  });

  test("rejects a bad magic cookie as invalid", () => {
    const bytes = wire(bootp());
    bytes[DHCP_FIXED_LENGTH] = 0x00;
    const result = parseDhcp(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid");
      expect(result.error.message).toContain("cookie");
    }
  });

  test("rejects a chopped option TLV as truncated", () => {
    const bytes = wire(
      bootp({
        options: [
          { kind: "message-type", type: DHCP_MESSAGE_DISCOVER },
          { kind: "server-id", id: "10.0.0.1" },
        ],
      }),
    );
    // Cut inside the last option's value: the length field now overruns.
    const chopped = bytes.slice(0, bytes.length - 2);
    const result = parseDhcp(chopped);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("truncated");
    }
  });

  test("rejects a payload shorter than the fixed BOOTP header as truncated", () => {
    for (const size of [0, 1, 4, DHCP_FIXED_LENGTH - 1]) {
      const result = parseDhcp(new Uint8Array(size));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("truncated");
      }
    }
  });

  test("rejects a known option with the wrong length as invalid", () => {
    // Fixed BOOTP header + cookie, then `53 02 01 01 ff`: a two-byte
    // message-type value, which no DHCP message may carry.
    const fixed = wire(bootp({ options: [] }));
    expect(fixed.length).toBe(DHCP_MIN_MESSAGE_LENGTH);
    const shifted = new Uint8Array(DHCP_OPTIONS_OFFSET + 5);
    shifted.set(fixed.subarray(0, DHCP_OPTIONS_OFFSET));
    shifted[DHCP_OPTIONS_OFFSET] = DHCP_OPTION_MESSAGE_TYPE;
    shifted[DHCP_OPTIONS_OFFSET + 1] = 2;
    shifted[DHCP_OPTIONS_OFFSET + 2] = 0x01;
    shifted[DHCP_OPTIONS_OFFSET + 3] = 0x01;
    shifted[DHCP_OPTIONS_OFFSET + 4] = DHCP_OPTION_END;

    const result = parseDhcp(shifted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid");
      expect(result.error.message).toContain("message-type");
    }
  });

  test("never throws on truncated or corrupted input", () => {
    const bytes = wire(
      bootp({
        op: DHCP_OP_REPLY,
        yiaddr: "10.0.0.100",
        options: SERVER_OPTIONS,
      }),
    );
    for (let length = 0; length <= bytes.length; length++) {
      expect(() => parseDhcp(bytes.slice(0, length))).not.toThrow();
    }
    for (let i = 0; i < bytes.length; i++) {
      for (const value of [0x00, 0xff, 0x7f]) {
        const mutated = bytes.slice();
        mutated[i] = value;
        expect(() => parseDhcp(mutated)).not.toThrow();
      }
    }
    expect(() => parseDhcp(new Uint8Array(1024).fill(0xff))).not.toThrow();
  });

  test("serializer throws RangeError on out-of-range fields", () => {
    expect(() => serializeDhcp(bootp({ op: 256 }))).toThrow(RangeError);
    expect(() => serializeDhcp(bootp({ hlen: -1 }))).toThrow(RangeError);
    expect(() => serializeDhcp(bootp({ xid: -1 }))).toThrow(RangeError);
    expect(() => serializeDhcp(bootp({ xid: 0x1_0000_0000 }))).toThrow(
      RangeError,
    );
    expect(() => serializeDhcp(bootp({ secs: 0x1_0000 }))).toThrow(RangeError);
    expect(() => serializeDhcp(bootp({ flags: 0x1_0000 }))).toThrow(RangeError);
    expect(() => serializeDhcp(bootp({ yiaddr: "10.0.0.256" }))).toThrow(
      RangeError,
    );
    expect(() =>
      serializeDhcp(bootp({ chaddr: new Uint8Array(DHCP_CHADDR_LENGTH + 1) })),
    ).toThrow(RangeError);
    expect(() =>
      serializeDhcp(bootp({ sname: new Uint8Array(DHCP_SNAME_LENGTH + 1) })),
    ).toThrow(RangeError);
    expect(() =>
      serializeDhcp(bootp({ file: new Uint8Array(DHCP_FILE_LENGTH + 1) })),
    ).toThrow(RangeError);
    expect(() =>
      serializeDhcp(bootp({ options: [{ kind: "lease-time", seconds: -1 }] })),
    ).toThrow(RangeError);
    expect(() =>
      serializeDhcp(bootp({ options: [{ kind: "lease-time", seconds: 1.5 }] })),
    ).toThrow(RangeError);
    expect(() =>
      serializeDhcp(
        bootp({ options: [{ kind: "subnet-mask", mask: "nope" }] }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      serializeDhcp(
        bootp({
          options: [{ kind: "raw", code: 300, data: new Uint8Array(1) }],
        }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      serializeDhcp(
        bootp({
          options: [{ kind: "raw", code: 1, data: new Uint8Array(256) }],
        }),
      ),
    ).toThrow(RangeError);
  });

  test("serializer zero-pads short hardware and name fields", () => {
    const message = bootp({
      chaddr: Uint8Array.from(MAC),
      sname: new Uint8Array(0),
      file: new Uint8Array(0),
    });
    const parsed = unwrap(parseDhcp(wire(message)));
    expect(parsed.chaddr).toEqual(chaddr());
    expect(parsed.sname).toEqual(new Uint8Array(DHCP_SNAME_LENGTH));
    expect(parsed.file).toEqual(new Uint8Array(DHCP_FILE_LENGTH));
    expect([...dhcpHardwareAddress(parsed)]).toEqual(MAC);
  });

  test("carries a NAK with only its message type", () => {
    const message = bootp({
      op: DHCP_OP_REPLY,
      options: [{ kind: "message-type", type: DHCP_MESSAGE_NAK }],
    });
    const parsed = unwrap(parseDhcp(wire(message)));
    expect(dhcpMessageType(parsed.options)).toBe(DHCP_MESSAGE_NAK);
    expect(dhcpFindOption(parsed.options, "server-id")).toBeUndefined();
  });
});
