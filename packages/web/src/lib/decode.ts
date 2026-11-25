/**
 * Main-thread decoding for the inspector (S3). The worker ships raw frames
 * as hex; the UI uses `@netlab/protocols` only to display them. Keeping the
 * decoders here means the worker never imports UI/bundle code.
 */

import {
  ARP_OP_REPLY,
  ARP_OP_REQUEST,
  ETHERNET_HEADER_LENGTH,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_VLAN,
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  IPV4_PROTOCOL_ICMP,
  parseArp,
  parseEthernet,
  parseIcmp,
  parseIpv4,
  parseVlanTag,
  VLAN_TAG_LENGTH,
} from "@netlab/protocols";
import type { WireTrace } from "./sim-protocol";

export type LayerId = "l2" | "l3" | "l4";

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
  protocol: "ARP" | "ICMP" | "OTRO";
  summary: string;
  isError: boolean;
  layers: Layer[];
  hex: string;
}

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
