/**
 * Main-thread decoding for the inspector (S3). The worker ships raw frames
 * as hex; the UI uses `@netlab/protocols` only to display them. Keeping the
 * decoders here means the worker never imports UI/bundle code.
 */

import type {
  DhcpMessage,
  DhcpOption,
  DnsMessage,
  DnsRecord,
  UdpDatagram,
} from "@netlab/protocols";
import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  DHCP_BROADCAST_FLAG,
  DHCP_CHADDR_LENGTH,
  DHCP_CLIENT_PORT,
  DHCP_FILE_LENGTH,
  DHCP_MESSAGE_ACK,
  DHCP_MESSAGE_DISCOVER,
  DHCP_MESSAGE_NAK,
  DHCP_MESSAGE_OFFER,
  DHCP_MESSAGE_REQUEST,
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
  DNS_CLASS_IN,
  DNS_HEADER_LENGTH,
  DNS_RCODE_NOERROR,
  DNS_RCODE_NXDOMAIN,
  DNS_TYPE_A,
  dhcpHardwareAddress,
  dhcpMessageType,
  ETHERNET_HEADER_LENGTH,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_VLAN,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  IPV4_PROTOCOL_ICMP,
  IPV4_PROTOCOL_UDP,
  parseArp,
  parseDhcp,
  parseDns,
  parseEthernet,
  parseIcmp,
  parseIpv4,
  parseUdp,
  parseVlanTag,
  UDP_HEADER_LENGTH,
  VLAN_TAG_LENGTH,
} from "@netlab/protocols";
import type { WireTrace } from "./sim-protocol";

export type LayerId = "l2" | "l3" | "l4" | "l7";

export interface LayerField {
  label: string;
  value: string;
  /** First byte index (inclusive) in the whole frame. */
  start: number;
  /** Last byte index (exclusive) in the whole frame. */
  end: number;
}

export interface Layer {
  id: LayerId;
  title: string;
  rows: Array<LayerField>;
  /** First byte index (inclusive) covered by this layer. */
  start: number;
  /** Last byte index (exclusive) covered by this layer. */
  end: number;
}

export interface HexToken {
  text: string;
  layer: LayerId | "pad";
  byte: number;
}

export interface DecodedFrame {
  srcMac: string;
  dstMac: string;
  srcIp: string | null;
  dstIp: string | null;
  /**
   * Innermost layer the decoder understood: an application message wins
   * over its transport (`DNS`/`DHCP` over `UDP`), and ARP/ICMP keep their
   * own name.
   */
  protocol: FrameProtocol;
  summary: string;
  isError: boolean;
  layers: Layer[];
  hex: string;
}

/** Protocol badge/filter value of a decoded frame (innermost decoded). */
export type FrameProtocol = "ARP" | "ICMP" | "UDP" | "DNS" | "DHCP" | "OTRO";

export type PacketDir = "tx" | "rx" | "drop";

export interface PacketRow {
  traceIndex: number;
  t: number;
  link: string;
  dir: PacketDir;
  length: number;
  /** Only set when dir is "drop". */
  dropReason: string | null;
  decoded: DecodedFrame;
}

function field(
  label: string,
  value: string,
  start: number,
  end: number,
): LayerField {
  return { label, value, start: Math.max(0, start), end: Math.max(start, end) };
}

const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function u16At(bytes: Uint8Array, offset: number): number {
  return (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);
}

function macAt(bytes: Uint8Array, offset: number): string {
  const parts: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    parts.push(
      byteAt(bytes, offset + index)
        .toString(16)
        .padStart(2, "0"),
    );
  }
  return parts.join(":");
}

