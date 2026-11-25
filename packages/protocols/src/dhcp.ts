/**
 * DHCP messages (RFC 2131 on top of BOOTP, options per RFC 2132).
 *
 * A message is the 236-byte BOOTP body (`op htype hlen hops`, `xid secs
 * flags`, the four addresses, the 16-byte `chaddr`, `sname` and `file`), the
 * four-byte magic cookie `0x63825363` and a TLV option area closed by an
 * `end` option. `chaddr`, `sname` and `file` keep their fixed widths, so a
 * parsed message always carries exactly 16 / 64 / 128 bytes; the serializer
 * zero-pads shorter input.
 *
 * Options are typed for the codes the simulator needs — subnet mask, router,
 * DNS, requested address, lease time, message type and server identifier —
 * and every other code keeps its RDATA opaque (`kind: "raw"`) so it survives
 * a round-trip. `pad` bytes are alignment filler and carry no information, so
 * parsing skips them and serializing never emits them.
 *
 * Like every NetLab codec, the parser is total: it never throws. Failures are
 * typed `ParseResult` errors — `invalid` for a bad cookie or a known option
 * with the wrong length, `truncated` when a declared field or TLV overruns
 * the buffer.
 */

import {
  BufferReader,
  BufferWriter,
  Ipv4Address,
  TruncatedError,
} from "@netlab/bytes";
import { type ParseResult, parseErr, parseOk } from "./ethernet";

/** Bytes of the fixed BOOTP body: everything before the magic cookie. */
export const DHCP_FIXED_LENGTH = 236;

/** Bytes of the magic cookie that separates the body from the options. */
export const DHCP_COOKIE_LENGTH = 4;

/** Offset of the first option byte: right after the magic cookie. */
export const DHCP_OPTIONS_OFFSET = DHCP_FIXED_LENGTH + DHCP_COOKIE_LENGTH;

/** Smallest valid message: BOOTP body, cookie and one `end` option. */
export const DHCP_MIN_MESSAGE_LENGTH = DHCP_OPTIONS_OFFSET + 1;

/** Magic cookie identifying DHCP options (RFC 2131 §3). */
export const DHCP_MAGIC_COOKIE = 0x63825363;

/** Width of the client hardware address field. */
export const DHCP_CHADDR_LENGTH = 16;

/** Width of the server name field. */
export const DHCP_SNAME_LENGTH = 64;

/** Width of the boot file name field. */
export const DHCP_FILE_LENGTH = 128;

/** `op` of a client-to-server message (BOOTREQUEST). */
export const DHCP_OP_REQUEST = 1;

/** `op` of a server-to-client message (BOOTREPLY). */
export const DHCP_OP_REPLY = 2;

/** `htype` of an Ethernet client. */
export const DHCP_HTYPE_ETHERNET = 1;

/** `hlen` of an Ethernet hardware address. */
export const DHCP_HLEN_ETHERNET = 6;

/** Set in `flags` when the client cannot receive unicast replies. */
export const DHCP_BROADCAST_FLAG = 0x8000;

/** Server port (RFC 2131 §4.2). */
export const DHCP_SERVER_PORT = 67;

/** Client port (RFC 2131 §4.2). */
export const DHCP_CLIENT_PORT = 68;

/** Option code: alignment filler, skipped by the parser. */
export const DHCP_OPTION_PAD = 0;

/** Option code: subnet mask (4 bytes). */
export const DHCP_OPTION_SUBNET_MASK = 1;

/** Option code: default gateway list (4 bytes per router). */
export const DHCP_OPTION_ROUTER = 3;

/** Option code: DNS server list (4 bytes per server). */
export const DHCP_OPTION_DNS = 6;

/** Option code: the address the client asks for (4 bytes). */
export const DHCP_OPTION_REQUESTED_IP = 50;

/** Option code: lease duration in seconds (4 bytes). */
export const DHCP_OPTION_LEASE_TIME = 51;

/** Option code: message type (1 byte). */
export const DHCP_OPTION_MESSAGE_TYPE = 53;

/** Option code: server identifier (4 bytes). */
export const DHCP_OPTION_SERVER_ID = 54;

/** Option code: last option of the message. */
export const DHCP_OPTION_END = 255;

/** DHCPDISCOVER: client broadcast looking for a server. */
export const DHCP_MESSAGE_DISCOVER = 1;

