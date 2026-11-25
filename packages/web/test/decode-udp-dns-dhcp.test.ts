import { describe, expect, test } from "bun:test";
import { parseDhcp, parseDns } from "@netlab/protocols";
import type { Layer, LayerId } from "../src/lib/decode";
import { buildHexLines, decodeFrame, hexToBytes } from "../src/lib/decode";
import { buildFlights } from "../src/lib/flights";
import type { WireTrace } from "../src/lib/sim-protocol";

/**
 * Real vectors generated with the `@netlab/protocols` serializers, so the
 * checksums and lengths are the ones the worker puts on the wire.
 *
 * Hosts: h1 = 02:00:00:00:00:0a / 10.0.0.2, h2 = 02:00:00:00:00:01 /
 * 10.0.0.1, DNS server 10.0.0.53.
 *
 * Every frame is 14-byte Ethernet + 20-byte IPv4 (ihl 5), so the UDP header
 * starts at byte 34 and the UDP payload at byte 42.
 */

/** h1 -> h2: UDP 40000 -> 5000 carrying "netlab" (Ethernet-padded to 60 B). */
const UDP_PROBE_HEX =
  "020000000001" +
  "02000000000a" +
  "0800" +
  "45000022" +
  "1234" +
  "4000" +
  "40" +
  "11" +
  "1495" +
  "0a000002" +
  "0a000001" +
  "9c40" +
  "1388" +
  "000e" +
  "f7d2" +
  "6e65746c6162" +
  "000000000000000000000000";

/** h1 -> h2: DNS query id 0x1234, RD=1, ejemplo.test A IN. */
const DNS_QUERY_HEX =
  "020000000001" +
  "02000000000a" +
  "0800" +
  "4500003a" +
  "1234" +
  "4000" +
  "40" +
  "11" +
  "147d" +
  "0a000002" +
  "0a000001" +
  "9c40" +
  "0035" +
  "0026" +
  "1261" +
  "1234" +
  "0100" +
  "0001" +
  "0000" +
  "0000" +
  "0000" +
  "07656a656d706c6f" +
  "0474657374" +
  "00" +
  "0001" +
  "0001";

/** h2 -> h1: DNS response, AA=1, ejemplo.test A 10.0.0.53 TTL 300. */
const DNS_REPLY_HEX =
  "02000000000a" +
  "020000000001" +
  "0800" +
  "4500004a" +
  "1234" +
  "4000" +
  "40" +
  "11" +
  "146d" +
  "0a000001" +
  "0a000002" +
  "0035" +
  "9c40" +
  "0036" +
  "c2cb" +
  "1234" +
  "8500" +
  "0001" +
  "0001" +
  "0000" +
  "0000" +
  "07656a656d706c6f" +
  "0474657374" +
  "00" +
  "0001" +
  "0001" +
  "c00c" +
  "0001" +
  "0001" +
  "0000012c" +
  "0004" +
  "0a000035";

/** h1 -> 255.255.255.255: DHCP DISCOVER xid 0x3903f326 (68 -> 67). */
const DHCP_DISCOVER_HEX =
  "ffffffffffff" +
  "02000000000a" +
  "0800" +
  "4500011c" +
  "1234" +
  "4000" +
  "40" +
  "11" +
  "279e" +
  "00000000" +
  "ffffffff" +
  "0044" +
  "0043" +
  "0108" +
  "f2c1" +
  "01" +
  "01" +
  "06" +
  "00" +
  "3903f326" +
  "0000" +
  "8000" +
  "00000000" +
  "00000000" +
  "00000000" +
  "00000000" +
  "02000000000a00000000000000000000" + // chaddr (16 B)
  "00".repeat(64) + // sname
  "00".repeat(128) + // file
  "63825363" +
  "350101" +
  "32040a000032" +
  "37040103062a" +
  "ff";

/** h2 -> 255.255.255.255: DHCP OFFER xid 0x3903f326, yiaddr 10.0.0.50. */
const DHCP_OFFER_HEX =
  "ffffffffffff" +
  "020000000001" +
  "0800" +
  "4500012e" +
  "1234" +
  "4000" +
  "40" +
  "11" +
  "1d8b" +
  "0a000001" +
  "ffffffff" +
  "0043" +
  "0044" +
  "011a" +
  "dd45" +
  "02" +
  "01" +
  "06" +
  "00" +
  "3903f326" +
  "0000" +
  "8000" +
  "00000000" +
  "0a000032" +
  "0a000001" +
  "00000000" +
  "02000000000a00000000000000000000" + // chaddr (16 B)
  "00".repeat(64) + // sname
  "00".repeat(128) + // file
  "63825363" +
  "350102" +
  "36040a000001" +
  "330400000e10" +
  "0104ffffff00" +
  "03040a000001" +
  "06040a000035" +
  "ff";

