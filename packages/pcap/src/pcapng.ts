/**
 * pcapng writer and reader (F-121, F-122).
 *
 * pcapng replaces the classic savefile's single global header with a stream
 * of self-describing blocks: a type, a total length, a body padded to a
 * 4-byte boundary and the same total length again. Every file starts with a
 * Section Header Block that declares its byte order, then Interface
 * Description Blocks (one per capture interface) and Enhanced Packet Blocks
 * (one per frame). The writer emits exactly those three:
 *
 * - SHB: byte-order magic, version 1.0, section length -1 (unspecified) and
 *   a `shb_userappl` option naming the producer (`netlab`).
 * - IDB: `LINKTYPE_ETHERNET`, the snaplen shared with classic pcap, an
 *   `if_name` with the link's name and `if_tsresol` 6 (microseconds), so a
 *   timestamp is the simulation clock in microseconds, stored as a 64-bit
 *   pair of 32-bit words.
 * - EPB: the interface id of the frame's link, the timestamp, the captured
 *   and original lengths, then the bytes (padded). A frame longer than
 *   {@link PCAP_SNAPLEN} is stored truncated with its real wire length, as a
 *   NIC with a snapshot length records it.
 *
 * The parser is total, like every other NetLab codec: it reads SHB, IDB and
 * EPB, skips blocks of any other type by their declared length, accepts both
 * byte orders (a section declares its own) and converts interface timestamps
 * to microseconds. Malformed input returns a typed
 * {@link PcapngParseResult} error carrying the byte offset where decoding
 * stopped and never throws — only LINKTYPE_ETHERNET interfaces are accepted,
 * because that is the only link layer the simulator speaks.
 *
 * Like `pcap.ts`, the package stays dependency-free and engine-agnostic: no
 * `@netlab/bytes` (its cursor is big-endian and pcapng is little-endian in
 * practice, so every field would need swapping anyway) and no file system.
 */

import { PCAP_LINKTYPE_ETHERNET, PCAP_SNAPLEN, PCAPNG_MAGIC } from "./pcap";

/** First block of every section: the Section Header Block. */
export const PCAPNG_SHB_TYPE = PCAPNG_MAGIC;

/** Block type of an Interface Description Block. */
export const PCAPNG_IDB_TYPE = 0x00000001;

/** Block type of an Enhanced Packet Block. */
export const PCAPNG_EPB_TYPE = 0x00000006;

/** Word that declares the byte order of the section that follows it. */
export const PCAPNG_BYTE_ORDER_MAGIC = 0x1a2b3c4d;

/** pcapng major version this package writes and accepts. */
export const PCAPNG_VERSION_MAJOR = 1;

/** pcapng minor version this package writes. */
export const PCAPNG_VERSION_MINOR = 0;

/** Bytes a block adds around its body: `type` + `length` and the repeat. */
export const PCAPNG_BLOCK_HEADER_LENGTH = 8;

/** Bytes of the repeated total length that closes every block. */
export const PCAPNG_BLOCK_TRAILER_LENGTH = 4;

/** Smallest legal block: an 8-byte header and the 4-byte repeat. */
export const PCAPNG_MIN_BLOCK_LENGTH = 12;

/** Bytes of a Section Header Block without options. */
export const PCAPNG_SHB_MIN_LENGTH = 28;

/** Bytes of an Interface Description Block without options. */
export const PCAPNG_IDB_MIN_LENGTH = 20;

/** Bytes of an Enhanced Packet Block without data or options. */
export const PCAPNG_EPB_MIN_LENGTH = 32;

/** `if_tsresol` value for microseconds: timestamps count 10^-6 seconds. */
export const PCAPNG_TSRESOL_MICROSECONDS = 6;

/** Producer name written in the section's `shb_userappl` option. */
export const PCAPNG_USER_APPLICATION = "netlab";

const US_PER_SECOND = 1_000_000;
const TWO_POW_32 = 4_294_967_296;
const MAX_U32 = 0xffffffff;

