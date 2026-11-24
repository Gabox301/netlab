/**
 * Ethernet II framing (DIX / RFC 894 on top of the IEEE 802.3 header).
 *
 * Wire layout: `dst(6) src(6) etherType(2) payload`. Nothing here knows about
 * FCS: the frame check sequence is generated and verified by the NIC, so it
 * never appears in the `Uint8Array` this module reads or writes.
 *
 * Two framing rules matter for the rest of the stack:
 *
 * - **Minimum frame size.** A frame shorter than 60 bytes (14 header + 46
 *   payload, FCS excluded) is zero-padded on transmit. Receivers cannot tell
 *   padding from payload without an upper-layer length field, so
 *   {@link EthernetFrame.payload} keeps the padding exactly as received. IPv4
 *   and ARP parse their own length and ignore the tail.
 * - **802.1Q is out of scope.** A frame whose EtherType is `0x8100` shifts
 *   every later field by 4 bytes; parsing it as a plain Ethernet II frame
 *   would silently produce a wrong EtherType and payload, so tagged frames are
 *   rejected with `unsupported-tagged` until VLANs land.
 *
 * Parsers are total (never throw): every failure becomes a typed
 * {@link ParseError}, including `TruncatedError` escaping from `@netlab/bytes`.
 */

import {
  BufferReader,
  BufferWriter,
  MacAddress,
  TruncatedError,
} from "@netlab/bytes";

/** EtherType for IPv4 (RFC 894). */
export const ETHERTYPE_IPV4 = 0x0800;

/** EtherType for ARP (RFC 826). */
export const ETHERTYPE_ARP = 0x0806;

/** EtherType for 802.1Q VLAN-tagged frames (phase 2, rejected for now). */
export const ETHERTYPE_VLAN = 0x8100;

/** Bytes of an Ethernet II header: dst(6) + src(6) + EtherType(2). */
export const ETHERNET_HEADER_LENGTH = 14;

/** Minimum on-the-wire frame size without FCS: 14 header + 46 payload. */
export const ETHERNET_MIN_FRAME_LENGTH = 60;

/** Why a parser refused a frame. */
export type ParseError = {
  code: "truncated" | "unsupported-tagged" | "invalid";
  message: string;
};

/** Total result of parsing untrusted bytes. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ParseError };

/** Build a successful parse result. */
export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

/** Build a failed parse result. */
export function parseErr<T>(
  code: ParseError["code"],
  message: string,
): ParseResult<T> {
  return { ok: false, error: { code, message } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Decoded Ethernet II header. */
export interface EthernetHeader {
  dst: MacAddress;
  src: MacAddress;
  etherType: number;
}

/** Header plus everything after it. */
export interface EthernetFrame extends EthernetHeader {
  /**
   * Bytes after the header, exactly as received: link-layer padding is
   * included and cannot be distinguished from payload here. The array is a
   * view over the parsed buffer (no copy).
   */
  payload: Uint8Array;
}

/** Destination-MAC acceptance rules for a non-promiscuous interface. */
export interface MacFilterOptions {
  /** Accept every destination MAC. Default `false`. */
  promiscuous?: boolean;
  /** Multicast groups this interface has joined. Default none. */
  multicastGroups?: Array<MacAddress>;
}

/**
 * Parse an Ethernet II frame.
 *
 * Returns `truncated` below 14 bytes, `unsupported-tagged` for 802.1Q frames
 * and `invalid` for anything else that cannot be decoded. Never throws.
 */
export function parseEthernet(frame: Uint8Array): ParseResult<EthernetFrame> {
  if (frame.length < ETHERNET_HEADER_LENGTH) {
    return parseErr(
      "truncated",
      `Ethernet frame needs at least ${ETHERNET_HEADER_LENGTH} bytes, ` +
        `got ${frame.length}`,
    );
  }
  try {
    const reader = new BufferReader(frame);
    const dst = MacAddress.fromBytes(reader.bytes(6));
    const src = MacAddress.fromBytes(reader.bytes(6));
    const etherType = reader.u16be();
    if (etherType === ETHERTYPE_VLAN) {
      return parseErr(
        "unsupported-tagged",
        "802.1Q tagged frames (EtherType 0x8100) are not supported",
      );
    }
    const payload = reader.bytes(reader.remaining);
    return parseOk({ dst, src, etherType, payload });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `truncated Ethernet frame: ${err.message}`);
    }
    return parseErr("invalid", `invalid Ethernet frame: ${errorMessage(err)}`);
  }
}

/**
 * Serialize an Ethernet II frame.
 *
 * Writes `dst(6) src(6) etherType(u16be) payload` and zero-pads the result to
 * {@link ETHERNET_MIN_FRAME_LENGTH} bytes when it is shorter. No FCS is
 * appended: that belongs to the NIC.
 */
export function serializeEthernet(
  header: EthernetHeader,
  payload: Uint8Array,
): Uint8Array {
  const writer = new BufferWriter(ETHERNET_HEADER_LENGTH + payload.length);
  writer.bytes(header.dst.toBytes());
  writer.bytes(header.src.toBytes());
  writer.u16be(header.etherType);
  writer.bytes(payload);
  const frame = writer.toBytes();
  if (frame.length >= ETHERNET_MIN_FRAME_LENGTH) {
    return frame;
  }
  const padded = new Uint8Array(ETHERNET_MIN_FRAME_LENGTH);
  padded.set(frame);
  return padded;
}

/**
 * Decide whether an interface should hand this frame to the stack.
 *
 * Order of the rules: promiscuous mode accepts everything; broadcast is
 * always accepted; a unicast destination is accepted only when it is `own`;
 * a multicast destination is accepted only when it appears in
 * `multicastGroups`.
 */
export function shouldAccept(
  own: MacAddress,
  header: EthernetHeader,
  opts?: MacFilterOptions,
): boolean {
  if (opts?.promiscuous === true) {
    return true;
  }
  const dst = header.dst;
  if (dst.isBroadcast() || dst.equals(own)) {
    return true;
  }
  if (dst.isMulticast()) {
    return (opts?.multicastGroups ?? []).some((group) => group.equals(dst));
  }
  return false;
}
