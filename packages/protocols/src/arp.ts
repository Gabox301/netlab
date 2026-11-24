/**
 * ARP for Ethernet/IPv4 (RFC 826).
 *
 * The 28-byte payload is: `htype(2) ptype(2) hlen(1) plen(1) oper(2)
 * senderMac(6) senderIp(4) targetMac(6) targetIp(4)`, all big-endian.
 * Only the single shape the stack actually emits is accepted: hardware type
 * Ethernet (1), protocol type IPv4 (`0x0800`), 6-byte hardware addresses and
 * 4-byte protocol addresses. Anything else is a typed `invalid` error rather
 * than a silently misinterpreted packet.
 *
 * ARP rides inside an Ethernet payload that may be zero-padded to the 60-byte
 * minimum, so trailing bytes after the 28th are ignored. Like
 * {@link parseEthernet}, the parser never throws.
 */

import {
  BufferReader,
  BufferWriter,
  Ipv4Address,
  MacAddress,
  TruncatedError,
} from "@netlab/bytes";
import { type ParseResult, parseErr, parseOk } from "./ethernet";

/** ARP hardware type for Ethernet (10 Mb/s and later). */
export const ARP_HTYPE_ETHERNET = 1;

/** ARP protocol type for IPv4. */
export const ARP_PTYPE_IPV4 = 0x0800;

/** ARP operation: request. */
export const ARP_OP_REQUEST = 1;

/** ARP operation: reply. */
export const ARP_OP_REPLY = 2;

/** Hardware address length for Ethernet (MAC-48). */
export const ARP_HARDWARE_ADDRESS_LENGTH = 6;

/** Protocol address length for IPv4. */
export const ARP_PROTOCOL_ADDRESS_LENGTH = 4;

/** Bytes of an Ethernet/IPv4 ARP packet. */
export const ARP_PACKET_LENGTH = 28;

/** A decoded Ethernet/IPv4 ARP request or reply. */
export interface ArpPacket {
  /** Operation code: {@link ARP_OP_REQUEST} or {@link ARP_OP_REPLY}. */
  oper: number;
  senderMac: MacAddress;
  senderIp: Ipv4Address;
  /** All zeros in a request for the address being looked up. */
  targetMac: MacAddress;
  targetIp: Ipv4Address;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse an Ethernet/IPv4 ARP packet.
 *
 * `truncated` below 28 bytes; `invalid` for a non-Ethernet hardware type, a
 * non-IPv4 protocol type, wrong address lengths or an operation other than
 * request/reply. Trailing bytes (Ethernet padding) are ignored and the parser
 * never throws.
 */
export function parseArp(data: Uint8Array): ParseResult<ArpPacket> {
  if (data.length < ARP_PACKET_LENGTH) {
    return parseErr(
      "truncated",
      `ARP packet needs at least ${ARP_PACKET_LENGTH} bytes, got ${data.length}`,
    );
  }
  try {
    const reader = new BufferReader(data);
    const htype = reader.u16be();
    const ptype = reader.u16be();
    const hlen = reader.u8();
    const plen = reader.u8();
    const oper = reader.u16be();
    if (htype !== ARP_HTYPE_ETHERNET) {
      return parseErr(
        "invalid",
        `unsupported ARP hardware type: ${htype} (only Ethernet, ` +
          `${ARP_HTYPE_ETHERNET})`,
      );
    }
    if (ptype !== ARP_PTYPE_IPV4) {
      return parseErr(
        "invalid",
        `unsupported ARP protocol type: 0x${ptype
          .toString(16)
          .padStart(4, "0")} (only IPv4, 0x0800)`,
      );
    }
    if (hlen !== ARP_HARDWARE_ADDRESS_LENGTH) {
      return parseErr(
        "invalid",
        `unsupported ARP hardware address length: ${hlen} (only ` +
          `${ARP_HARDWARE_ADDRESS_LENGTH})`,
      );
    }
    if (plen !== ARP_PROTOCOL_ADDRESS_LENGTH) {
      return parseErr(
        "invalid",
        `unsupported ARP protocol address length: ${plen} (only ` +
          `${ARP_PROTOCOL_ADDRESS_LENGTH})`,
      );
    }
    if (oper !== ARP_OP_REQUEST && oper !== ARP_OP_REPLY) {
      return parseErr(
        "invalid",
        `unsupported ARP operation: ${oper} (only request 1 / reply 2)`,
      );
    }
    const senderMac = MacAddress.fromBytes(reader.bytes(6));
    const senderIp = Ipv4Address.fromBytes(reader.bytes(4));
    const targetMac = MacAddress.fromBytes(reader.bytes(6));
    const targetIp = Ipv4Address.fromBytes(reader.bytes(4));
    return parseOk({ oper, senderMac, senderIp, targetMac, targetIp });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `truncated ARP packet: ${err.message}`);
    }
    return parseErr("invalid", `invalid ARP packet: ${errorMessage(err)}`);
  }
}

/**
 * Serialize an Ethernet/IPv4 ARP packet.
 *
 * Always 28 bytes, big-endian. `oper` is written as given; the stack builds
 * packets from {@link ARP_OP_REQUEST} and {@link ARP_OP_REPLY}.
 */
export function serializeArp(p: ArpPacket): Uint8Array {
  const writer = new BufferWriter(ARP_PACKET_LENGTH);
  writer.u16be(ARP_HTYPE_ETHERNET);
  writer.u16be(ARP_PTYPE_IPV4);
  writer.u8(ARP_HARDWARE_ADDRESS_LENGTH);
  writer.u8(ARP_PROTOCOL_ADDRESS_LENGTH);
  writer.u16be(p.oper);
  writer.bytes(p.senderMac.toBytes());
  writer.bytes(p.senderIp.toBytes());
  writer.bytes(p.targetMac.toBytes());
  writer.bytes(p.targetIp.toBytes());
  return writer.toBytes();
}