/** DHCPOFFER: server proposes an address. */
export const DHCP_MESSAGE_OFFER = 2;

/** DHCPREQUEST: client accepts one offer. */
export const DHCP_MESSAGE_REQUEST = 3;

/** DHCPACK: server confirms the lease. */
export const DHCP_MESSAGE_ACK = 5;

/** DHCPNAK: server refuses the requested address. */
export const DHCP_MESSAGE_NAK = 6;

/**
 * One decoded option.
 *
 * `mask`, `ip`, `id` and the list entries are dotted-decimal strings, matching
 * how the rest of the stack speaks about addresses.
 */
export type DhcpOption =
  | { kind: "subnet-mask"; mask: string }
  | { kind: "router"; routers: string[] }
  | { kind: "dns"; servers: string[] }
  | { kind: "requested-ip"; ip: string }
  | { kind: "lease-time"; seconds: number }
  | { kind: "message-type"; type: number }
  | { kind: "server-id"; id: string }
  | { kind: "raw"; code: number; data: Uint8Array };

/** A decoded DHCP message. */
export interface DhcpMessage {
  /** 1 = BOOTREQUEST (client), 2 = BOOTREPLY (server). */
  op: number;
  /** Hardware type; 1 is Ethernet. */
  htype: number;
  /** Hardware address length; 6 for Ethernet. */
  hlen: number;
  /** Relay hop count. */
  hops: number;
  /** Transaction identifier binding requests to replies. */
  xid: number;
  /** Seconds elapsed since the client started trying. */
  secs: number;
  /** Flags, bit 15 = broadcast. */
  flags: number;
  /** Client address (already bound), dotted decimal. */
  ciaddr: string;
  /** Address the server is offering / assigning. */
  yiaddr: string;
  /** Next server (usually the DHCP server itself) address. */
  siaddr: string;
  /** Relay (gateway) address. */
  giaddr: string;
  /** Client hardware address, always {@link DHCP_CHADDR_LENGTH} bytes. */
  chaddr: Uint8Array;
  /** Server name, always {@link DHCP_SNAME_LENGTH} bytes. */
  sname: Uint8Array;
  /** Boot file name, always {@link DHCP_FILE_LENGTH} bytes. */
  file: Uint8Array;
  /** Decoded options, in wire order, without pads and without `end`. */
  options: DhcpOption[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkByte(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be a byte 0..255: ${value}`);
  }
  return value;
}

function checkU16(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be 0..65535: ${value}`);
  }
  return value;
}

