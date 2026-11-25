/**
 * `send` — the hand-built frame command (F-101, CLI shape).
 *
 * The parser validates MAC, ethertype and hex payload and stays total (typed
 * errors, never exceptions); execution goes through `Host.sendRaw()`, so the
 * frame bypasses ARP and routing and lands on the wire exactly as written.
 */

import { describe, expect, test } from "bun:test";
import {
  parseCommandLine,
  type ShellCommand,
  ShellCommandError,
  type ShellError,
} from "../src/index";
import { Shell } from "../src/shell";
import { IP_B_SAME_SUBNET, MAC_B, sameSubnetLab } from "./lab";

const CUSTOM_ETHERTYPE = 0x88b5;

function accepted(line: string): ShellCommand {
  const result = parseCommandLine(line);
  if (!result.ok) {
    throw new Error(
      `expected ${JSON.stringify(line)} to parse: ${result.error.message}`,
    );
  }
  return result.value;
}

function rejected(line: string): ShellError {
  const result = parseCommandLine(line);
  if (result.ok) {
    throw new Error(`expected ${JSON.stringify(line)} to be rejected`);
  }
  return result.error;
}

describe("parse: send (F-101)", () => {
  test("parses iface, destination MAC, ethertype and hex payload", () => {
    expect(accepted(`send eth0 ${MAC_B} 0x0806 deadbeef`)).toEqual({
      kind: "send",
      iface: "eth0",
      dstMac: MAC_B,
      etherType: 0x0806,
      payload: "deadbeef",
    });
  });

  test("normalizes the MAC and the payload case, accepts decimal ethertype", () => {
    expect(accepted("send eth0 02:00:00:00:00:0B 2048 DEAD")).toEqual({
      kind: "send",
      iface: "eth0",
      dstMac: MAC_B,
      etherType: 0x0800,
      payload: "dead",
    });
  });

  test("missing arguments are typed errors", () => {
    for (const line of [
      "send",
      "send eth0",
      `send eth0 ${MAC_B}`,
      `send eth0 ${MAC_B} 0x0806`,
    ]) {
      const error = rejected(line);
      expect(error).toMatchObject({
        kind: "shell_error",
        code: "missing_argument",
      });
    }
  });

  test("invalid MAC, ethertype and payload are typed errors", () => {
    expect(rejected(`send eth0 nope 0x0806 00`)).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("MAC"),
    });
    expect(rejected(`send eth0 ${MAC_B} 0x10000 00`)).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("ethertype"),
    });
    expect(rejected(`send eth0 ${MAC_B} zzz 00`)).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("ethertype"),
    });
    expect(rejected(`send eth0 ${MAC_B} 0x0806 zz`)).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("hex"),
    });
    expect(rejected(`send eth0 ${MAC_B} 0x0806 abc`)).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("even"),
    });
  });

  test("flags and extra arguments are typed errors", () => {
    expect(rejected(`send -x ${MAC_B} 0x0806 00`)).toMatchObject({
      code: "unknown_flag",
    });
    expect(rejected(`send eth0 ${MAC_B} 0x0806 00 extra`)).toMatchObject({
      code: "unexpected_argument",
    });
  });
});

describe("send: execution (F-101)", () => {
  test("transmits the frame byte for byte, bypassing ARP", async () => {
    const { sim, bus, a, b } = sameSubnetLab();
    const atB: Array<{ etherType: number; bytes: Uint8Array }> = [];
    b.onPayload = (_iface, etherType, payload) => {
      atB.push({ etherType, bytes: payload.slice() });
    };
    const shell = new Shell({ host: a, sim });

    const lines = await shell.exec(`send eth0 ${MAC_B} 0x88b5 cafe`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `send eth0 02:00:00:00:00:0a -> ${MAC_B} ethertype 0x88b5`,
    );
    // A 2-byte payload is padded up to the 60-byte Ethernet minimum.
    expect(lines[1]).toBe(
      "sent 60 bytes (14 header + 46 payload, padded from 2)",
    );

    sim.runAll();

    expect(atB).toHaveLength(1);
    expect(atB[0]?.etherType).toBe(CUSTOM_ETHERTYPE);
    expect(atB[0]?.bytes.subarray(0, 2)).toEqual(new Uint8Array([0xca, 0xfe]));
    // No ARP: the frame went out with the destination MAC it was given.
    expect(a.arpLookup("eth0", IP_B_SAME_SUBNET)).toBeUndefined();
    const tx = bus
      .drain()
      .filter((trace) => trace.kind === "frame_tx" && trace.link === "l0");
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ length: 60, from: "a" });
  });

  test("a payload at the Ethernet minimum is not reported as padded", async () => {
    const { sim, a } = sameSubnetLab();
    const shell = new Shell({ host: a, sim });
    // 46 bytes of payload fill the 60-byte Ethernet minimum exactly.
    const payload = "aa".repeat(46);
    const lines = await shell.exec(`send eth0 ${MAC_B} 0x0806 ${payload}`);
    expect(lines[1]).toBe("sent 60 bytes (14 header + 46 payload)");
  });

  test("an unknown interface is a typed execution error", async () => {
    const { sim, a } = sameSubnetLab();
    const shell = new Shell({ host: a, sim });
    let error: unknown;
    try {
      await shell.exec("send eth9 02:00:00:00:00:0b 0x0806 00");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ShellCommandError);
    expect((error as ShellCommandError).code).toBe("invalid_argument");
    expect((error as ShellCommandError).message).toContain("eth9");
  });

  test("a down interface fails the command instead of throwing raw", async () => {
    const { sim, a } = sameSubnetLab();
    a.getInterface("eth0").up = false;
    const shell = new Shell({ host: a, sim });
    let error: unknown;
    try {
      await shell.exec("send eth0 02:00:00:00:00:0b 0x0806 00");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ShellCommandError);
    expect((error as ShellCommandError).code).toBe("execution_failed");
  });

  test("help lists the command", async () => {
    const { sim, a } = sameSubnetLab();
    const shell = new Shell({ host: a, sim });
    const lines = await shell.exec("help");
    expect(lines.some((line) => line.startsWith("send "))).toBe(true);
  });
});
