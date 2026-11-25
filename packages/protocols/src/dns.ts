/**
 * DNS messages (RFC 1035) for the NetLab stack.
 *
 * A message is the 12-byte header (ID, flags, section counts), a question
 * section and up to three resource-record sections. This codec implements
 * the minimum the simulator needs: A records (TYPE 1) are decoded to their
 * dotted-decimal address, every other RR type keeps its RDATA opaque so it
 * round-trips byte-for-byte.
 *
 * Names may be compressed with pointers (RFC 1035 §4.1.4). Decoding accepts
 * them anywhere a name appears and rejects loops; encoding of responses uses
 * a pointer to the question name for repeated owner names. Like every NetLab
 * codec, the parser is total: it never throws.
 */

import {
  BufferReader,
  BufferWriter,
  Ipv4Address,
  TruncatedError,
} from "@netlab/bytes";
import { type ParseResult, parseErr, parseOk } from "./ethernet";

/** Bytes of a DNS header: ID, flags, QDCOUNT, ANCOUNT, NSCOUNT, ARCOUNT. */
export const DNS_HEADER_LENGTH = 12;

/** Maximum wire length of a name, including its terminating zero byte. */
export const DNS_MAX_NAME_LENGTH = 255;

/** Maximum length of one label. */
export const DNS_MAX_LABEL_LENGTH = 63;

/** Internet class (IN). */
export const DNS_CLASS_IN = 1;

/** IPv4 address record (A). */
export const DNS_TYPE_A = 1;

/** No DNS error. */
export const DNS_RCODE_NOERROR = 0;

/** The name queried does not exist. */
export const DNS_RCODE_NXDOMAIN = 3;