/** h1 -> h2: 4 garbage bytes on port 53 (not a DNS message). */
const JUNK_ON_53_HEX =
  "020000000001" +
  "02000000000a" +
  "0800" +
  "45000020" +
  "1234" +
  "4000" +
  "40" +
  "11" +
  "1497" +
  "0a000002" +
  "0a000001" +
  "9c40" +
  "0035" +
  "000c" +
  "b1c0" +
  "deadbeef" +
  "0000000000000000000000000000";

/** h1 -> 255.255.255.255: 20 zero bytes on port 67 (not a DHCP message). */
const JUNK_ON_67_HEX =
  "ffffffffffff" +
  "02000000000a" +
  "0800" +
  "45000030" +
  "1234" +
  "4000" +
  "40" +
  "11" +
  "288a" +
  "00000000" +
  "ffffffff" +
  "0044" +
  "0043" +
  "001c" +
  "ff2f" +
  "0000000000000000000000000000000000000000";

function layerOf(hex: string, id: LayerId): Layer {
  const found = decodeFrame(hex).layers.find((layer) => layer.id === id);
  if (found === undefined) {
    throw new Error(`capa ${id} no decodificada en ${hex.slice(0, 42)}…`);
  }
  return found;
}

function fieldOf(hex: string, layerId: LayerId, label: string) {
  const row = layerOf(hex, layerId).rows.find(
    (candidate) => candidate.label === label,
  );
  if (row === undefined) {
    throw new Error(`campo "${label}" no decodificado en la capa ${layerId}`);
  }
  return row;
}

/** Frame bytes covered by a `[start, end)` range, as lowercase hex. */
function bytesAt(hex: string, start: number, end: number): string {
  return hex.slice(start * 2, end * 2);
}