/** `opt_endofopt`: terminates the option list of a block. */
const OPT_ENDOFOPT = 0;

/** `shb_userappl`: name of the application that wrote the section. */
const OPT_SHB_USERAPPL = 4;

/** `if_name`: human-readable interface name. */
const OPT_IF_NAME = 2;

/** `if_tsresol`: timestamp resolution of an interface. */
const OPT_IF_TSRESOL = 9;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** Byte order of a section, as its byte-order magic declares it. */
export type PcapngByteOrder = "little" | "big";

/** One capture interface: the pcapng form of a link. */
export interface PcapngLink {
  /** Link id the frames refer to. Becomes the IDB position. */
  id: string;
  /** `if_name`; defaults to {@link PcapngLink.id}. */
  name?: string;
}

/** One packet to write: an interface, a simulation timestamp and bytes. */
export interface PcapngFrameInput {
  /** Simulation time in microseconds. Stored in the interface's resolution. */
  timeUs: number;
  /** Frame bytes. Longer than the snaplen is truncated on write. */
  bytes: Uint8Array;
  /** Id of the link (and so the interface) the frame was captured on. */
  link: string;
}

/** One decoded Section Header Block. */
export interface PcapngSectionHeader {
  /** Byte offset of the block in the file. */
  offset: number;
  byteOrder: PcapngByteOrder;
  versionMajor: number;
  versionMinor: number;
  /** Declared section length in bytes, or -1 when unspecified. */
  sectionLength: number;
}

/** One decoded Interface Description Block. */
export interface PcapngInterface {
  /** Interface id inside its section: the `interface_id` EPBs reference. */
  id: number;
  /** Position in {@link PcapngFile.interfaces} (unique across sections). */
  index: number;
  /** Byte offset of the IDB in the file. */
  offset: number;
  /** pcap link type. Always {@link PCAP_LINKTYPE_ETHERNET}. */
  linkType: number;
  /** Snapshot length the writer recorded; 0 means unlimited. */
  snaplen: number;
  /** `if_name`, when the block carries one. */
  name: string | undefined;
  /** Timestamp ticks per second from `if_tsresol` (default 1e6). */
  tsResolution: number;
}

/** One decoded Enhanced Packet Block. */
export interface PcapngPacket {
  /** Byte offset of the block in the file. */
  offset: number;
  /** Interface id inside its section. */
  interfaceId: number;
  /** Position of that interface in {@link PcapngFile.interfaces}. */
  interfaceIndex: number;
  /** High 32 bits of the raw timestamp. */
  timestampHigh: number;
  /** Low 32 bits of the raw timestamp. */
  timestampLow: number;
  /** Timestamp converted to microseconds with the interface resolution. */
  timeUs: number;
  /** Bytes stored in the file. */
  caplen: number;
  /** Frame size the sender reported. */
  wirelen: number;
  /** Captured bytes, a view over the parsed buffer (no copy). */
  bytes: Uint8Array;
}

/** A decoded pcapng capture. */
export interface PcapngFile {
  /** Sections in file order; a section restarts the interface numbering. */
  sections: Array<PcapngSectionHeader>;
  /** Interfaces in file order, across every section. */
  interfaces: Array<PcapngInterface>;
  /** Packets in file order. Only EPBs produce packets. */
  packets: Array<PcapngPacket>;
}

/** Why a parser refused the bytes. */
export type PcapngParseErrorCode =
  | "truncated"
  | "bad-magic"
  | "invalid-block"
  | "unsupported-version"
  | "unsupported-linktype"
  | "invalid-record"
  | "invalid";

/** Typed parse failure; `offset` is where decoding stopped. */
export interface PcapngParseError {
  code: PcapngParseErrorCode;
  message: string;
  /** Byte offset of the field (or the start of the block) that failed. */
  offset: number;
}

/** Total result of parsing untrusted capture bytes. */
export type PcapngParseResult =
  | { ok: true; value: PcapngFile }
  | { ok: false; error: PcapngParseError };