const FLAG_QR = 0x8000;
const FLAG_AA = 0x0400;
const FLAG_TC = 0x0200;
const FLAG_RD = 0x0100;
const FLAG_RA = 0x0080;
const POINTER_MASK = 0xc0;
const POINTER_TARGET_MASK = 0x3f;
const MAX_POINTER_JUMPS = 128;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function checkCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be a 16-bit count: ${value}`);
  }
  return value;
}

function checkNibble(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0x0f) {
    throw new RangeError(`${name} must be 0..15: ${value}`);
  }
  return value;
}

/** Decoded header flags. */
export interface DnsFlags {
  /** Query (false) or response (true). */
  qr: boolean;
  /** Operation code; 0 is a standard query. */
  opcode: number;
  /** Authoritative Answer. */
  aa: boolean;
  /** TrunCation. */
  tc: boolean;
  /** Recursion Desired. */
  rd: boolean;
  /** Recursion Available. */
  ra: boolean;
  /** Response code (0 = no error, 3 = NXDOMAIN). */
  rcode: number;
}

/** One entry of the question section. */
export interface DnsQuestion {
  /** Presentation-form owner name, without a trailing dot. */
  name: string;
  /** QTYPE. */
  type: number;
  /** QCLASS. */
  class: number;
}

/** A decoded A (IPv4 address) resource record. */
export interface DnsARecord {
  kind: "a";
  name: string;
  type: typeof DNS_TYPE_A;
  class: number;
  ttl: number;
  /** Dotted-decimal IPv4 address. */
  address: string;
}

/** Any other resource record: RDATA stays opaque for a lossless round-trip. */
export interface DnsRawRecord {
  kind: "raw";
  name: string;
  type: number;
  class: number;
  ttl: number;
  /** RDATA exactly as carried on the wire. */
  rdata: Uint8Array;
}

/** A resource record in any supported section. */
export type DnsRecord = DnsARecord | DnsRawRecord;

/** A decoded DNS message. Counts are derived from the section arrays. */
export interface DnsMessage {
  id: number;
  flags: DnsFlags;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  authorities: DnsRecord[];
  additionals: DnsRecord[];
}

/** Options for {@link serializeDns}. */
export interface DnsSerializeOptions {
  /**
   * Compress owner names that repeat a question name with a pointer to that
   * question. Default false; {@link serializeDnsResponse} enables it.
   */
  compress?: boolean;
}

function flagsToWord(flags: DnsFlags): number {
  checkNibble("opcode", flags.opcode);
  checkNibble("rcode", flags.rcode);
  let word = 0;
  if (flags.qr) {
    word |= FLAG_QR;
  }
  word |= flags.opcode << 11;
  if (flags.aa) {
    word |= FLAG_AA;
  }
  if (flags.tc) {
    word |= FLAG_TC;
  }
  if (flags.rd) {
    word |= FLAG_RD;
  }
  if (flags.ra) {
    word |= FLAG_RA;
  }
  return word | flags.rcode;
}

function flagsFromWord(word: number): DnsFlags {
  return {
    qr: (word & FLAG_QR) !== 0,
    opcode: (word >>> 11) & 0x0f,
    aa: (word & FLAG_AA) !== 0,
    tc: (word & FLAG_TC) !== 0,
    rd: (word & FLAG_RD) !== 0,
    ra: (word & FLAG_RA) !== 0,
    rcode: word & 0x0f,
  };
}

/** Case-insensitive comparison key for a presentation-form name. */
export function dnsNameKey(name: string): string {
  if (name === "." || name === "") {
    return "";
  }
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  return trimmed.toLowerCase();
}

function nameLabels(name: string): string[] {
  if (typeof name !== "string" || name.length === 0) {
    throw new RangeError("dns name must be a non-empty string");
  }
  if (name === ".") {
    return [];
  }
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  if (trimmed.length === 0) {
    return [];
  }
  const labels = trimmed.split(".");
  let wireLength = 1;
  for (const label of labels) {
    if (label.length === 0) {
      throw new RangeError(`dns name has an empty label: ${name}`);
    }
    if (label.length > DNS_MAX_LABEL_LENGTH) {
      throw new RangeError(
        `dns label exceeds ${DNS_MAX_LABEL_LENGTH} bytes: ${label}`,
      );
    }
    for (let i = 0; i < label.length; i++) {
      if (label.charCodeAt(i) > 0xff) {
        throw new RangeError(`dns label is not byte-addressable: ${label}`);
      }
    }
    wireLength += 1 + label.length;
  }
  if (wireLength > DNS_MAX_NAME_LENGTH) {
    throw new RangeError(
      `dns name exceeds ${DNS_MAX_NAME_LENGTH} bytes: ${name}`,
    );
  }
  return labels;
}

function writeName(writer: BufferWriter, name: string): void {
  for (const label of nameLabels(name)) {
    writer.u8(label.length);
    for (let i = 0; i < label.length; i++) {
      writer.u8(label.charCodeAt(i));
    }
  }
  writer.u8(0);
}

interface DecodedName {
  name: string;
  /** Offset immediately after the name at its original position. */
  next: number;
}

function readName(data: Uint8Array, start: number): DecodedName {
  const labels: string[] = [];
  let position = start;
  let next = start;
  let jumped = false;
  let jumps = 0;
  let wireLength = 1;

  for (;;) {
    if (position >= data.length) {
      throw new TruncatedError(position, 1, 0);
    }
    const length = data[position] as number;
    if (length === 0) {
      if (!jumped) {
        next = position + 1;
      }
      break;
    }
    if ((length & POINTER_MASK) === POINTER_MASK) {
      if (position + 1 >= data.length) {
        throw new TruncatedError(position, 2, data.length - position);
      }
      const target =
        ((length & POINTER_TARGET_MASK) << 8) | (data[position + 1] as number);
      if (target >= position) {
        throw new Error(
          `dns compression pointer at ${position} must point backwards, ` +
            `got ${target}`,
        );
      }
      jumps++;
      if (jumps > MAX_POINTER_JUMPS) {
        throw new Error(
          `dns compression pointer chain exceeds ${MAX_POINTER_JUMPS} jumps`,
        );
      }
      if (!jumped) {
        next = position + 2;
      }
      jumped = true;
      position = target;
      continue;
    }
    if ((length & POINTER_MASK) !== 0) {
      throw new Error(`dns invalid label length ${length} at ${position}`);
    }
    if (position + 1 + length > data.length) {
      throw new TruncatedError(
        position + 1,
        length,
        data.length - position - 1,
      );
    }
    wireLength += 1 + length;
    if (wireLength > DNS_MAX_NAME_LENGTH) {
      throw new Error(`dns expanded name exceeds ${DNS_MAX_NAME_LENGTH} bytes`);
    }
    let label = "";
    for (let i = 0; i < length; i++) {
      label += String.fromCharCode(data[position + 1 + i] as number);
    }
    labels.push(label);
    if (labels.length > 127) {
      throw new Error("dns name has too many labels");
    }
    position += 1 + length;
  }

  return { name: labels.length === 0 ? "." : labels.join("."), next };
}

function readRecord(reader: BufferReader, data: Uint8Array): DnsRecord {
  const decoded = readName(data, reader.position);
  reader.seek(decoded.next);
  const type = reader.u16be();
  const recordClass = reader.u16be();
  const ttl = reader.u32be();
  const rdlength = reader.u16be();
  const rdata = reader.bytes(rdlength).slice();
  if (type === DNS_TYPE_A) {
    if (rdata.length !== 4) {
      throw new Error(
        `dns A record RDATA must be 4 bytes, got ${rdata.length}`,
      );
    }
    return {
      kind: "a",
      name: decoded.name,
      type: DNS_TYPE_A,
      class: recordClass,
      ttl,
      address: Ipv4Address.fromBytes(rdata).toString(),
    };
  }
  return {
    kind: "raw",
    name: decoded.name,
    type,
    class: recordClass,
    ttl,
    rdata,
  };
}

function readRecords(
  reader: BufferReader,
  data: Uint8Array,
  count: number,
): DnsRecord[] {
  const records: DnsRecord[] = [];
  for (let i = 0; i < count; i++) {
    records.push(readRecord(reader, data));
  }
  return records;
}

/**
 * Parse one DNS message.
 *
 * `truncated` when a declared field or section runs past the buffer,
 * `invalid` for malformed names, compression loops or a non-4-byte A RDATA.
 * Never throws.
 */
export function parseDns(data: Uint8Array): ParseResult<DnsMessage> {
  if (data.length < DNS_HEADER_LENGTH) {
    return parseErr(
      "truncated",
      `dns message needs at least ${DNS_HEADER_LENGTH} bytes, ` +
        `got ${data.length}`,
    );
  }
  try {
    const reader = new BufferReader(data);
    const id = reader.u16be();
    const flags = flagsFromWord(reader.u16be());
    const qdcount = reader.u16be();
    const ancount = reader.u16be();
    const nscount = reader.u16be();
    const arcount = reader.u16be();

    const questions: DnsQuestion[] = [];
    for (let i = 0; i < qdcount; i++) {
      const decoded = readName(data, reader.position);
      reader.seek(decoded.next);
      const type = reader.u16be();
      const questionClass = reader.u16be();
      questions.push({
        name: decoded.name,
        type,
        class: questionClass,
      });
    }

    return parseOk({
      id,
      flags,
      questions,
      answers: readRecords(reader, data, ancount),
      authorities: readRecords(reader, data, nscount),
      additionals: readRecords(reader, data, arcount),
    });
  } catch (err) {
    if (err instanceof TruncatedError) {
      return parseErr("truncated", `truncated dns message: ${err.message}`);
    }
    return parseErr("invalid", `invalid dns message: ${errorMessage(err)}`);
  }
}

function writeRecord(
  writer: BufferWriter,
  record: DnsRecord,
  questionOffsets: ReadonlyMap<string, number>,
  compress: boolean,
): void {
  const key = dnsNameKey(record.name);
  const pointer = compress ? questionOffsets.get(key) : undefined;
  if (pointer !== undefined && pointer <= 0x3fff) {
    writer.u16be(0xc000 | pointer);
  } else {
    writeName(writer, record.name);
  }
  writer.u16be(checkU16("record type", record.type));
  writer.u16be(checkU16("record class", record.class));
  writer.u32be(checkU32("record ttl", record.ttl));
  if (record.kind === "a") {
    let address: Ipv4Address;
    try {
      address = Ipv4Address.parse(record.address);
    } catch (err) {
      throw new RangeError(
        `dns A record has an invalid address: ${errorMessage(err)}`,
      );
    }
    writer.u16be(4);
    writer.bytes(address.toBytes());
    return;
  }
  if (record.rdata.length > 0xffff) {
    throw new RangeError(
      `dns RDATA exceeds 65535 bytes: ${record.rdata.length}`,
    );
  }
  writer.u16be(record.rdata.length);
  writer.bytes(record.rdata);
}

/**
 * Serialize one DNS message.
 *
 * Header counts are derived from the section arrays. Owner names that
 * repeat a question name are compressed by default on responses (QR=1);
 * pass `opts.compress` to force compression on or off. Throws `RangeError`
 * on out-of-range ids, types, classes, TTLs, names or RDATA.
 */
export function serializeDns(
  message: DnsMessage,
  opts: DnsSerializeOptions = {},
): Uint8Array {
  checkU16("id", message.id);
  const flags = flagsToWord(message.flags);
  const qdcount = checkCount("questions", message.questions.length);
  const ancount = checkCount("answers", message.answers.length);
  const nscount = checkCount("authorities", message.authorities.length);
  const arcount = checkCount("additionals", message.additionals.length);

  const writer = new BufferWriter();
  writer.u16be(message.id);
  writer.u16be(flags);
  writer.u16be(qdcount);
  writer.u16be(ancount);
  writer.u16be(nscount);
  writer.u16be(arcount);

  const questionOffsets = new Map<string, number>();
  for (const question of message.questions) {
    const key = dnsNameKey(question.name);
    if (!questionOffsets.has(key)) {
      questionOffsets.set(key, writer.length);
    }
    writeName(writer, question.name);
    writer.u16be(checkU16("question type", question.type));
    writer.u16be(checkU16("question class", question.class));
  }

  const compress = opts.compress ?? message.flags.qr;
  for (const record of message.answers) {
    writeRecord(writer, record, questionOffsets, compress);
  }
  for (const record of message.authorities) {
    writeRecord(writer, record, questionOffsets, compress);
  }
  for (const record of message.additionals) {
    writeRecord(writer, record, questionOffsets, compress);
  }
  return writer.toBytes();
}

/** Serialize a response, compressing owner names against the question. */
export function serializeDnsResponse(message: DnsMessage): Uint8Array {
  return serializeDns(message, { compress: true });
}
