import { describe, expect, test } from "bun:test";
import {
  buildHexLines,
  buildPackets,
  decodeFrame,
  hexToBytes,
} from "../src/lib/decode";
import type { WireTrace } from "../src/lib/sim-protocol";

const ARP_REQUEST_HEX =
  "ffffffffffff" +
  "02000000000a" +
  "0806" +
  "0001" +
  "0800" +
  "06" +
  "04" +
  "0001" +
  "02000000000a" +
  "0a000002" +
  "000000000000" +
  "0a000001";

const VLAN_ARP_HEX =
  "ffffffffffff" +
  "02000000000a" +
  "8100" +
  "0064" +
  "0806" +
  "0001" +
  "0800" +
  "06" +
  "04" +
  "0001" +
  "02000000000a" +
  "0a000002" +
  "000000000000" +
  "0a000001";

const ICMP_ECHO_HEX =
  "020000000001" +
  "02000000000a" +
  "0800" +
  "45" +
  "00" +
  "0020" +
  "1234" +
  "4000" +
  "40" +
  "01" +
  "14a7" +
  "0a000002" +
  "0a000001" +
  "08" +
  "00" +
  "3337" +
  "0001" +
  "0001" +
  "61626364";

function fieldOf(hex: string, label: string) {
  const decoded = decodeFrame(hex);
  for (const layer of decoded.layers) {
    const found = layer.rows.find((row) => row.label === label);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`campo "${label}" no decodificado`);
}

describe("decode (inspector)", () => {
  test("decodes an ARP request with field offsets", () => {
    const decoded = decodeFrame(ARP_REQUEST_HEX);
    expect(decoded.protocol).toBe("ARP");
    expect(decoded.summary).toBe("who-has 10.0.0.1? tell 10.0.0.2");
    expect(decoded.srcIp).toBe("10.0.0.2");
    expect(decoded.dstIp).toBe("10.0.0.1");
    expect(decoded.isError).toBe(false);
    const l3 = decoded.layers.find((layer) => layer.id === "l3");
    expect(l3?.start).toBe(14);
    expect(l3?.end).toBe(42);
    expect(fieldOf(ARP_REQUEST_HEX, "operación")).toMatchObject({
      start: 20,
      end: 22,
      value: "1 (who-has)",
    });
    expect(fieldOf(ARP_REQUEST_HEX, "sender IP")).toMatchObject({
      start: 28,
      end: 32,
      value: "10.0.0.2",
    });
  });

  test("peels a single 802.1Q tag and shifts offsets", () => {
    const decoded = decodeFrame(VLAN_ARP_HEX);
    expect(decoded.protocol).toBe("ARP");
    const l2 = decoded.layers.find((layer) => layer.id === "l2");
    expect(l2?.end).toBe(18);
    expect(fieldOf(VLAN_ARP_HEX, "vlan").value).toContain("VID 100");
    expect(fieldOf(VLAN_ARP_HEX, "tpid")).toMatchObject({
      start: 12,
      end: 14,
    });
    const l3 = decoded.layers.find((layer) => layer.id === "l3");
    expect(l3?.start).toBe(18);
    expect(fieldOf(VLAN_ARP_HEX, "operación")).toMatchObject({
      start: 24,
      end: 26,
    });
  });

  test("decodes IPv4/ICMP echo with field offsets", () => {
    const decoded = decodeFrame(ICMP_ECHO_HEX);
    expect(decoded.protocol).toBe("ICMP");
    expect(decoded.summary).toBe("echo request seq=1");
    expect(fieldOf(ICMP_ECHO_HEX, "tipo")).toMatchObject({
      start: 34,
      end: 35,
    });
    expect(fieldOf(ICMP_ECHO_HEX, "TTL")).toMatchObject({
      start: 22,
      end: 23,
      value: "64",
    });
    expect(fieldOf(ICMP_ECHO_HEX, "identifier")).toMatchObject({
      start: 38,
      end: 40,
      value: "0x0001",
    });
    expect(fieldOf(ICMP_ECHO_HEX, "datos")).toMatchObject({
      start: 42,
      end: 46,
    });
  });

  test("truncated and unknown frames fail softly", () => {
    const short = decodeFrame("0102");
    expect(short.isError).toBe(true);
    expect(short.protocol).toBe("OTRO");
    expect(short.summary).toMatch(/^frame ilegible/);
    const unknown = decodeFrame("02000000000102000000000a88b500");
    expect(unknown.isError).toBe(false);
    expect(unknown.protocol).toBe("OTRO");
    expect(unknown.summary).toContain("0x88b5");
    expect(unknown.layers).toHaveLength(1);
  });

  test("rejects non-hex input instead of decoding zeros", () => {
    expect(hexToBytes("zz")).toHaveLength(0);
    expect(hexToBytes("abc")).toHaveLength(0);
    expect(decodeFrame("zz").isError).toBe(true);
  });

  test("memoizes by hex", () => {
    expect(decodeFrame(ARP_REQUEST_HEX)).toBe(decodeFrame(ARP_REQUEST_HEX));
  });

  test("buildPackets keeps tx, rx and drops with direction", () => {
    const traces: Array<WireTrace> = [
      {
        kind: "frame_tx",
        t: 10,
        link: "l1",
        from: "a",
        length: 42,
        frame: ARP_REQUEST_HEX,
      },
      {
        kind: "frame_rx",
        t: 20,
        link: "l1",
        to: "b",
        length: 46,
        frame: ICMP_ECHO_HEX,
      },
      {
        kind: "frame_drop",
        t: 30,
        link: "l1",
        where: "a",
        reason: "loss",
        length: 42,
        frame: ARP_REQUEST_HEX,
      },
      { kind: "state", t: 40, scope: "h1", detail: "up" },
      { kind: "log", t: 50, scope: "h1", level: "info", message: "hola" },
    ];
    const rows = buildPackets(traces);
    expect(rows.map((row) => row.dir)).toEqual(["tx", "rx", "drop"]);
    expect(rows.map((row) => row.traceIndex)).toEqual([0, 1, 2]);
    expect(rows[2]?.dropReason).toBe("loss");
    expect(rows[2]?.decoded.protocol).toBe("ARP");
    expect(rows[0]?.dropReason).toBeNull();
  });

  test("hex tokens carry byte indexes", () => {
    const decoded = decodeFrame(ARP_REQUEST_HEX);
    const lines = buildHexLines(ARP_REQUEST_HEX, decoded.layers);
    const flat = lines.flat();
    expect(flat).toHaveLength(42);
    expect(flat[0]).toMatchObject({ text: "ff", byte: 0 });
    expect(flat[41]).toMatchObject({ byte: 41 });
    expect(flat.map((token) => token.byte)).toEqual(
      flat.map((_, index) => index),
    );
  });
});