describe("decode UDP + DNS + DHCP (fase 4)", () => {
  test("decodes a UDP datagram with its offset table and a valid checksum", () => {
    const decoded = decodeFrame(UDP_PROBE_HEX);
    expect(decoded.protocol).toBe("UDP");
    expect(decoded.isError).toBe(false);
    expect(decoded.summary).toBe("UDP 40000 → 5000 · 6 B");
    expect(decoded.srcIp).toBe("10.0.0.2");
    expect(decoded.dstIp).toBe("10.0.0.1");
    expect(decoded.layers.map((layer) => layer.id)).toEqual(["l2", "l3", "l4"]);

    const l4 = layerOf(UDP_PROBE_HEX, "l4");
    expect(l4.start).toBe(34);
    expect(l4.end).toBe(48);
    expect(l4.title).toBe("UDP · 14 bytes");
    expect(fieldOf(UDP_PROBE_HEX, "l4", "puerto origen")).toMatchObject({
      start: 34,
      end: 36,
      value: "40000",
    });
    expect(fieldOf(UDP_PROBE_HEX, "l4", "puerto destino")).toMatchObject({
      start: 36,
      end: 38,
      value: "5000",
    });
    expect(fieldOf(UDP_PROBE_HEX, "l4", "longitud")).toMatchObject({
      start: 38,
      end: 40,
      value: "14 B",
    });
    expect(fieldOf(UDP_PROBE_HEX, "l4", "checksum")).toMatchObject({
      start: 40,
      end: 42,
      value: "0xf7d2 · válido",
    });
    expect(fieldOf(UDP_PROBE_HEX, "l4", "datos")).toMatchObject({
      start: 42,
      end: 48,
      value: "6 B",
    });
    // The payload really is the ASCII the serializer put there.
    expect(bytesAt(UDP_PROBE_HEX, 42, 48)).toBe("6e65746c6162");
    // Ethernet padding stays out of the L4 range and out of the layers.
    expect(bytesAt(UDP_PROBE_HEX, 48, 60)).toBe("000000000000000000000000");
  });

  test("a corrupted UDP checksum fails softly instead of throwing", () => {
    // 0xf7d2 -> 0x00d2: still non-zero, so it is verified (0 means "not
    // computed" per RFC 768) and rejected against the pseudo-header.
    const corrupted = `${UDP_PROBE_HEX.slice(0, 80)}00${UDP_PROBE_HEX.slice(82)}`;
    const decoded = decodeFrame(corrupted);
    expect(decoded.isError).toBe(true);
    expect(decoded.protocol).toBe("OTRO");
    expect(decoded.summary).toMatch(/^frame ilegible: udp/);
  });

  test("decodes a DNS query on port 53 as an L7 layer", () => {
    const decoded = decodeFrame(DNS_QUERY_HEX);
    expect(decoded.protocol).toBe("DNS");
    expect(decoded.isError).toBe(false);
    expect(decoded.summary).toBe("DNS query A ejemplo.test");
    expect(decoded.layers.map((layer) => layer.id)).toEqual([
      "l2",
      "l3",
      "l4",
      "l7",
    ]);

    const l7 = layerOf(DNS_QUERY_HEX, "l7");
    expect(l7.start).toBe(42);
    expect(l7.end).toBe(72);
    expect(l7.title).toBe("DNS · query · 30 bytes");
    expect(fieldOf(DNS_QUERY_HEX, "l7", "id")).toMatchObject({
      start: 42,
      end: 44,
      value: "0x1234",
    });
    expect(fieldOf(DNS_QUERY_HEX, "l7", "flags")).toMatchObject({
      start: 44,
      end: 46,
    });
    expect(fieldOf(DNS_QUERY_HEX, "l7", "flags").value).toContain("QR=0");
    expect(fieldOf(DNS_QUERY_HEX, "l7", "flags").value).toContain("RD=1");
    expect(fieldOf(DNS_QUERY_HEX, "l7", "QDCOUNT")).toMatchObject({
      start: 46,
      end: 48,
      value: "1",
    });
    expect(fieldOf(DNS_QUERY_HEX, "l7", "ANCOUNT")).toMatchObject({
      start: 48,
      end: 50,
      value: "0",
    });
    expect(fieldOf(DNS_QUERY_HEX, "l7", "pregunta 1 nombre")).toMatchObject({
      start: 54,
      end: 68,
      value: "ejemplo.test",
    });
    expect(fieldOf(DNS_QUERY_HEX, "l7", "pregunta 1 tipo")).toMatchObject({
      start: 68,
      end: 70,
      value: "A (1)",
    });
    expect(fieldOf(DNS_QUERY_HEX, "l7", "pregunta 1 clase")).toMatchObject({
      start: 70,
      end: 72,
      value: "IN (1)",
    });
    expect(bytesAt(DNS_QUERY_HEX, 54, 68)).toBe("07656a656d706c6f047465737400");

    // The vector is exactly what the codec parses: real bytes, not a stub.
    const wire = hexToBytes(DNS_QUERY_HEX).slice(42, 72);
    const parsed = parseDns(wire);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.id).toBe(0x1234);
      expect(parsed.value.questions[0]?.name).toBe("ejemplo.test");
    }
  });

  test("decodes a DNS response whose owner name is a compression pointer", () => {
    const decoded = decodeFrame(DNS_REPLY_HEX);
    expect(decoded.protocol).toBe("DNS");
    expect(decoded.summary).toBe("DNS respuesta A ejemplo.test → 10.0.0.53");
    expect(layerOf(DNS_REPLY_HEX, "l7").title).toBe(
      "DNS · respuesta · 46 bytes",
    );
    expect(fieldOf(DNS_REPLY_HEX, "l7", "flags").value).toContain("QR=1");
    expect(fieldOf(DNS_REPLY_HEX, "l7", "flags").value).toContain("AA=1");
    expect(fieldOf(DNS_REPLY_HEX, "l7", "ANCOUNT")).toMatchObject({
      value: "1",
    });
    // c00c: a 2-byte pointer back to the question name at offset 12.
    expect(fieldOf(DNS_REPLY_HEX, "l7", "respuesta 1 nombre")).toMatchObject({
      start: 72,
      end: 74,
      value: "ejemplo.test",
    });
    expect(bytesAt(DNS_REPLY_HEX, 72, 74)).toBe("c00c");
    expect(fieldOf(DNS_REPLY_HEX, "l7", "respuesta 1 TTL")).toMatchObject({
      start: 78,
      end: 82,
      value: "300 s",
    });
    expect(fieldOf(DNS_REPLY_HEX, "l7", "respuesta 1 rdlength")).toMatchObject({
      start: 82,
      end: 84,
      value: "4 B",
    });
    expect(fieldOf(DNS_REPLY_HEX, "l7", "respuesta 1 rdata")).toMatchObject({
      start: 84,
      end: 88,
      value: "10.0.0.53",
    });
    // The L7 layer closes exactly on the last answer byte.
    expect(layerOf(DNS_REPLY_HEX, "l7").end).toBe(DNS_REPLY_HEX.length / 2);
  });

  test("decodes a DHCP DISCOVER with BOOTP and option offsets", () => {
    const decoded = decodeFrame(DHCP_DISCOVER_HEX);
    expect(decoded.protocol).toBe("DHCP");
    expect(decoded.isError).toBe(false);
    expect(decoded.summary).toBe("DHCP DISCOVER xid=0x3903f326");
    expect(decoded.srcIp).toBe("0.0.0.0");
    expect(decoded.dstIp).toBe("255.255.255.255");
    expect(decoded.dstMac).toBe("ff:ff:ff:ff:ff:ff");

    const l7 = layerOf(DHCP_DISCOVER_HEX, "l7");
    expect(l7.start).toBe(42);
    expect(l7.end).toBe(DHCP_DISCOVER_HEX.length / 2);
    expect(l7.title).toBe("DHCP · DISCOVER · 256 bytes");
    expect(fieldOf(DHCP_DISCOVER_HEX, "l7", "op")).toMatchObject({
      start: 42,
      end: 43,
      value: "1 (BOOTREQUEST)",
    });
    expect(fieldOf(DHCP_DISCOVER_HEX, "l7", "xid")).toMatchObject({
      start: 46,
      end: 50,
      value: "0x3903f326",
    });
    expect(fieldOf(DHCP_DISCOVER_HEX, "l7", "flags")).toMatchObject({
      start: 52,
      end: 54,
      value: "0x8000 (broadcast)",
    });
    expect(fieldOf(DHCP_DISCOVER_HEX, "l7", "chaddr")).toMatchObject({
      start: 70,
      end: 86,
      value: "02:00:00:00:00:0a",
    });
    expect(fieldOf(DHCP_DISCOVER_HEX, "l7", "cookie")).toMatchObject({
      start: 278,
      end: 282,
      value: "0x63825363",
    });
    expect(
      fieldOf(DHCP_DISCOVER_HEX, "l7", "opción 53 (message type)"),
    ).toMatchObject({ start: 282, end: 285, value: "DISCOVER (1)" });
    expect(
      fieldOf(DHCP_DISCOVER_HEX, "l7", "opción 50 (requested ip)"),
    ).toMatchObject({ start: 285, end: 291, value: "10.0.0.50" });
    expect(fieldOf(DHCP_DISCOVER_HEX, "l7", "opción 55")).toMatchObject({
      start: 291,
      end: 297,
      value: "4 B",
    });
    expect(fieldOf(DHCP_DISCOVER_HEX, "l7", "fin")).toMatchObject({
      start: 297,
      end: 298,
      value: "end (255)",
    });

    const wire = hexToBytes(DHCP_DISCOVER_HEX).slice(42);
    const parsed = parseDhcp(wire);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.options[0]).toEqual({
        kind: "message-type",
        type: 1,
      });
    }
  });

  test("decodes a DHCP OFFER with the assigned address in the summary", () => {
    const decoded = decodeFrame(DHCP_OFFER_HEX);
    expect(decoded.protocol).toBe("DHCP");
    expect(decoded.summary).toBe(
      "DHCP OFFER xid=0x3903f326 · yiaddr 10.0.0.50",
    );
    expect(layerOf(DHCP_OFFER_HEX, "l7").title).toBe(
      "DHCP · OFFER · 274 bytes",
    );
    expect(fieldOf(DHCP_OFFER_HEX, "l7", "op")).toMatchObject({
      value: "2 (BOOTREPLY)",
    });
    expect(fieldOf(DHCP_OFFER_HEX, "l7", "yiaddr")).toMatchObject({
      start: 58,
      end: 62,
      value: "10.0.0.50",
    });
    expect(
      fieldOf(DHCP_OFFER_HEX, "l7", "opción 54 (server id)"),
    ).toMatchObject({ start: 285, end: 291, value: "10.0.0.1" });
    expect(
      fieldOf(DHCP_OFFER_HEX, "l7", "opción 51 (lease time)"),
    ).toMatchObject({ start: 291, end: 297, value: "3600 s" });
    expect(
      fieldOf(DHCP_OFFER_HEX, "l7", "opción 1 (subnet mask)"),
    ).toMatchObject({ start: 297, end: 303, value: "255.255.255.0" });
    expect(fieldOf(DHCP_OFFER_HEX, "l7", "fin")).toMatchObject({
      start: 315,
      end: 316,
    });
    expect(layerOf(DHCP_OFFER_HEX, "l7").end).toBe(DHCP_OFFER_HEX.length / 2);
  });

  test("an undecodable L7 payload keeps the frame as plain UDP", () => {
    for (const hex of [JUNK_ON_53_HEX, JUNK_ON_67_HEX]) {
      const decoded = decodeFrame(hex);
      expect(decoded.protocol).toBe("UDP");
      expect(decoded.isError).toBe(false);
      expect(decoded.layers.map((layer) => layer.id)).toEqual([
        "l2",
        "l3",
        "l4",
      ]);
      expect(decoded.summary).toMatch(/^UDP \d+ → \d+ · \d+ B$/);
    }
    // Truncated DNS header: parseDns rejects it, decodeFrame never throws.
    expect(() => decodeFrame(JUNK_ON_53_HEX)).not.toThrow();
    // Truncated DHCP body: same fallback, still a valid UDP frame.
    expect(() => decodeFrame(JUNK_ON_67_HEX)).not.toThrow();
  });

  test("hex tokens carry the l4 and l7 layers", () => {
    const decoded = decodeFrame(DNS_REPLY_HEX);
    const flat = buildHexLines(DNS_REPLY_HEX, decoded.layers).flat();
    expect(flat.find((token) => token.byte === 41)?.layer).toBe("l4");
    expect(flat.find((token) => token.byte === 42)?.layer).toBe("l7");
    expect(flat.find((token) => token.byte === 87)?.layer).toBe("l7");
    expect(flat.find((token) => token.byte === 0)?.layer).toBe("l2");
    // IPv4 header = 14..33, UDP header = 34..41, DNS message = 42..87.
    expect(flat.find((token) => token.byte === 33)?.layer).toBe("l3");
    expect(flat.find((token) => token.byte === 34)?.layer).toBe("l4");
    expect(flat).toHaveLength(DNS_REPLY_HEX.length / 2);
  });

  test("decode never throws on any truncation of the new frames", () => {
    const frames = [
      UDP_PROBE_HEX,
      DNS_QUERY_HEX,
      DNS_REPLY_HEX,
      DHCP_DISCOVER_HEX,
      DHCP_OFFER_HEX,
    ];
    for (const hex of frames) {
      const bytes = hexToBytes(hex);
      for (let end = 0; end <= bytes.length; end += 1) {
        const prefix = Array.from(bytes.slice(0, end), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        expect(() => decodeFrame(prefix)).not.toThrow();
      }
      // Every truncation yields a reportable frame, never a thrown error.
      const cut = hex.slice(0, hex.length - 8);
      expect(decodeFrame(cut).summary.length).toBeGreaterThan(0);
    }
  });

  test("memoized frames are never mutated by callers", () => {
    const first = decodeFrame(DNS_REPLY_HEX);
    const snapshot = JSON.stringify(first);
    buildHexLines(first.hex, first.layers);
    const second = decodeFrame(DNS_REPLY_HEX);
    expect(second).toBe(first);
    expect(JSON.stringify(second)).toBe(snapshot);
    expect(second.layers).toBe(first.layers);
  });

  test("flights keep the innermost protocol for coloring", () => {
    const traces: Array<WireTrace> = [
      {
        kind: "frame_tx",
        t: 10,
        link: "l-r1-h2",
        from: "b",
        length: 88,
        frame: DNS_REPLY_HEX,
      },
      {
        kind: "frame_rx",
        t: 30,
        link: "l-r1-h2",
        to: "b",
        length: 88,
        frame: DNS_REPLY_HEX,
      },
      {
        kind: "frame_tx",
        t: 40,
        link: "l-h1-r1",
        from: "a",
        length: 60,
        frame: UDP_PROBE_HEX,
      },
      {
        kind: "frame_rx",
        t: 60,
        link: "l-h1-r1",
        to: "a",
        length: 60,
        frame: UDP_PROBE_HEX,
      },
    ];
    const flights = buildFlights(traces);
    expect(flights.map((flight) => flight.protocol)).toEqual(["DNS", "UDP"]);
    expect(flights.map((flight) => flight.outcome)).toEqual([
      "delivered",
      "delivered",
    ]);
  });
});
