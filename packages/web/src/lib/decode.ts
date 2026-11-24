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
  ICMP_TYPE_DEST_UNREACHABLE,
  ICMP_TYPE_ECHO_REPLY,
  ICMP_TYPE_ECHO_REQUEST,
  ICMP_TYPE_TIME_EXCEEDED,
  IPV4_PROTOCOL_ICMP,
  parseArp,
  parseEthernet,
  parseIcmp,
  parseIpv4,
} from "@netlab/protocols";
import type { WireTrace } from "./sim-protocol";

export type LayerId = "l2" | "l3" | "l4";

export interface Layer {
  id: LayerId;
  title: string;
  rows: Array<[string, string]>;
  /** First byte index (inclusive) covered by this layer. */
  start: number;
  /** Last byte index (exclusive) covered by this layer. */
  end: number;
}

export interface HexToken {
  text: string;
  layer: LayerId | "pad";
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

export interface PacketRow {
  traceIndex: number;
  t: number;
  link: string;
  length: number;
  decoded: DecodedFrame;
}

const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
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

/** Decode one Ethernet frame for the packet list and the inspector. */
export function decodeFrame(hex: string): DecodedFrame {
  const bytes = hexToBytes(hex);
  const parsed = parseEthernet(bytes);
  if (!parsed.ok) {
    return parseFailure(bytes, hex, parsed.error.message);
  }

  const eth = parsed.value;
  const srcMac = eth.src.toString();
  const dstMac = eth.dst.toString();
  const dstSuffix = dstMac === BROADCAST_MAC ? " (broadcast)" : "";
  const layers: Layer[] = [
    {
      id: "l2",
      title: `Ethernet II · ${ETHERNET_HEADER_LENGTH} bytes`,
      rows: [
        ["dst", `${dstMac}${dstSuffix}`],
        ["src", srcMac],
        ["etherType", etherTypeLabel(eth.etherType)],
        ["longitud", `${bytes.length} B`],
      ],
      start: 0,
      end: ETHERNET_HEADER_LENGTH,
    },
  ];

  if (eth.etherType === ETHERTYPE_ARP) {
    const arp = parseArp(eth.payload);
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
    layers.push({
      id: "l3",
      title: `ARP · ${request ? "request" : "reply"}`,
      rows: [
        ["htype/ptype", "1 / 0x0800"],
        ["operación", operation],
        ["sender", `${packet.senderIp} · ${packet.senderMac}`],
        ["target", `${packet.targetIp} · ${packet.targetMac}`],
      ],
      start: ETHERNET_HEADER_LENGTH,
      end: Math.min(ETHERNET_HEADER_LENGTH + 28, bytes.length),
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

  if (eth.etherType !== ETHERTYPE_IPV4) {
    return {
      srcMac,
      dstMac,
      srcIp: null,
      dstIp: null,
      protocol: "OTRO",
      summary: `etherType ${etherTypeLabel(eth.etherType)}`,
      isError: false,
      layers,
      hex,
    };
  }

  const ip = parseIpv4(eth.payload);
  if (!ip.ok) {
    return parseFailure(bytes, hex, ip.error.message);
  }

  const { header, payload } = ip.value;
  const ipEnd = ETHERNET_HEADER_LENGTH + header.ihl * 4;
  const totalEnd = Math.min(
    ETHERNET_HEADER_LENGTH + header.totalLength,
    bytes.length,
  );
  layers.push({
    id: "l3",
    title: `IPv4 · ${header.ihl * 4} bytes`,
    rows: [
      ["versión/IHL", `4 / ${header.ihl}`],
      ["longitud total", `${header.totalLength} B`],
      [
        "identificación",
        `0x${header.identification.toString(16).padStart(4, "0")}`,
      ],
      [
        "flags/fragmento",
        `DF=${header.flags.dontFragment ? 1 : 0} MF=${header.flags.moreFragments ? 1 : 0} offset=${header.fragmentOffset}`,
      ],
      ["TTL", String(header.ttl)],
      ["protocolo", ipProtocolLabel(header.protocol)],
      ["checksum", `${checksumText(header.checksum)} · válido`],
      ["origen", header.src.toString()],
      ["destino", header.dst.toString()],
    ],
    start: ETHERNET_HEADER_LENGTH,
    end: ipEnd,
  });

  const base: Omit<
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
      ...base,
      protocol: "OTRO",
      summary: `IPv4 proto ${ipProtocolLabel(header.protocol)}`,
      isError: false,
      layers,
    };
  }

  const icmp = parseIcmp(payload);
  if (!icmp.ok) {
    return parseFailure(bytes, hex, icmp.error.message);
  }

  const message = icmp.value;
  const checksum = (byteAt(payload, 2) << 8) | byteAt(payload, 3);
  const kind = icmpKindName(message.type);
  const rows: Array<[string, string]> = [
    ["tipo/código", `${message.type} / ${message.code} (${kind})`],
  ];
  let summary = `ICMP ${kind}`;
  let isError = false;

  if (message.kind === "echo") {
    rows.push(
      ["identifier", checksumText(message.identifier)],
      ["sequence", String(message.sequence)],
      ["checksum", `${checksumText(checksum)} · válido`],
      ["datos", `${message.data.length} B`],
    );
    summary =
      message.type === ICMP_TYPE_ECHO_REQUEST
        ? `echo request seq=${message.sequence}`
        : `echo reply seq=${message.sequence}`;
  } else if (message.kind === "error") {
    isError = true;
    rows.push(
      ["contexto", checksumText(message.unused)],
      ["checksum", `${checksumText(checksum)} · válido`],
      ["datos embebidos", `${message.embedded.length} B`],
    );
    summary =
      message.type === ICMP_TYPE_TIME_EXCEEDED
        ? "time exceeded in-transit"
        : `dest unreachable code=${message.code}`;
  } else {
    rows.push(
      ["checksum", `${checksumText(checksum)} · válido`],
      ["datos", `${message.data.length} B`],
    );
    summary = `ICMP type ${message.type} code ${message.code}`;
  }

  layers.push({
    id: "l4",
    title: `ICMP · ${kind}`,
    rows,
    start: ipEnd,
    end: totalEnd,
  });

  return {
    ...base,
    protocol: "ICMP",
    summary,
    isError,
    layers,
  };
}

/** Frame-tx traces the packet list understands (ARP and ICMP). */
export function buildPackets(traces: readonly WireTrace[]): PacketRow[] {
  const rows: PacketRow[] = [];
  traces.forEach((trace, traceIndex) => {
    if (trace.kind !== "frame_tx") {
      return;
    }
    const decoded = decodeFrame(trace.frame);
    if (decoded.protocol !== "ARP" && decoded.protocol !== "ICMP") {
      return;
    }
    rows.push({
      traceIndex,
      t: trace.t,
      link: trace.link,
      length: trace.length,
      decoded,
    });
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
  const length = Math.floor(hex.length / 2);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
