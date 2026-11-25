import { describe, expect, test } from "bun:test";
import type { PacketRow } from "../src/lib/decode";
import { buildPackets } from "../src/lib/decode";
import {
  compileFilter,
  FLOW_BOTTOM,
  FLOW_TOP,
  FLOW_WIDTH,
  type FlowFlight,
  flowArrows,
  flowLanes,
} from "../src/lib/filter";
import type { EndpointSide, WireTrace } from "../src/lib/sim-protocol";

/**
 * The same real vectors the UDP/DNS/DHCP decoder test uses: every frame was
 * produced by the `@netlab/protocols` serializers, so the fields the filter
 * reads are the ones the worker puts on the wire.
 *
 * Hosts: h1 = 02:00:00:00:00:0a / 10.0.0.2, h2 = 02:00:00:00:00:01 /
 * 10.0.0.1, DNS server 10.0.0.53.
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

/** Unknown EtherType: the decoder keeps it as OTRO with no IP addresses. */
const OTRO_HEX = "02000000000102000000000a1234deadbeef";

const FIXTURES: ReadonlyArray<{
  name: string;
  hex: string;
  link: string;
  from: EndpointSide;
}> = [
  { name: "udp", hex: UDP_PROBE_HEX, link: "l-h1-r1", from: "a" },
  { name: "dns-query", hex: DNS_QUERY_HEX, link: "l-h1-r1", from: "a" },
  { name: "dns-reply", hex: DNS_REPLY_HEX, link: "l-r1-h2", from: "b" },
  {
    name: "dhcp-discover",
    hex: DHCP_DISCOVER_HEX,
    link: "l-h1-r1",
    from: "a",
  },
  { name: "dhcp-offer", hex: DHCP_OFFER_HEX, link: "l-r1-h2", from: "b" },
  { name: "otro", hex: OTRO_HEX, link: "l-h1-r1", from: "a" },
];

const ROWS: ReadonlyMap<string, PacketRow> = new Map(
  buildPackets(
    FIXTURES.map(
      (fixture, index): WireTrace => ({
        kind: "frame_tx",
        t: index,
        link: fixture.link,
        from: fixture.from,
        length: fixture.hex.length / 2,
        frame: fixture.hex,
      }),
    ),
  ).map((packet, index) => [FIXTURES[index]?.name ?? "", packet]),
);

function row(name: string): PacketRow {
  const found = ROWS.get(name);
  if (found === undefined) {
    throw new Error(`falta el vector de prueba "${name}"`);
  }
  return found;
}

/** Compile and evaluate, failing the test when the expression is invalid. */
function matches(expression: string, packet: PacketRow): boolean {
  const compiled = compileFilter(expression);
  if (!compiled.ok) {
    throw new Error(
      `"${expression}" no compiló: ${compiled.error.code} · ${compiled.error.message}`,
    );
  }
  return compiled.pred(packet);
}

/** Typed error code of an expression that must be rejected. */
function errorCode(expression: string): string {
  const compiled = compileFilter(expression);
  if (compiled.ok) {
    throw new Error(`"${expression}" debía fallar y compiló`);
  }
  expect(compiled.error.message.length).toBeGreaterThan(0);
  expect(compiled.error.position).toBeGreaterThanOrEqual(0);
  return compiled.error.code;
}

