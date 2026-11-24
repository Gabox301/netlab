/**
 * Command-line parsing for the shell (S9): every malformed input becomes a
 * typed error instead of an exception, and the accepted grammar is pinned.
 */

import { describe, expect, test } from "bun:test";
import {
  parseCommandLine,
  type ShellCommand,
  type ShellError,
} from "../src/index";

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

describe("parse: ip grammar (S7)", () => {
  test("parses show commands with optional device filters", () => {
    expect(accepted("ip addr")).toEqual({ kind: "ip.addr.show" });
    expect(accepted("ip addr show")).toEqual({ kind: "ip.addr.show" });
    expect(accepted("ip addr show dev eth0")).toEqual({
      kind: "ip.addr.show",
      iface: "eth0",
    });
    expect(accepted("ip link")).toEqual({ kind: "ip.link.show" });
    expect(accepted("ip link show eth0")).toEqual({
      kind: "ip.link.show",
      iface: "eth0",
    });
    expect(accepted("ip route")).toEqual({ kind: "ip.route.show" });
    expect(accepted("ip route show")).toEqual({ kind: "ip.route.show" });
    expect(accepted("ip neigh")).toEqual({ kind: "ip.neigh.show" });
    expect(accepted("ip neigh dev eth0")).toEqual({
      kind: "ip.neigh.show",
      iface: "eth0",
    });
  });

  test("parses addressing and link state mutations (S5)", () => {
    expect(
      accepted("ip addr add 10.0.0.9/24 dev eth0 gateway 10.0.0.1"),
    ).toEqual({
      kind: "ip.addr.set",
      ip: "10.0.0.9/24",
      iface: "eth0",
      gateway: "10.0.0.1",
    });
    expect(accepted("ip addr set 10.0.0.9 dev eth0")).toEqual({
      kind: "ip.addr.set",
      ip: "10.0.0.9",
      iface: "eth0",
    });
    expect(accepted("ip link set eth0 down")).toEqual({
      kind: "ip.link.set",
      iface: "eth0",
      up: false,
    });
    expect(accepted("ip link set eth0 up")).toEqual({
      kind: "ip.link.set",
      iface: "eth0",
      up: true,
    });
  });

  test("parses arp -a", () => {
    expect(accepted("arp")).toEqual({ kind: "arp" });
    expect(accepted("arp -a")).toEqual({ kind: "arp" });
  });
});

describe("parse: ping and traceroute grammar (S7)", () => {
  test("applies the documented defaults", () => {
    expect(accepted("ping 10.0.0.3")).toEqual({
      kind: "ping",
      dst: "10.0.0.3",
      count: 4,
      size: 56,
      ttl: 64,
    });
    expect(accepted("traceroute 10.0.1.2")).toEqual({
      kind: "traceroute",
      dst: "10.0.1.2",
    });
  });

  test("accepts separated and attached flag values", () => {
    expect(accepted("ping -c 2 -s 16 -t 5 10.0.0.3")).toEqual({
      kind: "ping",
      dst: "10.0.0.3",
      count: 2,
      size: 16,
      ttl: 5,
    });
    expect(accepted("ping -c2 -s16 -t5 10.0.0.3")).toEqual({
      kind: "ping",
      dst: "10.0.0.3",
      count: 2,
      size: 16,
      ttl: 5,
    });
  });
});

describe("parse: typed errors (S9)", () => {
  test("rejects unknown commands and flags with typed codes", () => {
    expect(rejected("").code).toBe("empty_command");
    expect(rejected("   ").code).toBe("empty_command");
    expect(rejected("nope").code).toBe("unknown_command");
    expect(rejected("ip wat").code).toBe("unknown_subcommand");
    expect(rejected("ping -z 10.0.0.3").code).toBe("unknown_flag");
    expect(rejected("traceroute -x 10.0.1.2").code).toBe("unknown_flag");
    expect(rejected("arp -n").code).toBe("unknown_flag");
  });

  test("rejects missing, invalid and extra arguments", () => {
    expect(rejected("ping").code).toBe("missing_argument");
    expect(rejected("ping -c").code).toBe("missing_argument");
    expect(rejected("ip addr show dev").code).toBe("missing_argument");
    expect(rejected("ping -c x 10.0.0.3").code).toBe("invalid_argument");
    expect(rejected("ping -c 70000 10.0.0.3").code).toBe("invalid_argument");
    expect(rejected("ping -s -1 10.0.0.3").code).toBe("invalid_argument");
    expect(rejected("ping -t 0 10.0.0.3").code).toBe("invalid_argument");
    expect(rejected("ping 999.0.0.1").code).toBe("invalid_argument");
    expect(rejected("ping 10.0.0.3 extra").code).toBe("unexpected_argument");
    expect(rejected("ip link set eth0 sideways").code).toBe("invalid_argument");
    expect(rejected("ip addr add 10.0.0.9/99 dev eth0").code).toBe(
      "invalid_argument",
    );
  });

  test("keeps route mutation explicitly unsupported", () => {
    const error = rejected("ip route add 10.0.1.0/24 via 10.0.0.1");
    expect(error.code).toBe("unsupported");
    expect(error.command).toBe("ip");
  });

  test("never throws on malformed input", () => {
    const samples = [
      "",
      " ",
      "ip",
      "ip -x",
      "ip addr show dev",
      "ip addr add dev eth0",
      "ip link set",
      "ping",
      "ping -c",
      "ping -c 0 10.0.0.3",
      "ping -s 70000 10.0.0.3",
      "ping -t 256 10.0.0.3",
      "ping not-an-ip",
      "traceroute",
      "traceroute 10.0.0.3 extra",
      "arp -a extra",
      "ip route del default",
      "!!!",
    ];
    for (const sample of samples) {
      expect(() => parseCommandLine(sample)).not.toThrow();
      expect(parseCommandLine(sample).ok).toBe(false);
    }
  });

  test("errors carry the failing command word", () => {
    expect(rejected("ping -z 10.0.0.3").command).toBe("ping");
    expect(rejected("nope").command).toBe("nope");
    expect(rejected("ip wat").command).toBe("ip");
  });
});
