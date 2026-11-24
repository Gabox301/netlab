/**
 * IEEE 802.1Q VLAN tags (F-17, S1/S2/S5).
 *
 * A tagged frame inserts four bytes between the source MAC and the EtherType:
 *
 *     dst(6) src(6) TPID=0x8100(2) TCI(2) innerType(2) payload
 *
 * The tag control information field packs `PCP(3) | DEI(1) | VID(12)`. The
 * TPID is itself an EtherType, which is why a strict Ethernet II parser
 * cannot see past it: `parseEthernet()` keeps refusing `0x8100` with
 * `unsupported-tagged` (S2) and hosts never accept tags. Everything in this
 * module is opt-in, used by switches and by callers that ask for it.
 *
 * Scope is one tag per frame (S4: no QinQ). When a frame carries a second
 * tag, these parsers stop after the first one and hand the remaining bytes
 * over as payload: the extra tag is never stripped, rejected or interpreted.
 *
 * Parsers are total (never throw): every failure becomes a typed
 * `ParseError`. Serializers validate their arguments and throw `RangeError`
 * on programmer error, like the rest of the codecs in this package.
 */

import {
  BufferReader,
  BufferWriter,
  MacAddress,
  TruncatedError,
} from "@netlab/bytes";
import {
  ETHERNET_HEADER_LENGTH,
  ETHERNET_MIN_FRAME_LENGTH,
  ETHERTYPE_VLAN,
  type EthernetFrame,
  type EthernetHeader,
  type ParseResult,
  parseErr,
  parseOk,
} from "./ethernet";

/** Tag protocol identifier of 802.1Q, same value as `ETHERTYPE_VLAN`. */
export const VLAN_TPID = ETHERTYPE_VLAN;

/** Bytes in the tag control information field (PCP + DEI + VID). */
export const VLAN_TCI_LENGTH = 2;

/** Bytes a tag adds to an Ethernet frame: TPID(2) + TCI(2). */
export const VLAN_TAG_LENGTH = 4;

/** Bytes of an 802.1Q header: dst(6) + src(6) + TPID(2) + TCI(2). */
export const VLAN_HEADER_LENGTH = ETHERNET_HEADER_LENGTH + VLAN_TAG_LENGTH;

/** Smallest 802.1Q frame without FCS: 18 header + 46 payload. */
export const VLAN_MIN_FRAME_LENGTH =
  ETHERNET_MIN_FRAME_LENGTH + VLAN_TAG_LENGTH;

/** Largest value the 12-bit VID field can carry. */
export const VLAN_VID_MAX = 0x0fff;

/** Smallest usable VLAN id: 0 is the priority-tagging placeholder. */
export const VLAN_ID_MIN = 1;

/** Largest usable VLAN id: 4095 is reserved. */
export const VLAN_ID_MAX = VLAN_VID_MAX - 1;

/** Largest priority code point. */
export const VLAN_PCP_MAX = 7;

/** Decoded tag control information. */
export interface VlanTag {
  /** Priority code point, 0-7. Higher wins when queues compete. */
  pcp: number;
  /** Drop eligible indicator, 0 or 1. */
  dei: 0 | 1;
  /** VLAN identifier, 0-4095. */
  vid: number;
}

/** Ethernet header plus the tag that came with it. */
export interface TaggedEthernetHeader extends EthernetHeader {
  vlan: VlanTag;
}

/** Frame that carried exactly one 802.1Q tag. */
export interface VlanFrame extends EthernetFrame {
  /** Tag consumed by the parser; never part of `payload`. */
  vlan: VlanTag;
}

/** Frame plus the tag it carried, for callers that accept both shapes. */
export interface VlanAwareEthernetFrame extends EthernetFrame {
  /** Present only when the frame carried an 802.1Q tag. */
  vlan?: VlanTag;
}