describe("filter expression (F-93)", () => {
  test("an empty expression matches every packet", () => {
    for (const packet of ROWS.values()) {
      expect(matches("", packet)).toBe(true);
      expect(matches("   ", packet)).toBe(true);
    }
  });

  test("text fields compare case-insensitively where the spec says so", () => {
    expect(matches("protocol == dns", row("dns-query"))).toBe(true);
    expect(matches("protocol == DNS", row("dns-query"))).toBe(true);
    expect(matches("protocol == dns", row("udp"))).toBe(false);
    expect(matches("protocol == otro", row("otro"))).toBe(true);

    expect(matches("dns.name == ejemplo.test", row("dns-query"))).toBe(true);
    expect(matches("dns.name == EJEMPLO.TEST", row("dns-query"))).toBe(true);
    expect(matches("dns.name == ejemplo.test", row("dns-reply"))).toBe(true);
    expect(matches("dns.name == otro.test", row("dns-query"))).toBe(false);

    // The spec only makes `protocol` and `dns.name` case-insensitive.
    expect(matches("dhcp.type == DISCOVER", row("dhcp-discover"))).toBe(true);
    expect(matches("dhcp.type == discover", row("dhcp-discover"))).toBe(false);
  });

  test("numeric fields read the decoded UDP header and the frame length", () => {
    expect(
      matches(
        "udp.sport == 40000 && udp.dport == 5000 && len == 60",
        row("udp"),
      ),
    ).toBe(true);
    expect(matches("udp.dport == 5000", row("udp"))).toBe(true);
    expect(matches("udp.dport == 5000", row("dns-query"))).toBe(false);

    // DNS runs over UDP: the ports come from the decoded L4 layer.
    expect(matches("udp.dport == 53", row("dns-query"))).toBe(true);
    expect(matches("udp.sport == 53", row("dns-query"))).toBe(false);
    expect(matches("udp.sport == 53", row("dns-reply"))).toBe(true);
    expect(matches("udp.dport == 67", row("dhcp-discover"))).toBe(true);
    expect(matches("udp.sport == 68", row("dhcp-discover"))).toBe(true);

    expect(matches("len >= 60", row("udp"))).toBe(true);
    expect(matches("len > 60", row("udp"))).toBe(false);
    expect(matches("len > 200", row("dhcp-discover"))).toBe(true);
    expect(matches("len <= 18", row("otro"))).toBe(true);
  });

  test("a field that does not apply is false, except for !=", () => {
    // OTRO has no IPv4 header at all.
    expect(matches("ip.src == 10.0.0.2", row("otro"))).toBe(false);
    expect(matches("ip.src != 10.0.0.2", row("otro"))).toBe(true);
    // ARP-like / non-UDP frames have no UDP ports.
    expect(matches("udp.dport == 53", row("otro"))).toBe(false);
    expect(matches("udp.dport != 53", row("otro"))).toBe(true);
    // dns.name only exists in DNS messages.
    expect(matches("dns.name == ejemplo.test", row("udp"))).toBe(false);
    expect(matches("dns.name != ejemplo.test", row("udp"))).toBe(true);
    // dhcp.type only exists in DHCP messages.
    expect(matches("dhcp.type == DISCOVER", row("dns-query"))).toBe(false);
    expect(matches("dhcp.type != DISCOVER", row("dns-query"))).toBe(true);
    // ip.src does apply on this real DNS query, so != is false.
    expect(matches("ip.src != 10.0.0.2", row("dns-query"))).toBe(false);
  });

  test("AND combines the protocol chips with the expression", () => {
    expect(
      matches(
        "protocol == dns && ip.src == 10.0.0.2 && udp.dport == 53",
        row("dns-query"),
      ),
    ).toBe(true);
    expect(
      matches("protocol == dns && udp.dport == 53", row("dns-reply")),
    ).toBe(false);
    expect(
      matches(
        "protocol == dhcp && dhcp.type == DISCOVER && ip.src == 0.0.0.0",
        row("dhcp-discover"),
      ),
    ).toBe(true);
    expect(
      matches("protocol == dhcp && dhcp.type == OFFER", row("dhcp-offer")),
    ).toBe(true);
  });

  test("precedence: ! over comparison, && over ||", () => {
    // `!(protocol == dns)`: negation applies to the whole comparison.
    expect(matches("!protocol == dns", row("udp"))).toBe(true);
    expect(matches("!protocol == dns", row("dns-query"))).toBe(false);
    expect(matches("!!protocol == dns", row("dns-query"))).toBe(true);

    // `a && b || c` groups as `(a && b) || c`. OTRO only matches the `||`
    // branch, so true proves `&&` bound tighter.
    expect(
      matches(
        "protocol == dns && udp.dport == 53 || protocol == otro",
        row("otro"),
      ),
    ).toBe(true);
    // If `||` had bound tighter this would be `dns && (53 || otro)` = false.
    expect(
      matches(
        "protocol == dns && udp.dport == 53 || protocol == otro",
        row("udp"),
      ),
    ).toBe(false);
    // `a || b && c` groups as `a || (b && c)`.
    expect(
      matches(
        "protocol == udp || protocol == dns && udp.dport == 999",
        row("udp"),
      ),
    ).toBe(true);
    expect(
      matches(
        "protocol == udp || protocol == dns && udp.dport == 999",
        row("dns-query"),
      ),
    ).toBe(false);
  });

  test("parentheses override precedence and nest", () => {
    expect(
      matches(
        "(protocol == dns || protocol == dhcp) && udp.dport == 53",
        row("dns-query"),
      ),
    ).toBe(true);
    expect(
      matches(
        "(protocol == dns || protocol == dhcp) && udp.dport == 53",
        row("dhcp-discover"),
      ),
    ).toBe(false);
    expect(
      matches(
        "protocol == dns && (udp.dport == 53 || protocol == otro)",
        row("otro"),
      ),
    ).toBe(false);
    expect(matches("!(protocol == dns || protocol == dhcp)", row("udp"))).toBe(
      true,
    );
    expect(
      matches("!(protocol == dns || protocol == dhcp)", row("dhcp-offer")),
    ).toBe(false);
    expect(matches("((protocol == dns))", row("dns-reply"))).toBe(true);
  });

  test("rejects malformed input with typed errors instead of throwing", () => {
    expect(errorCode("tcp.port == 80")).toBe("unknown-field");
    expect(errorCode("protocol > udp")).toBe("type-mismatch");
    expect(errorCode("ip.src >= 10.0.0.2")).toBe("type-mismatch");
    expect(errorCode("udp.dport == abc")).toBe("invalid-number");
    expect(errorCode('udp.dport == "53"')).toBe("invalid-number");
    expect(errorCode("protocol == ")).toBe("expected-value");
    expect(errorCode("protocol")).toBe("expected-operator");
    expect(errorCode("protocol == dns &&")).toBe("expected-field");
    expect(errorCode("(protocol == dns")).toBe("unclosed-paren");
    expect(errorCode('protocol == "dns')).toBe("unclosed-quote");
    expect(errorCode("protocol = dns")).toBe("unknown-operator");
    expect(errorCode("protocol == dns )")).toBe("unexpected-token");
    expect(errorCode("protocol == dns @ ip.src == 1.2.3.4")).toBe(
      "unexpected-character",
    );
  });

  test("the parser is total: garbage never throws and always reports", () => {
    const garbage = [
      "",
      " ",
      "(",
      ")",
      "!",
      "!!",
      "&&",
      "||",
      "()",
      "protocol",
      "protocol ==",
      "protocol == dns && ",
      '"',
      'protocol == "',
      "((((",
      "protocol == dns && || ip.src == 1.2.3.4",
      "ip.src == 10.0.0.1 &&",
      "udp.dport >= ",
      "len >< 3",
      "dns.name == ejemplo.test )(",
      "protocol == dns , protocol == udp",
      ".".repeat(64),
    ];
    for (const expression of garbage) {
      expect(() => compileFilter(expression)).not.toThrow();
      const compiled = compileFilter(expression);
      if (!compiled.ok) {
        expect(compiled.error.code.length).toBeGreaterThan(0);
        expect(compiled.error.message.length).toBeGreaterThan(0);
      }
    }
    // Deep nesting is rejected by a depth guard, not a stack overflow.
    expect(
      errorCode(`${"(".repeat(200)}protocol == dns${")".repeat(200)}`),
    ).toBe("too-deep");
    expect(errorCode(`${"!".repeat(200)}protocol == dns`)).toBe("too-deep");
  });
});