/** Thrown internally to unwind to the typed result; never escapes. */
class BlockFailure extends Error {
  readonly code: PcapngParseErrorCode;
  readonly offset: number;

  constructor(code: PcapngParseErrorCode, message: string, offset: number) {
    super(message);
    this.name = "BlockFailure";
    this.code = code;
    this.offset = offset;
  }
}

function fail(
  code: PcapngParseErrorCode,
  message: string,
  offset: number,
): never {
  throw new BlockFailure(code, message, offset);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

/** Bytes needed to round `length` up to a 4-byte boundary. */
function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

/** Bytes a block occupies given its body length (already padded). */
function blockLength(bodyLength: number): number {
  return PCAPNG_BLOCK_HEADER_LENGTH + bodyLength + PCAPNG_BLOCK_TRAILER_LENGTH;
}

function readU16(
  data: Uint8Array,
  offset: number,
  order: PcapngByteOrder,
): number {
  const first = data[offset] as number;
  const second = data[offset + 1] as number;
  return order === "little" ? first | (second << 8) : (first << 8) | second;
}

function readU32(
  data: Uint8Array,
  offset: number,
  order: PcapngByteOrder,
): number {
  const a = data[offset] as number;
  const b = data[offset + 1] as number;
  const c = data[offset + 2] as number;
  const d = data[offset + 3] as number;
  return order === "little"
    ? (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
    : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function writeU16le(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32le(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

/** One option of a block: a 16-bit code, a 16-bit length and its value. */
interface PcapngOption {
  code: number;
  value: Uint8Array;
}

/**
 * Serialize an option list, values padded to 4 bytes and terminated by
 * `opt_endofopt` (written only when the list is not empty).
 */
function optionsBytes(options: ReadonlyArray<PcapngOption>): Uint8Array {
  if (options.length === 0) {
    return new Uint8Array(0);
  }
  let length = 4; // opt_endofopt
  for (const option of options) {
    length += 4 + option.value.length + pad4(option.value.length);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const option of options) {
    writeU16le(out, offset, option.code);
    writeU16le(out, offset + 2, option.value.length);
    out.set(option.value, offset + 4);
    offset += 4 + option.value.length + pad4(option.value.length);
  }
  return out;
}

/** Section Header Block body: byte order, version, length and producer. */
function sectionHeaderBody(): Uint8Array {
  const options = optionsBytes([
    {
      code: OPT_SHB_USERAPPL,
      value: TEXT_ENCODER.encode(PCAPNG_USER_APPLICATION),
    },
  ]);
  const body = new Uint8Array(16 + options.length);
  writeU32le(body, 0, PCAPNG_BYTE_ORDER_MAGIC);
  writeU16le(body, 4, PCAPNG_VERSION_MAJOR);
  writeU16le(body, 6, PCAPNG_VERSION_MINOR);
  // Section length -1: "the section runs to the end of the file".
  body.fill(0xff, 8, 16);
  body.set(options, 16);
  return body;
}

/** Interface Description Block body for one link. */
function interfaceBody(link: PcapngLink): Uint8Array {
  const options = optionsBytes([
    {
      code: OPT_IF_NAME,
      value: TEXT_ENCODER.encode(link.name ?? link.id),
    },
    {
      code: OPT_IF_TSRESOL,
      value: Uint8Array.of(PCAPNG_TSRESOL_MICROSECONDS),
    },
  ]);
  const body = new Uint8Array(8 + options.length);
  writeU16le(body, 0, PCAP_LINKTYPE_ETHERNET);
  writeU32le(body, 4, PCAP_SNAPLEN);
  body.set(options, 8);
  return body;
}

/** Enhanced Packet Block body for one frame on one interface. */
function packetBody(frame: PcapngFrameInput, interfaceId: number): Uint8Array {
  const captured = Math.min(frame.bytes.length, PCAP_SNAPLEN);
  const { high, low } = pcapngTimestampParts(frame.timeUs);
  const body = new Uint8Array(20 + captured + pad4(captured));
  writeU32le(body, 0, interfaceId);
  writeU32le(body, 4, high);
  writeU32le(body, 8, low);
  writeU32le(body, 12, captured);
  writeU32le(body, 16, frame.bytes.length);
  body.set(frame.bytes.subarray(0, captured), 20);
  return body;
}

function writeBlock(
  out: Uint8Array,
  offset: number,
  type: number,
  body: Uint8Array,
): number {
  const total = blockLength(body.length);
  writeU32le(out, offset, type);
  writeU32le(out, offset + 4, total);
  out.set(body, offset + PCAPNG_BLOCK_HEADER_LENGTH);
  writeU32le(out, offset + PCAPNG_BLOCK_HEADER_LENGTH + body.length, total);
  return offset + total;
}

/**
 * Split a simulation timestamp into the two 32-bit words of an EPB.
 *
 * With `if_tsresol` 6 the timestamp is the clock in microseconds, so the
 * pair is just its high and low halves: `4_294_967_296 + 5` becomes
 * `{ high: 1, low: 5 }`.
 *
 * Throws `RangeError` when `timeUs` is not a non-negative integer: a writer
 * with an unrepresentable timestamp must fail loudly instead of wrapping the
 * date.
 */
export function pcapngTimestampParts(timeUs: number): {
  high: number;
  low: number;
} {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new RangeError(
      `pcapng timestamp must be a non-negative integer of microseconds: ${timeUs}`,
    );
  }
  const high = Math.floor(timeUs / TWO_POW_32);
  const low = timeUs - high * TWO_POW_32;
  return { high, low };
}

/**
 * Serialize frames as a pcapng capture.
 *
 * `links` defines the interfaces: the IDB at position `i` has interface id
 * `i`, and every frame's `link` selects one of them. Blocks follow the
 * caller's order — the writer never sorts, because only the caller knows
 * what order the wire saw (the CLI sorts `frame_tx` traces by simulation
 * time before calling this). Each EPB captures `min(bytes.length,
 * PCAP_SNAPLEN)` bytes and stores `bytes.length` as the original length; the
 * result is a copy, so later writes to the source frames do not touch the
 * capture.
 *
 * Throws `RangeError` on a capture that cannot be represented: a duplicate
 * link id, a frame whose `link` is not declared, a negative or fractional
 * timestamp, or a frame size that does not fit the 32-bit length fields.
 */
export function writePcapng(
  frames: ReadonlyArray<PcapngFrameInput>,
  links: ReadonlyArray<PcapngLink>,
): Uint8Array {
  const interfaceIds = new Map<string, number>();
  for (const link of links) {
    if (interfaceIds.has(link.id)) {
      throw new RangeError(
        `duplicate pcapng link id ${JSON.stringify(link.id)}: ` +
          "each link becomes exactly one interface",
      );
    }
    interfaceIds.set(link.id, interfaceIds.size);
  }

  const blocks: Array<{ type: number; body: Uint8Array }> = [
    { type: PCAPNG_SHB_TYPE, body: sectionHeaderBody() },
  ];
  for (const link of links) {
    blocks.push({ type: PCAPNG_IDB_TYPE, body: interfaceBody(link) });
  }
  for (const frame of frames) {
    const interfaceId = interfaceIds.get(frame.link);
    if (interfaceId === undefined) {
      throw new RangeError(
        `pcapng frame on undeclared link ${JSON.stringify(frame.link)}: ` +
          "declare the link so it has an interface",
      );
    }
    if (frame.bytes.length > MAX_U32) {
      throw new RangeError(
        `pcapng packet length does not fit in 32 bits: ${frame.bytes.length}`,
      );
    }
    pcapngTimestampParts(frame.timeUs);
    blocks.push({
      type: PCAPNG_EPB_TYPE,
      body: packetBody(frame, interfaceId),
    });
  }

  let total = 0;
  for (const block of blocks) {
    total += blockLength(block.body.length);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    offset = writeBlock(out, offset, block.type, block.body);
  }
  return out;
}

/** Byte order declared by the SHB whose body starts at `bodyStart`. */
function detectOrder(
  data: Uint8Array,
  bodyStart: number,
): PcapngByteOrder | undefined {
  if (readU32(data, bodyStart, "little") === PCAPNG_BYTE_ORDER_MAGIC) {
    return "little";
  }
  if (readU32(data, bodyStart, "big") === PCAPNG_BYTE_ORDER_MAGIC) {
    return "big";
  }
  return undefined;
}

/** Validated extent of one block; `body` is where its payload starts. */
interface BlockExtent {
  body: number;
  bodyLength: number;
}

/**
 * Validate a block's structural fields and return its body extent.
 *
 * A block lies about its own size unless the closing total length matches
 * the opening one, so both are checked before any body field is trusted.
 */
function checkBlock(
  data: Uint8Array,
  offset: number,
  totalLength: number,
  order: PcapngByteOrder,
): BlockExtent {
  if (totalLength < PCAPNG_MIN_BLOCK_LENGTH || totalLength % 4 !== 0) {
    fail(
      "invalid-block",
      `block at offset ${offset} has total length ${totalLength}: ` +
        `expected a multiple of 4 and at least ${PCAPNG_MIN_BLOCK_LENGTH}`,
      offset,
    );
  }
  if (offset + totalLength > data.length) {
    fail(
      "truncated",
      `block at offset ${offset} needs ${totalLength} byte(s), ` +
        `${data.length - offset} available`,
      offset,
    );
  }
  const trailerAt = offset + totalLength - PCAPNG_BLOCK_TRAILER_LENGTH;
  const trailer = readU32(data, trailerAt, order);
  if (trailer !== totalLength) {
    fail(
      "invalid-block",
      `block at offset ${offset} closes with length ${trailer}, ` +
        `not ${totalLength}`,
      trailerAt,
    );
  }
  return {
    body: offset + PCAPNG_BLOCK_HEADER_LENGTH,
    bodyLength:
      totalLength - PCAPNG_BLOCK_HEADER_LENGTH - PCAPNG_BLOCK_TRAILER_LENGTH,
  };
}

/** Ticks per second of an `if_tsresol` byte: 10^-n by default, 2^-n with MSB. */
function ticksPerSecond(raw: number): number {
  const exponent = raw & 0x7f;
  const ticks = raw & 0x80 ? 2 ** exponent : 10 ** exponent;
  return Number.isFinite(ticks) && ticks > 0 ? ticks : US_PER_SECOND;
}

/** Convert ticks of an interface clock to microseconds. */
function ticksToMicroseconds(ticks: number, tsResolution: number): number {
  return Math.round(ticks / (tsResolution / US_PER_SECOND));
}

/** Interface metadata carried by an IDB's option list. */
interface InterfaceOptions {
  name: string | undefined;
  tsResolution: number;
}

/**
 * Read an IDB's option list. Unknown options are skipped by their length and
 * a truncated option ends the list: options are metadata and must never cost
 * the packets that follow.
 */
function readInterfaceOptions(
  data: Uint8Array,
  start: number,
  end: number,
  order: PcapngByteOrder,
): InterfaceOptions {
  let name: string | undefined;
  let tsResolution = US_PER_SECOND;
  let at = start;
  while (at + 4 <= end) {
    const code = readU16(data, at, order);
    const length = readU16(data, at + 2, order);
    if (code === OPT_ENDOFOPT) {
      break;
    }
    const valueStart = at + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > end) {
      break;
    }
    if (code === OPT_IF_NAME) {
      name = TEXT_DECODER.decode(data.subarray(valueStart, valueEnd));
    } else if (code === OPT_IF_TSRESOL && length >= 1) {
      tsResolution = ticksPerSecond(data[valueStart] as number);
    }
    at = valueEnd + pad4(length);
  }
  return { name, tsResolution };
}

/** Read the whole capture; throws {@link BlockFailure} on bad bytes. */
function parseBlocks(data: Uint8Array): PcapngFile {
  const sections: Array<PcapngSectionHeader> = [];
  const interfaces: Array<PcapngInterface> = [];
  const packets: Array<PcapngPacket> = [];
  let sectionInterfaces: Array<PcapngInterface> = [];
  let order: PcapngByteOrder | undefined;
  let offset = 0;

  while (offset < data.length) {
    if (data.length - offset < PCAPNG_MIN_BLOCK_LENGTH) {
      fail(
        "truncated",
        `block at offset ${offset} needs a ` +
          `${PCAPNG_MIN_BLOCK_LENGTH}-byte header, ` +
          `${data.length - offset} available`,
        offset,
      );
    }
    // The first block has to be an SHB, whose type reads the same in both
    // byte orders; every later block is read in its section's order.
    const type = readU32(data, offset, order ?? "little");
    if (type === PCAPNG_SHB_TYPE) {
      if (data.length - offset < PCAPNG_SHB_MIN_LENGTH) {
        fail(
          "truncated",
          `section header at offset ${offset} needs ` +
            `${PCAPNG_SHB_MIN_LENGTH} bytes, ${data.length - offset} available`,
          offset,
        );
      }
      const declared = detectOrder(data, offset + PCAPNG_BLOCK_HEADER_LENGTH);
      if (declared === undefined) {
        fail(
          "bad-magic",
          `section header at offset ${offset} has no byte-order magic ` +
            `(${hex32(PCAPNG_BYTE_ORDER_MAGIC)})`,
          offset + PCAPNG_BLOCK_HEADER_LENGTH,
        );
      }
      order = declared;
      const totalLength = readU32(data, offset + 4, order);
      const extent = checkBlock(data, offset, totalLength, order);
      if (extent.bodyLength < 16) {
        fail(
          "invalid-block",
          `section header at offset ${offset} holds ${extent.bodyLength} ` +
            "byte(s) of body: expected the byte order, version and length",
          offset,
        );
      }
      const major = readU16(data, extent.body + 4, order);
      const minor = readU16(data, extent.body + 6, order);
      if (major !== PCAPNG_VERSION_MAJOR) {
        fail(
          "unsupported-version",
          `pcapng version ${major}.${minor}: expected major version ` +
            `${PCAPNG_VERSION_MAJOR}`,
          extent.body + 4,
        );
      }
      const sectionHigh = readU32(data, extent.body + 8, order);
      const sectionLow = readU32(data, extent.body + 12, order);
      sections.push({
        offset,
        byteOrder: order,
        versionMajor: major,
        versionMinor: minor,
        sectionLength:
          sectionHigh === MAX_U32 && sectionLow === MAX_U32
            ? -1
            : sectionHigh * TWO_POW_32 + sectionLow,
      });
      // Interface ids are section-scoped: a new section starts at zero.
      sectionInterfaces = [];
      offset += totalLength;
      continue;
    }
    if (order === undefined) {
      fail(
        "bad-magic",
        `not a pcapng capture: expected a Section Header Block at offset 0, ` +
          `got block type ${hex32(type)}`,
        0,
      );
    }
    const totalLength = readU32(data, offset + 4, order);
    const extent = checkBlock(data, offset, totalLength, order);

    if (type === PCAPNG_IDB_TYPE) {
      if (extent.bodyLength < 8) {
        fail(
          "invalid-block",
          `interface block at offset ${offset} is too short for a link type`,
          offset,
        );
      }
      const linkType = readU16(data, extent.body, order);
      if (linkType !== PCAP_LINKTYPE_ETHERNET) {
        fail(
          "unsupported-linktype",
          `interface at offset ${offset} has link type ${linkType}: only ` +
            `LINKTYPE_ETHERNET (${PCAP_LINKTYPE_ETHERNET}) is supported`,
          extent.body,
        );
      }
      const options = readInterfaceOptions(
        data,
        extent.body + 8,
        extent.body + extent.bodyLength,
        order,
      );
      const iface: PcapngInterface = {
        id: sectionInterfaces.length,
        index: interfaces.length,
        offset,
        linkType,
        snaplen: readU32(data, extent.body + 4, order),
        name: options.name,
        tsResolution: options.tsResolution,
      };
      sectionInterfaces.push(iface);
      interfaces.push(iface);
    } else if (type === PCAPNG_EPB_TYPE) {
      if (extent.bodyLength < 20) {
        fail(
          "invalid-block",
          `packet block at offset ${offset} is too short for its header`,
          offset,
        );
      }
      const interfaceId = readU32(data, extent.body, order);
      const iface = sectionInterfaces[interfaceId];
      if (iface === undefined) {
        fail(
          "invalid-record",
          `packet at offset ${offset} names interface ${interfaceId}, but ` +
            `the section declares ${sectionInterfaces.length}`,
          offset,
        );
      }
      const caplen = readU32(data, extent.body + 12, order);
      const available = extent.bodyLength - 20;
      if (caplen > available) {
        fail(
          "invalid-record",
          `packet at offset ${offset} captures ${caplen} byte(s), but its ` +
            `block holds ${available}`,
          offset,
        );
      }
      if (iface.snaplen !== 0 && caplen > iface.snaplen) {
        fail(
          "invalid-record",
          `packet at offset ${offset} captures ${caplen} byte(s), more than ` +
            `the ${iface.snaplen}-byte snaplen`,
          offset,
        );
      }
      const timestampHigh = readU32(data, extent.body + 4, order);
      const timestampLow = readU32(data, extent.body + 8, order);
      const ticks = timestampHigh * TWO_POW_32 + timestampLow;
      packets.push({
        offset,
        interfaceId,
        interfaceIndex: iface.index,
        timestampHigh,
        timestampLow,
        timeUs: ticksToMicroseconds(ticks, iface.tsResolution),
        caplen,
        wirelen: readU32(data, extent.body + 16, order),
        bytes: data.subarray(extent.body + 20, extent.body + 20 + caplen),
      });
    }
    // Blocks of any other type (statistics, name resolution, Simple Packet
    // Blocks, vendor extensions) are skipped by their length: the reader
    // reports EPB packets and ignores what it does not understand.
    offset += totalLength;
  }

  return { sections, interfaces, packets };
}

/**
 * Parse a pcapng capture. Never throws.
 *
 * The file must start with a Section Header Block; its byte-order magic
 * declares how the section's fields are encoded, and later sections may
 * declare the other order. Failures are typed and carry the offset where
 * decoding stopped: `truncated` (a block or the section header runs past the
 * end of the file), `bad-magic` (not a pcapng capture, or a section without
 * the byte-order magic), `invalid-block` (a length below 12, not a multiple
 * of 4, or a closing length that disagrees with the opening one),
 * `unsupported-version` (major other than 1), `unsupported-linktype`
 * (anything but LINKTYPE_ETHERNET), `invalid-record` (`interface_id` outside
 * the section, captured bytes overflowing the block or exceeding the
 * snaplen) and `invalid` as the catch-all.
 *
 * A file that ends cleanly between blocks parses as a shorter capture: that
 * is exactly what a capture cut at a block boundary looks like. Unknown
 * block types are skipped, and unknown or truncated IDB options are ignored.
 * Captured bytes are views over `data`; treat them as read-only.
 */
export function parsePcapng(data: Uint8Array): PcapngParseResult {
  try {
    return { ok: true, value: parseBlocks(data) };
  } catch (error) {
    if (error instanceof BlockFailure) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          offset: error.offset,
        },
      };
    }
    return {
      ok: false,
      error: { code: "invalid", message: errorMessage(error), offset: 0 },
    };
  }
}