function checkU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be 0..4294967295: ${value}`);
  }
  return value;
}

function parseAddress(name: string, text: string): Ipv4Address {
  try {
    return Ipv4Address.parse(text);
  } catch (err) {
    throw new RangeError(
      `${name} has an invalid IPv4 address: ${errorMessage(err)}`,
    );
  }
}

/** Zero-pad (never truncate) `data` to `width`, or throw RangeError. */
function fixedField(name: string, data: Uint8Array, width: number): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new RangeError(`${name} must be a Uint8Array`);
  }
  if (data.length > width) {
    throw new RangeError(
      `${name} must be at most ${width} bytes: ${data.length}`,
    );
  }
  const out = new Uint8Array(width);
  out.set(data);
  return out;
}

function readAddress(reader: BufferReader): string {
  return Ipv4Address.fromBytes(reader.bytes(4)).toString();
}

/** Split `data` into 4-byte addresses; throws on a bad length. */
function readAddresses(name: string, data: Uint8Array): string[] {
  if (data.length === 0 || data.length % 4 !== 0) {
    throw new Error(
      `${name} option must carry 4-byte addresses, got ${data.length} bytes`,
    );
  }
  const addresses: string[] = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    addresses.push(Ipv4Address.fromBytes(data, offset).toString());
  }
  return addresses;
}

function decodeOption(code: number, data: Uint8Array): DhcpOption {
  switch (code) {
    case DHCP_OPTION_SUBNET_MASK:
      if (data.length !== 4) {
        throw new Error(
          `subnet-mask option must be 4 bytes, got ${data.length}`,
        );
      }
      return {
        kind: "subnet-mask",
        mask: Ipv4Address.fromBytes(data).toString(),
      };
    case DHCP_OPTION_ROUTER:
      return { kind: "router", routers: readAddresses("router", data) };
    case DHCP_OPTION_DNS:
      return { kind: "dns", servers: readAddresses("dns", data) };
    case DHCP_OPTION_REQUESTED_IP:
      if (data.length !== 4) {
        throw new Error(
          `requested-ip option must be 4 bytes, got ${data.length}`,
        );
      }
      return {
        kind: "requested-ip",
        ip: Ipv4Address.fromBytes(data).toString(),
      };
    case DHCP_OPTION_LEASE_TIME:
      if (data.length !== 4) {
        throw new Error(
          `lease-time option must be 4 bytes, got ${data.length}`,
        );
      }
      return {
        kind: "lease-time",
        seconds: new BufferReader(data).u32be(),
      };
    case DHCP_OPTION_MESSAGE_TYPE:
      if (data.length !== 1) {
        throw new Error(
          `message-type option must be 1 byte, got ${data.length}`,
        );
      }
      return { kind: "message-type", type: data[0] as number };
    case DHCP_OPTION_SERVER_ID:
      if (data.length !== 4) {
        throw new Error(`server-id option must be 4 bytes, got ${data.length}`);
      }
      return { kind: "server-id", id: Ipv4Address.fromBytes(data).toString() };
    default:
      return { kind: "raw", code, data };
  }
}

/**
 * Parse one DHCP message.
 *
 * `truncated` below the smallest valid message or when a declared field or
 * TLV overruns the buffer; `invalid` for a bad magic cookie, an oversized
 * `hlen`, or a known option carrying the wrong length. Never throws.
 */
export function parseDhcp(data: Uint8Array): ParseResult<DhcpMessage> {
  if (data.length < DHCP_MIN_MESSAGE_LENGTH) {
    return parseErr(
      "truncated",
      `dhcp message needs at least ${DHCP_MIN_MESSAGE_LENGTH} bytes, ` +
        `got ${data.length}`,
    );
  }
  try {
    const reader = new BufferReader(data);
    const op = reader.u8();
    const htype = reader.u8();
    const hlen = reader.u8();
    const hops = reader.u8();
    const xid = reader.u32be();
    const secs = reader.u16be();
    const flags = reader.u16be();
    const ciaddr = readAddress(reader);
    const yiaddr = readAddress(reader);
    const siaddr = readAddress(reader);
    const giaddr = readAddress(reader);
    if (hlen > DHCP_CHADDR_LENGTH) {
      return parseErr(
        "invalid",
        `hlen must be at most ${DHCP_CHADDR_LENGTH}, got ${hlen}`,
      );
    }
    const chaddr = reader.bytes(DHCP_CHADDR_LENGTH).slice();
    const sname = reader.bytes(DHCP_SNAME_LENGTH).slice();
    const file = reader.bytes(DHCP_FILE_LENGTH).slice();
    if (reader.u32be() !== DHCP_MAGIC_COOKIE) {
      return parseErr(
        "invalid",
        `bad magic cookie: expected 0x${DHCP_MAGIC_COOKIE.toString(16)}`,
      );
    }

    const options: DhcpOption[] = [];
    while (reader.remaining > 0) {
      const code = reader.u8();
      if (code === DHCP_OPTION_PAD) {
        continue;
      }
      if (code === DHCP_OPTION_END) {
        break;
      }
      const length = reader.u8();
      const value = reader.bytes(length).slice();
      options.push(decodeOption(code, value));
    }

    return parseOk({
      op,
      htype,
      hlen,
      hops,
      xid,
      secs,
      flags,
      ciaddr,
      yiaddr,
      siaddr,
      giaddr,
      chaddr,
      sname,
      file,
      options,
    });
  } catch (err) {
    const code = err instanceof TruncatedError ? "truncated" : "invalid";
    return parseErr(code, `dhcp ${errorMessage(err)}`);
  }
}

function writeAddress(writer: BufferWriter, name: string, text: string): void {
  writer.bytes(parseAddress(name, text).toBytes());
}

function optionBytes(option: DhcpOption): {
  code: number;
  data: Uint8Array;
} {
  switch (option.kind) {
    case "subnet-mask":
      return {
        code: DHCP_OPTION_SUBNET_MASK,
        data: parseAddress("subnet-mask", option.mask).toBytes(),
      };
    case "router":
      return {
        code: DHCP_OPTION_ROUTER,
        data: addressList("router", option.routers),
      };
    case "dns":
      return {
        code: DHCP_OPTION_DNS,
        data: addressList("dns", option.servers),
      };
    case "requested-ip":
      return {
        code: DHCP_OPTION_REQUESTED_IP,
        data: parseAddress("requested-ip", option.ip).toBytes(),
      };
    case "lease-time": {
      const data = new BufferWriter(4);
      data.u32be(checkU32("lease-time", option.seconds));
      return { code: DHCP_OPTION_LEASE_TIME, data: data.toBytes() };
    }
    case "message-type":
      return {
        code: DHCP_OPTION_MESSAGE_TYPE,
        data: Uint8Array.of(checkByte("message-type", option.type)),
      };
    case "server-id":
      return {
        code: DHCP_OPTION_SERVER_ID,
        data: parseAddress("server-id", option.id).toBytes(),
      };
    case "raw": {
      if (
        !Number.isInteger(option.code) ||
        option.code <= DHCP_OPTION_PAD ||
        option.code >= DHCP_OPTION_END
      ) {
        throw new RangeError(`raw option code must be 1..254: ${option.code}`);
      }
      if (!(option.data instanceof Uint8Array)) {
        throw new RangeError("raw option data must be a Uint8Array");
      }
      if (option.data.length > 0xff) {
        throw new RangeError(
          `raw option data must be at most 255 bytes: ${option.data.length}`,
        );
      }
      return { code: option.code, data: option.data };
    }
    default: {
      const unknown: never = option;
      throw new RangeError(`unknown dhcp option: ${JSON.stringify(unknown)}`);
    }
  }
}

function addressList(name: string, text: readonly string[]): Uint8Array {
  if (text.length === 0) {
    throw new RangeError(`${name} option needs at least one address`);
  }
  const bytes = new Uint8Array(text.length * 4);
  text.forEach((entry, index) => {
    bytes.set(parseAddress(name, entry).toBytes(), index * 4);
  });
  return bytes;
}

/**
 * Serialize one DHCP message.
 *
 * Throws `RangeError` on out-of-range scalars, invalid addresses, an
 * oversized `chaddr` / `sname` / `file` or a malformed option. Shorter fixed
 * fields are zero-padded; the message always ends with one `end` option.
 */
export function serializeDhcp(message: DhcpMessage): Uint8Array {
  const writer = new BufferWriter(DHCP_MIN_MESSAGE_LENGTH + 32);
  writer.u8(checkByte("op", message.op));
  writer.u8(checkByte("htype", message.htype));
  writer.u8(checkByte("hlen", message.hlen));
  writer.u8(checkByte("hops", message.hops));
  writer.u32be(checkU32("xid", message.xid));
  writer.u16be(checkU16("secs", message.secs));
  writer.u16be(checkU16("flags", message.flags));
  writeAddress(writer, "ciaddr", message.ciaddr);
  writeAddress(writer, "yiaddr", message.yiaddr);
  writeAddress(writer, "siaddr", message.siaddr);
  writeAddress(writer, "giaddr", message.giaddr);
  writer.bytes(fixedField("chaddr", message.chaddr, DHCP_CHADDR_LENGTH));
  writer.bytes(fixedField("sname", message.sname, DHCP_SNAME_LENGTH));
  writer.bytes(fixedField("file", message.file, DHCP_FILE_LENGTH));
  writer.u32be(DHCP_MAGIC_COOKIE);

  for (const option of message.options) {
    const { code, data } = optionBytes(option);
    writer.u8(code);
    writer.u8(data.length);
    writer.bytes(data);
  }
  writer.u8(DHCP_OPTION_END);
  return writer.toBytes();
}

/** First option of the given kind, or undefined. */
export function dhcpFindOption<K extends DhcpOption["kind"]>(
  options: readonly DhcpOption[],
  kind: K,
): Extract<DhcpOption, { kind: K }> | undefined {
  for (const option of options) {
    if (option.kind === kind) {
      return option as Extract<DhcpOption, { kind: K }>;
    }
  }
  return undefined;
}

/** The `message-type` option as a number, or undefined when absent. */
export function dhcpMessageType(
  options: readonly DhcpOption[],
): number | undefined {
  return dhcpFindOption(options, "message-type")?.type;
}

/** The client hardware address, trimmed to `hlen` bytes. */
export function dhcpHardwareAddress(message: DhcpMessage): Uint8Array {
  const length = Math.min(Math.max(message.hlen, 0), DHCP_CHADDR_LENGTH);
  return message.chaddr.slice(0, length);
}