describe("flow graph (F-95, parte UDP)", () => {
  test("lanes spread the devices from deviceRows in order", () => {
    const lanes = flowLanes(["h1", "r1", "h2"]);
    expect(lanes.map((lane) => lane.device)).toEqual(["h1", "r1", "h2"]);
    expect(lanes[0]?.x ?? -1).toBeGreaterThan(0);
    expect(lanes[2]?.x ?? Infinity).toBeLessThan(FLOW_WIDTH);
    expect(lanes[0]?.x ?? 0).toBeLessThan(lanes[1]?.x ?? 0);
    expect(lanes[1]?.x ?? 0).toBeLessThan(lanes[2]?.x ?? 0);

    expect(flowLanes([])).toEqual([]);
    expect(flowLanes(["h1"])).toEqual([{ device: "h1", x: FLOW_WIDTH / 2 }]);
  });

  test("maps a flight to an arrow by linkId + from", () => {
    const flights: FlowFlight[] = [
      {
        linkId: "l-h1-r1",
        from: "a",
        startUs: 0,
        endUs: 10,
        protocol: "ICMP",
        outcome: "delivered",
      },
      {
        linkId: "l-h1-r1",
        from: "b",
        startUs: 20,
        endUs: 30,
        protocol: "ARP",
        outcome: "delivered",
      },
      {
        linkId: "l-r1-h2",
        from: "a",
        startUs: 40,
        endUs: 50,
        protocol: "UDP",
        outcome: "delivered",
      },
      {
        linkId: "l-r1-h2",
        from: "b",
        startUs: 60,
        endUs: 70,
        protocol: "DNS",
        outcome: "dropped",
      },
    ];
    const lanes = flowLanes(["h1", "r1", "h2"]);
    const arrows = flowArrows(flights, lanes, { fromUs: 0, toUs: 100 });

    expect(arrows.map((arrow) => [arrow.fromDevice, arrow.toDevice])).toEqual([
      ["h1", "r1"],
      ["r1", "h1"],
      ["r1", "h2"],
      ["h2", "r1"],
    ]);
    expect(arrows.map((arrow) => arrow.protocol)).toEqual([
      "ICMP",
      "ARP",
      "UDP",
      "DNS",
    ]);
    expect(arrows.map((arrow) => arrow.outcome)).toEqual([
      "delivered",
      "delivered",
      "delivered",
      "dropped",
    ]);
    // Arrow ends sit on the lane x coordinates (same source as the labels).
    const x = new Map(lanes.map((lane) => [lane.device, lane.x]));
    for (const arrow of arrows) {
      expect(arrow.x1).toBe(x.get(arrow.fromDevice) ?? -1);
      expect(arrow.x2).toBe(x.get(arrow.toDevice) ?? -1);
    }
    // Distinct keys so Svelte can key the #each block.
    expect(new Set(arrows.map((arrow) => arrow.key)).size).toBe(arrows.length);
  });

  test("drops flights outside the window or on unknown links", () => {
    const lanes = flowLanes(["h1", "r1", "h2"]);
    const base: Omit<FlowFlight, "linkId" | "from" | "startUs" | "endUs"> = {
      protocol: "UDP",
      outcome: "delivered",
    };
    const flights: FlowFlight[] = [
      { ...base, linkId: "l-h1-r1", from: "a", startUs: 0, endUs: 10 },
      { ...base, linkId: "l-h1-r1", from: "a", startUs: 100, endUs: 110 },
      { ...base, linkId: "l-h1-r1", from: "a", startUs: 500, endUs: 510 },
      { ...base, linkId: "l-nope", from: "a", startUs: 20, endUs: 30 },
    ];
    const arrows = flowArrows(flights, lanes, { fromUs: 0, toUs: 100 });
    // 500..510 is outside; l-nope has no known endpoints.
    expect(arrows.map((arrow) => arrow.startUs)).toEqual([0, 100]);
    // Time maps top (window start) to bottom (window end).
    expect(arrows[0]?.y).toBe(FLOW_TOP);
    expect(arrows[1]?.y).toBe(FLOW_BOTTOM);

    // A link whose devices are not on the panel is skipped, not drawn.
    expect(
      flowArrows(
        [{ ...base, linkId: "l-h1-r1", from: "a", startUs: 0, endUs: 10 }],
        flowLanes(["r1"]),
        { fromUs: 0, toUs: 100 },
      ),
    ).toEqual([]);
  });

  test("keeps a flight that is still in transit at the window edge", () => {
    const lanes = flowLanes(["h1", "r1", "h2"]);
    const arrows = flowArrows(
      [
        {
          linkId: "l-h1-r1",
          from: "b",
          startUs: 80,
          endUs: 200,
          protocol: "DHCP",
          outcome: "delivered",
        },
      ],
      lanes,
      { fromUs: 0, toUs: 100 },
    );
    expect(arrows).toHaveLength(1);
    expect(arrows[0]?.startUs).toBe(80);
    expect(arrows[0]?.y ?? -1).toBeGreaterThan(FLOW_TOP);
    expect(arrows[0]?.y ?? Infinity).toBeLessThanOrEqual(FLOW_BOTTOM);

    // A zero-width window at t=0 pins its flights to the top edge.
    const atZero = flowArrows(
      [
        {
          linkId: "l-h1-r1",
          from: "a",
          startUs: 0,
          endUs: 10,
          protocol: "UDP",
          outcome: "delivered",
        },
      ],
      lanes,
      { fromUs: 0, toUs: 0 },
    );
    expect(atZero[0]?.y).toBe(FLOW_TOP);
  });
});