function checksumText(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function etherTypeLabel(value: number): string {
  if (value === ETHERTYPE_ARP) {
    return "0x0806 ARP";
  }
  if (value === ETHERTYPE_IPV4) {
    return "0x0800 IPv4";
  }
  if (value === ETHERTYPE_VLAN) {
    return "0x8100 802.1Q";
  }
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function ipProtocolLabel(value: number): string {
  return value === IPV4_PROTOCOL_ICMP ? "1 (ICMP)" : String(value);
}

function icmpKindName(type: number): string {
  if (type === ICMP_TYPE_ECHO_REQUEST) {
    return "echo request";
  }
  if (type === ICMP_TYPE_ECHO_REPLY) {
    return "echo reply";
  }
  if (type === ICMP_TYPE_TIME_EXCEEDED) {
    return "time exceeded";
  }
  if (type === ICMP_TYPE_DEST_UNREACHABLE) {
    return "dest unreachable";
  }
  return `type ${type}`;
}

function parseFailure(
  bytes: Uint8Array,
  hex: string,
  message: string,
): DecodedFrame {
  return {
    srcMac: bytes.length >= 12 ? macAt(bytes, 6) : "—",
    dstMac: bytes.length >= 6 ? macAt(bytes, 0) : "—",
    srcIp: null,
    dstIp: null,
    protocol: "OTRO",
    summary: `frame ilegible: ${message}`,
    isError: true,
    layers: [],
    hex,
  };
}

/** DNS service port; the decoder treats a matching payload as a message. */
const DNS_PORT = 53;

/**
 * Offset of `chaddr` inside a DHCP message: `op`, `htype`, `hlen`, `hops`,
 * `xid`, `secs`, `flags` and the four addresses take 28 bytes.
 */
const DHCP_CHADDR_OFFSET = 28;

/** Application decode of a UDP payload: the L7 layer plus its summary. */
interface AppDecode {
  protocol: "DNS" | "DHCP";
  summary: string;
  layer: Layer;
}

function dnsTypeName(type: number): string {
  return type === DNS_TYPE_A ? "A" : String(type);
}

function dnsClassLabel(value: number): string {
  return value === DNS_CLASS_IN ? `IN (${value})` : String(value);
}

function dnsRcodeLabel(rcode: number): string {
  if (rcode === DNS_RCODE_NOERROR) {
    return "NOERROR";
  }
  if (rcode === DNS_RCODE_NXDOMAIN) {
    return "NXDOMAIN";
  }
  return `rcode ${rcode}`;
}

function dnsFlagsText(flags: DnsMessage["flags"]): string {
  const bit = (value: boolean): number => (value ? 1 : 0);
  return [
    `QR=${bit(flags.qr)}`,
    `opcode=${flags.opcode}`,
    `AA=${bit(flags.aa)}`,
    `TC=${bit(flags.tc)}`,
    `RD=${bit(flags.rd)}`,
    `RA=${bit(flags.ra)}`,
    `rcode=${flags.rcode} (${dnsRcodeLabel(flags.rcode)})`,
  ].join(" ");
}

/**
 * Index just past the name stored at `start`: a compression pointer occupies
 * 2 bytes on the wire, labels occupy `1 + length` bytes each and the root
 * label takes 1. Out-of-range input clamps to the end instead of throwing.
 */
function dnsNameEnd(data: Uint8Array, start: number): number {
  let index = start;
  while (index < data.length) {
    const length = byteAt(data, index);
    if (length === 0) {
      return index + 1;
    }
    if ((length & 0xc0) === 0xc0) {
      return index + 2;
    }
    index += 1 + length;
  }
  return data.length;
}

function dnsRecordRows(
  prefix: string,
  records: readonly DnsRecord[],
  data: Uint8Array,
  base: number,
  from: number,
): { rows: LayerField[]; next: number } {
  const rows: LayerField[] = [];
  let index = from;
  records.forEach((record, position) => {
    const nameStart = index;
    const typeStart = dnsNameEnd(data, index);
    const classStart = typeStart + 2;
    const ttlStart = classStart + 2;
    const lengthStart = ttlStart + 4;
    const rdataStart = lengthStart + 2;
    const rdataEnd =
      rdataStart + (record.kind === "a" ? 4 : record.rdata.length);
    const label = `${prefix} ${position + 1}`;
    rows.push(
      field(`${label} nombre`, record.name, base + nameStart, base + typeStart),
      field(
        `${label} tipo`,
        `${dnsTypeName(record.type)} (${record.type})`,
        base + typeStart,
        base + classStart,
      ),
      field(
        `${label} clase`,
        dnsClassLabel(record.class),
        base + classStart,
        base + ttlStart,
      ),
      field(
        `${label} TTL`,
        `${record.ttl} s`,
        base + ttlStart,
        base + lengthStart,
      ),
      field(
        `${label} rdlength`,
        `${rdataEnd - rdataStart} B`,
        base + lengthStart,
        base + rdataStart,
      ),
      field(
        `${label} rdata`,
        record.kind === "a" ? record.address : `${record.rdata.length} B`,
        base + rdataStart,
        base + rdataEnd,
      ),
    );
    index = rdataEnd;
  });
  return { rows, next: index };
}

/** Decode a port-53 payload as DNS; `null` when the bytes are not a message. */
function decodeDnsApp(payload: Uint8Array, base: number): AppDecode | null {
  const parsed = parseDns(payload);
  if (!parsed.ok) {
    return null;
  }
  const message = parsed.value;
  const rows: LayerField[] = [
    field(
      "id",
      `0x${message.id.toString(16).padStart(4, "0")}`,
      base,
      base + 2,
    ),
    field("flags", dnsFlagsText(message.flags), base + 2, base + 4),
    field("QDCOUNT", String(message.questions.length), base + 4, base + 6),
    field("ANCOUNT", String(message.answers.length), base + 6, base + 8),
    field("NSCOUNT", String(message.authorities.length), base + 8, base + 10),
    field("ARCOUNT", String(message.additionals.length), base + 10, base + 12),
  ];
  let index = DNS_HEADER_LENGTH;
  message.questions.forEach((question, position) => {
    const nameStart = index;
    const typeStart = dnsNameEnd(payload, nameStart);
    const label = `pregunta ${position + 1}`;
    rows.push(
      field(
        `${label} nombre`,
        question.name,
        base + nameStart,
        base + typeStart,
      ),
      field(
        `${label} tipo`,
        `${dnsTypeName(question.type)} (${question.type})`,
        base + typeStart,
        base + typeStart + 2,
      ),
      field(
        `${label} clase`,
        dnsClassLabel(question.class),
        base + typeStart + 2,
        base + typeStart + 4,
      ),
    );
    index = typeStart + 4;
  });
  const sections = [
    ["respuesta", message.answers],
    ["autoridad", message.authorities],
    ["adicional", message.additionals],
  ] as const;
  for (const [prefix, records] of sections) {
    const section = dnsRecordRows(prefix, records, payload, base, index);
    rows.push(...section.rows);
    index = section.next;
  }

  const service = message.flags.qr ? "respuesta" : "query";
  return {
    protocol: "DNS",
    summary: dnsSummary(message),
    layer: {
      id: "l7",
      title: `DNS · ${service} · ${payload.length} bytes`,
      rows,
      start: base,
      end: base + payload.length,
    },
  };
}

function dnsSummary(message: DnsMessage): string {
  const question = message.questions[0];
  const name = question?.name ?? "—";
  if (!message.flags.qr) {
    return `DNS query ${dnsTypeName(question?.type ?? 0)} ${name}`;
  }
  if (message.flags.rcode !== DNS_RCODE_NOERROR) {
    return `DNS respuesta ${dnsRcodeLabel(message.flags.rcode)} ${name}`;
  }
  const answer = message.answers[0];
  if (answer === undefined) {
    return `DNS respuesta ${name} · sin registros`;
  }
  const value =
    answer.kind === "a" ? answer.address : `${answer.rdata.length} B`;
  return `DNS respuesta ${dnsTypeName(answer.type)} ${name} → ${value}`;
}

function dhcpMessageTypeName(type: number): string {
  if (type === DHCP_MESSAGE_DISCOVER) {
    return "DISCOVER";
  }
  if (type === DHCP_MESSAGE_OFFER) {
    return "OFFER";
  }
  if (type === DHCP_MESSAGE_REQUEST) {
    return "REQUEST";
  }
  if (type === DHCP_MESSAGE_ACK) {
    return "ACK";
  }
  if (type === DHCP_MESSAGE_NAK) {
    return "NAK";
  }
  return `tipo ${type}`;
}

function dhcpOptionName(code: number): string | null {
  if (code === DHCP_OPTION_SUBNET_MASK) {
    return "subnet mask";
  }
  if (code === DHCP_OPTION_ROUTER) {
    return "router";
  }
  if (code === DHCP_OPTION_DNS) {
    return "dns";
  }
  if (code === DHCP_OPTION_REQUESTED_IP) {
    return "requested ip";
  }
  if (code === DHCP_OPTION_LEASE_TIME) {
    return "lease time";
  }
  if (code === DHCP_OPTION_MESSAGE_TYPE) {
    return "message type";
  }
  if (code === DHCP_OPTION_SERVER_ID) {
    return "server id";
  }
  return null;
}

function dhcpOptionValue(
  option: DhcpOption | undefined,
  length: number,
): string {
  if (option === undefined) {
    return `${length} B`;
  }
  switch (option.kind) {
    case "subnet-mask":
      return option.mask;
    case "router":
      return option.routers.join(", ");
    case "dns":
      return option.servers.join(", ");
    case "requested-ip":
      return option.ip;
    case "lease-time":
      return `${option.seconds} s`;
    case "message-type":
      return `${dhcpMessageTypeName(option.type)} (${option.type})`;
    case "server-id":
      return option.id;
    default:
      return `${option.data.length} B`;
  }
}

/** Walk the TLV area so every option row keeps its wire range. */
function dhcpOptionRows(
  message: DhcpMessage,
  payload: Uint8Array,
  base: number,
): LayerField[] {
  const rows: LayerField[] = [];
  let index = DHCP_OPTIONS_OFFSET;
  let position = 0;
  while (index < payload.length) {
    const code = byteAt(payload, index);
    if (code === DHCP_OPTION_PAD) {
      index += 1;
      continue;
    }
    if (code === DHCP_OPTION_END) {
      rows.push(field("fin", "end (255)", base + index, base + index + 1));
      index += 1;
      break;
    }
    const declared = byteAt(payload, index + 1);
    const valueEnd = Math.min(index + 2 + declared, payload.length);
    const name = dhcpOptionName(code);
    const label = name === null ? `opción ${code}` : `opción ${code} (${name})`;
    const option = message.options[position];
    position += 1;
    rows.push(
      field(
        label,
        dhcpOptionValue(option, declared),
        base + index,
        base + valueEnd,
      ),
    );
    index = valueEnd;
  }
  return rows;
}

/** Hardware address bytes as `aa:bb:…`, honouring `hlen`. */
function dhcpChaddrText(message: DhcpMessage): string {
  const parts: string[] = [];
  for (const byte of dhcpHardwareAddress(message)) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.length === 0 ? "—" : parts.join(":");
}

/** Zero-padded `sname`/`file` fields as text; empty fields read as a dash. */
function dhcpTextField(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && byteAt(bytes, end - 1) === 0) {
    end -= 1;
  }
  if (end === 0) {
    return "—";
  }
  let text = "";
  for (let index = 0; index < end; index += 1) {
    const code = byteAt(bytes, index);
    text += code >= 32 && code < 127 ? String.fromCharCode(code) : ".";
  }
  return text;
}

/** Decode a port-67/68 payload as DHCP; `null` when the bytes are not one. */
function decodeDhcpApp(payload: Uint8Array, base: number): AppDecode | null {
  const parsed = parseDhcp(payload);
  if (!parsed.ok) {
    return null;
  }
  const message = parsed.value;
  const type = dhcpMessageType(message.options);
  const service = type === undefined ? null : dhcpMessageTypeName(type);
  const prefix = service === null ? "DHCP" : `DHCP ${service}`;
  const xid = `0x${message.xid.toString(16).padStart(8, "0")}`;
  const opName =
    message.op === DHCP_OP_REQUEST
      ? "BOOTREQUEST"
      : message.op === DHCP_OP_REPLY
        ? "BOOTREPLY"
        : "?";
  const broadcast =
    (message.flags & DHCP_BROADCAST_FLAG) !== 0 ? " (broadcast)" : "";
  // BOOTP body: `op`..`giaddr` take 28 bytes, then the fixed-width fields.
  const chaddrStart = base + DHCP_CHADDR_OFFSET;
  const snameStart = chaddrStart + DHCP_CHADDR_LENGTH;
  const fileStart = snameStart + DHCP_SNAME_LENGTH;
  const cookieStart = fileStart + DHCP_FILE_LENGTH;
  const rows: LayerField[] = [
    field("op", `${message.op} (${opName})`, base, base + 1),
    field("htype", `${message.htype} (Ethernet)`, base + 1, base + 2),
    field("hlen", String(message.hlen), base + 2, base + 3),
    field("hops", String(message.hops), base + 3, base + 4),
    field("xid", xid, base + 4, base + 8),
    field("secs", `${message.secs} s`, base + 8, base + 10),
    field(
      "flags",
      `0x${message.flags.toString(16).padStart(4, "0")}${broadcast}`,
      base + 10,
      base + 12,
    ),
    field("ciaddr", message.ciaddr, base + 12, base + 16),
    field("yiaddr", message.yiaddr, base + 16, base + 20),
    field("siaddr", message.siaddr, base + 20, base + 24),
    field("giaddr", message.giaddr, base + 24, base + 28),
    field("chaddr", dhcpChaddrText(message), chaddrStart, snameStart),
    field("sname", dhcpTextField(message.sname), snameStart, fileStart),
    field("file", dhcpTextField(message.file), fileStart, cookieStart),
    field("cookie", "0x63825363", cookieStart, base + DHCP_OPTIONS_OFFSET),
    ...dhcpOptionRows(message, payload, base),
  ];
  const assigned =
    message.yiaddr === "0.0.0.0" ? "" : ` · yiaddr ${message.yiaddr}`;
  return {
    protocol: "DHCP",
    summary: `${prefix} xid=${xid}${assigned}`,
    layer: {
      id: "l7",
      title: `DHCP · ${service ?? "sin tipo"} · ${payload.length} bytes`,
      rows,
      start: base,
      end: base + payload.length,
    },
  };
}

/**
 * Pick the application decoder for a UDP datagram. DNS wins over DHCP, and a
 * payload the app codec rejects leaves the frame as plain UDP: the innermost
 * layer that decoded is what the badge shows.
 */
function decodeUdpApp(datagram: UdpDatagram, base: number): AppDecode | null {
  if (datagram.srcPort === DNS_PORT || datagram.dstPort === DNS_PORT) {
    return decodeDnsApp(datagram.payload, base);
  }
  const dhcp = isDhcpPort(datagram.srcPort) || isDhcpPort(datagram.dstPort);
  return dhcp ? decodeDhcpApp(datagram.payload, base) : null;
}

function isDhcpPort(port: number): boolean {
  return port === DHCP_SERVER_PORT || port === DHCP_CLIENT_PORT;
}

/**
 * Decode one Ethernet frame for the packet list and the inspector.
 *
 * Every row carries its absolute byte range so the inspector can highlight
 * in both directions (click a field → its bytes; click a byte → its field).
 * Results are memoized by hex: the packet list re-decodes on every reactive
 * recompute and traces repeat the same frames (ARP, echo).
 */
const decodeCache = new Map<string, DecodedFrame>();
const DECODE_CACHE_LIMIT = 500;

export function decodeFrame(hex: string): DecodedFrame {
  const cached = decodeCache.get(hex);
  if (cached !== undefined) {
    return cached;
  }
  const decoded = decodeFrameUncached(hex);
  if (decodeCache.size >= DECODE_CACHE_LIMIT) {
    decodeCache.clear();
  }
  decodeCache.set(hex, decoded);
  return decoded;
}

function decodeFrameUncached(hex: string): DecodedFrame {
  const bytes = hexToBytes(hex);

  // 802.1Q is rejected by parseEthernet, so peel the tag here: TPID(2) +
  // TCI(2) shift every later offset by 4 bytes.
  let l2End = ETHERNET_HEADER_LENGTH;
  let etherType = u16At(bytes, 12);
  let vlanTitle: string | null = null;
  if (bytes.length >= ETHERNET_HEADER_LENGTH && etherType === ETHERTYPE_VLAN) {
    if (bytes.length < ETHERNET_HEADER_LENGTH + VLAN_TAG_LENGTH) {
      return parseFailure(bytes, hex, "trama 802.1Q truncada");
    }
    const tag = parseVlanTag(bytes.slice(14, 16));
    if (!tag.ok) {
      return parseFailure(bytes, hex, tag.error.message);
    }
    etherType = u16At(bytes, 16);
    l2End = ETHERNET_HEADER_LENGTH + VLAN_TAG_LENGTH;
    vlanTitle = `PCP ${tag.value.pcp} · DEI ${tag.value.dei} · VID ${tag.value.vid}`;
  }

  const parsed = vlanTitle === null ? parseEthernet(bytes) : null;
  // parseEthernet rejects tagged frames by design; when we already peeled
  // the tag above, read the prefix straight off the bytes instead.
  let srcMac: string;
  let dstMac: string;
  if (parsed === null) {
    dstMac = macAt(bytes, 0);
    srcMac = macAt(bytes, 6);
  } else if (!parsed.ok) {
    return parseFailure(bytes, hex, parsed.error.message);
  } else {
    srcMac = parsed.value.src.toString();
    dstMac = parsed.value.dst.toString();
  }
  const dstSuffix = dstMac === BROADCAST_MAC ? " (broadcast)" : "";
  const l2rows: Array<LayerField> = [
    field("dst", `${dstMac}${dstSuffix}`, 0, 6),
    field("src", srcMac, 6, 12),
  ];
  if (vlanTitle !== null) {
    l2rows.push(
      field("tpid", "0x8100 (802.1Q)", 12, 14),
      field("vlan", vlanTitle, 14, 16),
      field("etherType", etherTypeLabel(etherType), 16, 18),
    );
  } else {
    l2rows.push(field("etherType", etherTypeLabel(etherType), 12, 14));
  }
  l2rows.push(field("longitud", `${bytes.length} B`, 0, l2End));
  const layers: Layer[] = [
    {
      id: "l2",
      title:
        vlanTitle === null
          ? `Ethernet II · ${ETHERNET_HEADER_LENGTH} bytes`
          : `Ethernet II + 802.1Q · ${l2End} bytes`,
      rows: l2rows,
      start: 0,
      end: l2End,
    },
  ];
  const payload = bytes.slice(l2End);

  if (etherType === ETHERTYPE_ARP) {
    const arp = parseArp(payload);
    if (!arp.ok) {
      return parseFailure(bytes, hex, arp.error.message);
    }
    const packet = arp.value;
    const request = packet.oper === ARP_OP_REQUEST;
    const operation = request
      ? "1 (who-has)"
      : packet.oper === ARP_OP_REPLY
        ? "2 (is-at)"
        : String(packet.oper);
    const base = l2End;
    layers.push({
      id: "l3",
      title: `ARP · ${request ? "request" : "reply"}`,
      rows: [
        field("htype", String(u16At(payload, 0)), base, base + 2),
        field(
          "ptype",
          `0x${u16At(payload, 2).toString(16).padStart(4, "0")}`,
          base + 2,
          base + 4,
        ),
        field("hlen", String(byteAt(payload, 4)), base + 4, base + 5),
        field("plen", String(byteAt(payload, 5)), base + 5, base + 6),
        field("operación", operation, base + 6, base + 8),
        field("sender MAC", packet.senderMac.toString(), base + 8, base + 14),
        field("sender IP", packet.senderIp.toString(), base + 14, base + 18),
        field("target MAC", packet.targetMac.toString(), base + 18, base + 24),
        field("target IP", packet.targetIp.toString(), base + 24, base + 28),
      ],
      start: base,
      end: Math.min(base + 28, bytes.length),
    });
    return {
      srcMac,
      dstMac,
      srcIp: packet.senderIp.toString(),
      dstIp: packet.targetIp.toString(),
      protocol: "ARP",
      summary: request
        ? `who-has ${packet.targetIp}? tell ${packet.senderIp}`
        : `${packet.senderIp} is-at ${packet.senderMac}`,
      isError: false,
      layers,
      hex,
    };
  }

  if (etherType !== ETHERTYPE_IPV4) {
    return {
      srcMac,
      dstMac,
      srcIp: null,
      dstIp: null,
      protocol: "OTRO",
      summary: `etherType ${etherTypeLabel(etherType)}`,
      isError: false,
      layers,
      hex,
    };
  }

  const ip = parseIpv4(payload);
  if (!ip.ok) {
    return parseFailure(bytes, hex, ip.error.message);
  }

  const { header, payload: ipPayload } = ip.value;
  const base = l2End;
  const ipEnd = base + header.ihl * 4;
  const totalEnd = Math.min(base + header.totalLength, bytes.length);
  const versionIhl = byteAt(payload, 0);
  const dscpEcn = byteAt(payload, 1);
  const l3rows: Array<LayerField> = [
    field("versión", String(versionIhl >> 4), base, base + 1),
    field("IHL", `${header.ihl} (${header.ihl * 4} B)`, base, base + 1),
    field(
      "DSCP/ECN",
      `DSCP ${dscpEcn >> 2} · ECN ${dscpEcn & 0x03}`,
      base + 1,
      base + 2,
    ),
    field("longitud total", `${header.totalLength} B`, base + 2, base + 4),
    field(
      "identificación",
      `0x${header.identification.toString(16).padStart(4, "0")}`,
      base + 4,
      base + 6,
    ),
    field(
      "flags/fragmento",
      `DF=${header.flags.dontFragment ? 1 : 0} MF=${header.flags.moreFragments ? 1 : 0} offset=${header.fragmentOffset}`,
      base + 6,
      base + 8,
    ),
    field("TTL", String(header.ttl), base + 8, base + 9),
    field("protocolo", ipProtocolLabel(header.protocol), base + 9, base + 10),
    field(
      "checksum",
      `${checksumText(header.checksum)} · válido`,
      base + 10,
      base + 12,
    ),
    field("origen", header.src.toString(), base + 12, base + 16),
    field("destino", header.dst.toString(), base + 16, base + 20),
  ];
  if (header.ihl > 5) {
    l3rows.push(
      field("opciones", `${header.ihl * 4 - 20} B`, base + 20, ipEnd),
    );
  }
  layers.push({
    id: "l3",
    title: `IPv4 · ${header.ihl * 4} bytes`,
    rows: l3rows,
    start: base,
    end: ipEnd,
  });

  const frameBase: Omit<
    DecodedFrame,
    "protocol" | "summary" | "isError" | "layers"
  > = {
    srcMac,
    dstMac,
    srcIp: header.src.toString(),
    dstIp: header.dst.toString(),
    hex,
  };

  if (header.protocol === IPV4_PROTOCOL_UDP) {
    // The IPv4 addresses are passed in so `parseUdp` verifies the checksum
    // against the pseudo-header; a bad one fails the frame like ICMP does.
    const udp = parseUdp(ipPayload, { src: header.src, dst: header.dst });
    if (!udp.ok) {
      return parseFailure(bytes, hex, udp.error.message);
    }
    const datagram = udp.value;
    const udpBase = ipEnd;
    const udpEnd = udpBase + datagram.length;
    const payloadBase = udpBase + UDP_HEADER_LENGTH;
    const udpChecksum = u16At(ipPayload, 6);
    // An app layer owns the payload bytes, so the L4 layer keeps just its
    // header: layers stay disjoint and a payload byte selects the DNS/DHCP
    // field instead of the generic `datos` row.
    const app = decodeUdpApp(datagram, payloadBase);
    const l4End = app === null ? udpEnd : payloadBase;
    const l4rows: Array<LayerField> = [
      field("puerto origen", String(datagram.srcPort), udpBase, udpBase + 2),
      field(
        "puerto destino",
        String(datagram.dstPort),
        udpBase + 2,
        udpBase + 4,
      ),
      field("longitud", `${datagram.length} B`, udpBase + 4, udpBase + 6),
      field(
        "checksum",
        `${checksumText(udpChecksum)} · válido`,
        udpBase + 6,
        udpBase + 8,
      ),
    ];
    if (app === null) {
      l4rows.push(
        field("datos", `${datagram.payload.length} B`, payloadBase, udpEnd),
      );
    }
    layers.push({
      id: "l4",
      title: `UDP · ${l4End - udpBase} bytes`,
      rows: l4rows,
      start: udpBase,
      end: l4End,
    });

    if (app !== null) {
      layers.push(app.layer);
      return {
        ...frameBase,
        protocol: app.protocol,
        summary: app.summary,
        isError: false,
        layers,
      };
    }
    return {
      ...frameBase,
      protocol: "UDP",
      summary: `UDP ${datagram.srcPort} → ${datagram.dstPort} · ${datagram.payload.length} B`,
      isError: false,
      layers,
    };
  }

  if (header.protocol !== IPV4_PROTOCOL_ICMP) {
    return {
      ...frameBase,
      protocol: "OTRO",
      summary: `IPv4 proto ${ipProtocolLabel(header.protocol)}`,
      isError: false,
      layers,
    };
  }

  const icmp = parseIcmp(ipPayload);
  if (!icmp.ok) {
    return parseFailure(bytes, hex, icmp.error.message);
  }

  const message = icmp.value;
  const icmpBase = ipEnd;
  const checksum = (byteAt(ipPayload, 2) << 8) | byteAt(ipPayload, 3);
  const kind = icmpKindName(message.type);
  const rows: Array<LayerField> = [
    field("tipo", `${message.type} (${kind})`, icmpBase, icmpBase + 1),
    field("código", String(message.code), icmpBase + 1, icmpBase + 2),
  ];
  let summary = `ICMP ${kind}`;
  let isError = false;

  if (message.kind === "echo") {
    rows.push(
      field(
        "identifier",
        checksumText(message.identifier),
        icmpBase + 4,
        icmpBase + 6,
      ),
      field("sequence", String(message.sequence), icmpBase + 6, icmpBase + 8),
      field(
        "checksum",
        `${checksumText(checksum)} · válido`,
        icmpBase + 2,
        icmpBase + 4,
      ),
      field("datos", `${message.data.length} B`, icmpBase + 8, totalEnd),
    );
    summary =
      message.type === ICMP_TYPE_ECHO_REQUEST
        ? `echo request seq=${message.sequence}`
        : `echo reply seq=${message.sequence}`;
  } else if (message.kind === "error") {
    isError = true;
    rows.push(
      field(
        "checksum",
        `${checksumText(checksum)} · válido`,
        icmpBase + 2,
        icmpBase + 4,
      ),
      field(
        "contexto",
        checksumText(message.unused),
        icmpBase + 4,
        icmpBase + 8,
      ),
      field(
        "datos embebidos",
        `${message.embedded.length} B`,
        icmpBase + 8,
        totalEnd,
      ),
    );
    summary =
      message.type === ICMP_TYPE_TIME_EXCEEDED
        ? "time exceeded in-transit"
        : `dest unreachable code=${message.code}`;
  } else {
    rows.push(
      field(
        "checksum",
        `${checksumText(checksum)} · válido`,
        icmpBase + 2,
        icmpBase + 4,
      ),
      field("datos", `${message.data.length} B`, icmpBase + 4, totalEnd),
    );
    summary = `ICMP type ${message.type} code ${message.code}`;
  }

  layers.push({
    id: "l4",
    title: `ICMP · ${kind}`,
    rows,
    start: icmpBase,
    end: totalEnd,
  });

  return {
    ...frameBase,
    protocol: "ICMP",
    summary,
    isError,
    layers,
  };
}

/**
 * Traces the packet list understands: every transmitted, received or
 * dropped frame (any protocol the decoder knows, including OTRO).
 */
export function buildPackets(traces: readonly WireTrace[]): PacketRow[] {
  const rows: PacketRow[] = [];
  traces.forEach((trace, traceIndex) => {
    if (trace.kind === "frame_tx") {
      rows.push({
        traceIndex,
        t: trace.t,
        link: trace.link,
        dir: "tx",
        length: trace.length,
        dropReason: null,
        decoded: decodeFrame(trace.frame),
      });
    } else if (trace.kind === "frame_rx") {
      rows.push({
        traceIndex,
        t: trace.t,
        link: trace.link,
        dir: "rx",
        length: trace.length,
        dropReason: null,
        decoded: decodeFrame(trace.frame),
      });
    } else if (trace.kind === "frame_drop") {
      rows.push({
        traceIndex,
        t: trace.t,
        link: trace.link,
        dir: "drop",
        length: trace.length,
        dropReason: trace.reason,
        decoded: decodeFrame(trace.frame),
      });
    }
  });
  return rows;
}

/** Split the hex dump into per-layer lines for the inspector. */
export function buildHexLines(
  hex: string,
  layers: readonly Layer[],
): HexToken[][] {
  const tokens: HexToken[] = [];
  for (let offset = 0; offset < hex.length; offset += 2) {
    const index = offset / 2;
    const layer = layers.find(
      (candidate) => index >= candidate.start && index < candidate.end,
    );
    tokens.push({
      text: hex.slice(offset, offset + 2),
      layer: layer?.id ?? "pad",
      byte: index,
    });
  }

  const lines: HexToken[][] = [];
  let line: HexToken[] = [];
  let current: HexToken["layer"] | null = null;
  for (const token of tokens) {
    if (current !== null && token.layer !== current) {
      lines.push(line);
      line = [];
    }
    current = token.layer;
    line.push(token);
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines;
}

/** Hex string from the worker back to bytes (no DOM, no Buffer). */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return new Uint8Array(0);
  }
  const length = hex.length / 2;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
