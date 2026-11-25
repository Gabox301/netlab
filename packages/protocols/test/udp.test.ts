import { describe, expect, test } from "bun:test";
import { Ipv4Address } from "@netlab/bytes";
import { parseUdp, serializeUdp } from "../src/udp";

const SRC = Ipv4Address.parse("10.0.0.2");
const DST = Ipv4Address.parse("10.0.0.1");

describe("udp codec (F-50)", () => {
  test("round-trips ports and payload with a valid checksum", () => {
    const bytes = serializeUdp(
      { srcPort: 1234, dstPort: 53, payload: new Uint8Array([1, 2, 3]) },
      SRC,
      DST,
    );
    const parsed = parseUdp(bytes, { src: SRC, dst: DST });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.srcPort).toBe(1234);
    expect(parsed.value.dstPort).toBe(53);
    expect(Array.from(parsed.value.payload)).toEqual([1, 2, 3]);
  });

  test("rejects truncated headers without throwing", () => {
    const parsed = parseUdp(new Uint8Array([0, 1, 2]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe("truncated");
  });

  test("rejects a corrupt checksum when addresses are known", () => {
    const bytes = serializeUdp(
      { srcPort: 9, dstPort: 9, payload: new Uint8Array([7]) },
      SRC,
      DST,
    );
    const checksumHigh = bytes[6] ?? 0;
    bytes[6] = checksumHigh ^ 0xff;
    const parsed = parseUdp(bytes, { src: SRC, dst: DST });
    expect(parsed.ok).toBe(false);
  });
});