/** True for ids a port may be configured with: integers in [1, 4094]. */
export function isVlanId(value: number): boolean {
  return (
    Number.isInteger(value) && value >= VLAN_ID_MIN && value <= VLAN_ID_MAX
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hex16(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

/** Split a TCI word into its three fields. */
function tagFromTci(tci: number): VlanTag {
  return {
    pcp: (tci >> 13) & 0x07,
    dei: ((tci >> 12) & 0x01) as 0 | 1,
    vid: tci & VLAN_VID_MAX,
  };
}

/** Pack a tag, validating every field. Throws `RangeError` when invalid. */
function tciFromTag(tag: VlanTag): number {
  const { pcp, dei, vid } = tag;
  if (!Number.isInteger(pcp) || pcp < 0 || pcp > VLAN_PCP_MAX) {
    throw new RangeError(`pcp must be an integer in [0, 7]: ${pcp}`);
  }
  if (dei !== 0 && dei !== 1) {
    throw new RangeError(`dei must be 0 or 1: ${dei}`);
  }
  if (!Number.isInteger(vid) || vid < 0 || vid > VLAN_VID_MAX) {
    throw new RangeError(`vid must be an integer in [0, 4095]: ${vid}`);
  }
  return (pcp << 13) | (dei << 12) | vid;
}

/**
 * Parse the two-byte TCI field of an 802.1Q tag.
 *
 * Extra trailing bytes are ignored: the caller decides where the field ends.
 * Returns `truncated` below two bytes. Never throws.
 */
export function parseVlanTag(tci: Uint8Array): ParseResult<VlanTag> {
  if (tci.length < VLAN_TCI_LENGTH) {
    return parseErr(
      "truncated",
      `802.1Q tag control information needs ${VLAN_TCI_LENGTH} bytes, ` +
        `got ${tci.length}`,
    );
  }
  const value = ((tci[0] as number) << 8) | (tci[1] as number);
  return parseOk(tagFromTci(value));
}

/** Serialize a tag as its two-byte TCI field (big-endian). */
export function serializeVlanTag(tag: VlanTag): Uint8Array {
  const writer = new BufferWriter(VLAN_TCI_LENGTH);
  writer.u16be(tciFromTag(tag));
  return writer.toBytes();
}

function decode(
  frame: Uint8Array,
  requireTag: boolean,
): ParseResult<VlanAwareEthernetFrame> {
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
    if (etherType !== VLAN_TPID) {
      if (requireTag) {
        return parseErr(
          "invalid",
          `expected an 802.1Q tag (TPID ${hex16(VLAN_TPID)}), ` +
            `got EtherType ${hex16(etherType)}`,
        );
      }
      return parseOk({
        dst,
        src,
        etherType,
        payload: reader.bytes(reader.remaining),
      });
    }
    // TPID + TCI + inner EtherType: a tag needs six bytes after the header.
    if (frame.length < VLAN_HEADER_LENGTH) {
      return parseErr(
        "truncated",
        `802.1Q tagged frame needs at least ${VLAN_HEADER_LENGTH} bytes, ` +
          `got ${frame.length}`,
      );
    }
    const vlan = tagFromTci(reader.u16be());
    const innerType = reader.u16be();
    const payload = reader.bytes(reader.remaining);
    return parseOk({ dst, src, etherType: innerType, payload, vlan });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `truncated frame: ${err.message}`);
    }
    return parseErr("invalid", `invalid Ethernet frame: ${errorMessage(err)}`);
  }
}

/**
 * Parse a frame that must carry exactly one 802.1Q tag.
 *
 * `etherType` is the inner EtherType and `payload` starts after it, so the
 * tag never leaks into upper layers. Untagged frames are `invalid`, short
 * ones `truncated`. Never throws.
 */
export function parseTaggedEthernet(frame: Uint8Array): ParseResult<VlanFrame> {
  const result = decode(frame, true);
  if (!result.ok) {
    return result;
  }
  const { dst, src, etherType, payload, vlan } = result.value;
  if (vlan === undefined) {
    return parseErr(
      "invalid",
      `expected an 802.1Q tag (TPID ${hex16(VLAN_TPID)})`,
    );
  }
  return parseOk({ dst, src, etherType, payload, vlan });
}

/**
 * Parse a frame that may or may not carry one 802.1Q tag.
 *
 * Untagged frames come back exactly as {@link parseEthernet} would return
 * them, with no `vlan` property at all. Tagged frames expose the tag and
 * keep the inner EtherType and payload. Never throws.
 */
export function parseEthernetWithVlan(
  frame: Uint8Array,
): ParseResult<VlanAwareEthernetFrame> {
  return decode(frame, false);
}

/**
 * Serialize an 802.1Q frame.
 *
 * Writes `dst(6) src(6) TPID(u16be) TCI(u16be) etherType(u16be) payload` and
 * zero-pads to {@link VLAN_MIN_FRAME_LENGTH} bytes when shorter. No FCS: that
 * belongs to the NIC. The payload is copied, never aliased.
 */
export function serializeTaggedEthernet(
  header: TaggedEthernetHeader,
  payload: Uint8Array,
): Uint8Array {
  const tci = tciFromTag(header.vlan);
  const writer = new BufferWriter(VLAN_HEADER_LENGTH + payload.length);
  writer.bytes(header.dst.toBytes());
  writer.bytes(header.src.toBytes());
  writer.u16be(VLAN_TPID);
  writer.u16be(tci);
  writer.u16be(header.etherType);
  writer.bytes(payload);
  const frame = writer.toBytes();
  if (frame.length >= VLAN_MIN_FRAME_LENGTH) {
    return frame;
  }
  const padded = new Uint8Array(VLAN_MIN_FRAME_LENGTH);
  padded.set(frame);
  return padded;
}
