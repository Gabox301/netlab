import { describe, expect, test } from "bun:test";
import { buildFlights } from "../src/lib/flights";
import type { WireTrace } from "../src/lib/sim-protocol";

const ARP_HEX =
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

const ICMP_HEX =
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

describe("flights (F-87 S1)", () => {
  test("pairs tx->rx into a delivered flight with protocol", () => {
    const traces: WireTrace[] = [
      {
        t: 100,
        kind: "frame_tx",
        link: "l-h1-r1",
        from: "a",
        length: 42,
        frame: ARP_HEX,
      },
      {
        t: 110,
        kind: "frame_rx",
        link: "l-h1-r1",
        to: "b",
        length: 42,
        frame: ARP_HEX,
      },
    ];
    const flights = buildFlights(traces);
    expect(flights.length).toBe(1);
    expect(flights[0]).toMatchObject({
      linkId: "l-h1-r1",
      from: "a",
      startUs: 100,
      endUs: 110,
      protocol: "ARP",
      outcome: "delivered",
    });
  });

  test("end - start respects the configured link latency", () => {
    const traces: WireTrace[] = [
      {
        t: 0,
        kind: "frame_tx",
        link: "l-h1-r1",
        from: "a",
        length: 64,
        frame: ICMP_HEX,
      },
      {
        t: 10,
        kind: "frame_rx",
        link: "l-h1-r1",
        to: "b",
        length: 64,
        frame: ICMP_HEX,
      },
    ];
    const flights = buildFlights(traces);
    expect(flights.length).toBe(1);
    expect(
      (flights[0]?.endUs ?? 0) - (flights[0]?.startUs ?? 0),
    ).toBeGreaterThanOrEqual(10);
  });

  test("pairs tx->drop into a dropped flight with reason", () => {
    const traces: WireTrace[] = [
      {
        t: 50,
        kind: "frame_tx",
        link: "l-r1-h2",
        from: "b",
        length: 64,
        frame: ICMP_HEX,
      },
      {
        t: 60,
        kind: "frame_drop",
        link: "l-r1-h2",
        where: "l-r1-h2:b>a",
        reason: "loss",
        length: 64,
        frame: ICMP_HEX,
      },
    ];
    const flights = buildFlights(traces);
    expect(flights.length).toBe(1);
    expect(flights[0]).toMatchObject({
      linkId: "l-r1-h2",
      from: "b",
      outcome: "dropped",
      dropReason: "loss",
      protocol: "ICMP",
    });
    expect(flights[0]?.endUs).toBe(60);
  });

  test("keeps opposite directions independent with FIFO order", () => {
    const traces: WireTrace[] = [
      {
        t: 0,
        kind: "frame_tx",
        link: "l-h1-r1",
        from: "a",
        length: 42,
        frame: ARP_HEX,
      },
      {
        t: 1,
        kind: "frame_tx",
        link: "l-h1-r1",
        from: "b",
        length: 64,
        frame: ICMP_HEX,
      },
      {
        t: 5,
        kind: "frame_rx",
        link: "l-h1-r1",
        to: "a",
        length: 64,
        frame: ICMP_HEX,
      },
      {
        t: 10,
        kind: "frame_rx",
        link: "l-h1-r1",
        to: "b",
        length: 42,
        frame: ARP_HEX,
      },
    ];
    const flights = buildFlights(traces);
    expect(flights.length).toBe(2);
    expect(flights[0]).toMatchObject({
      from: "b",
      protocol: "ICMP",
      startUs: 1,
      endUs: 5,
    });
    expect(flights[1]).toMatchObject({
      from: "a",
      protocol: "ARP",
      startUs: 0,
      endUs: 10,
    });
  });
});
