/**
 * `dig`, `dhclient` and `nc -u` (Fase 4 / T4): the shell surface of the DNS
 * resolver, the DHCP client and the raw UDP sockets.
 *
 * Every fixture reuses the shared lab constants (`mac`, `ip`, latency), so
 * the new commands ride the same deterministic topologies as the rest of the
 * shell suite. Nothing here touches wall-clock time: the clock is `sim.now`.
 */

import { describe, expect, test } from "bun:test";
import {
  connect,
  DhcpServer,
  DnsServer,
  Host,
  Link,
  Simulation,
  TraceBus,
} from "@netlab/core";
import {
  DEFAULT_DIG_TIMEOUT_US,
  parseCommandLine,
  Shell,
  type ShellCommand,
  type ShellError,
  type ShellErrorCode,
} from "../src/index";
import {
  IP_A,
  IP_B_SAME_SUBNET,
  IP_MISSING,
  IP_R1_A,
  LATENCY_US,
  MAC_A,
  MAC_B,
  MASK_24,
  sameSubnetLab,
  twoSubnetLab,
} from "./lab";

const ZONE_NAME = "web.lab";
const ECHO_PORT = 9099;
const DARK_PORT = 9098;
const HEX_HELLO = "68656c6c6f";
const DHCP_POOL_IP = "10.0.0.100";

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

function errorCode(error: unknown): ShellErrorCode | "not-a-shell-error" {
  if (error instanceof Error && "code" in error) {
    return (error as { code: ShellErrorCode }).code;
  }
  return "not-a-shell-error";
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return errorCode(error);
  }
  return "resolved";
}

interface DhcpLab {
  sim: Simulation;
  bus: TraceBus;
  server: Host;
  client: Host;
}

/** One link, an addressed DHCP server and a client that starts bare. */
function dhcpLab(seed = 61): DhcpLab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const server = new Host(sim, "server", bus);
  const client = new Host(sim, "client", bus);
  connect(
    new Link(sim, "l0", { latencyUs: LATENCY_US }, bus),
    server.addInterface("eth0", {
      mac: MAC_B,
      ip: IP_B_SAME_SUBNET,
      mask: MASK_24,
    }),
    client.addInterface("eth0", { mac: MAC_A }),
  );
  return { sim, bus, server, client };
}

function dhcpServer(lab: DhcpLab): DhcpServer {
  return new DhcpServer({
    host: lab.server,
    pool: [DHCP_POOL_IP],
    gateway: IP_B_SAME_SUBNET,
    dnsServers: [IP_B_SAME_SUBNET],
  });
}

describe("parse: dig grammar (T4)", () => {
  test("accepts the optional @server and the optional record type", () => {
    expect(accepted(`dig ${ZONE_NAME}`)).toEqual({
      kind: "dig",
      name: ZONE_NAME,
    });
    expect(accepted(`dig @${IP_B_SAME_SUBNET} ${ZONE_NAME}`)).toEqual({
      kind: "dig",
      name: ZONE_NAME,
      server: IP_B_SAME_SUBNET,
    });
    expect(accepted(`dig @${IP_B_SAME_SUBNET} ${ZONE_NAME} A`)).toEqual({
      kind: "dig",
      name: ZONE_NAME,
      server: IP_B_SAME_SUBNET,
    });
    expect(accepted(`dig @${IP_B_SAME_SUBNET} ${ZONE_NAME} a`)).toEqual({
      kind: "dig",
      name: ZONE_NAME,
      server: IP_B_SAME_SUBNET,
    });
  });

  test("rejects malformed names, servers and unsupported types", () => {
    expect(rejected("dig").code).toBe("missing_argument");
    expect(rejected("dig @").code).toBe("missing_argument");
    expect(rejected(`dig @${IP_B_SAME_SUBNET}`).code).toBe("missing_argument");
    expect(rejected(`dig @10.0.0.300 ${ZONE_NAME}`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`dig -x ${ZONE_NAME}`).code).toBe("unknown_flag");
    expect(rejected("dig .").code).toBe("invalid_argument");
    expect(rejected(`dig ${ZONE_NAME} MX`).code).toBe("unsupported");
    expect(rejected(`dig @${IP_B_SAME_SUBNET} ${ZONE_NAME} A extra`).code).toBe(
      "unexpected_argument",
    );
  });
});

describe("parse: dhclient grammar (T4)", () => {
  test("accepts an optional interface", () => {
    expect(accepted("dhclient")).toEqual({ kind: "dhclient" });
    expect(accepted("dhclient eth0")).toEqual({
      kind: "dhclient",
      iface: "eth0",
    });
  });

  test("rejects flags and extra arguments", () => {
    expect(rejected("dhclient -r").code).toBe("unknown_flag");
    expect(rejected("dhclient eth0 eth1").code).toBe("unexpected_argument");
  });
});

describe("parse: nc -u grammar (T4)", () => {
  test("accepts host, port and an optional hex payload", () => {
    expect(accepted(`nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT}`)).toEqual({
      kind: "nc.udp",
      host: IP_B_SAME_SUBNET,
      port: ECHO_PORT,
      payload: "",
    });
    expect(
      accepted(`nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT} ${HEX_HELLO}`),
    ).toEqual({
      kind: "nc.udp",
      host: IP_B_SAME_SUBNET,
      port: ECHO_PORT,
      payload: HEX_HELLO,
    });
    // Uppercase hex is normalized so the echoed output is stable.
    expect(accepted(`nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT} 4A4B`)).toEqual({
      kind: "nc.udp",
      host: IP_B_SAME_SUBNET,
      port: ECHO_PORT,
      payload: "4a4b",
    });
  });

  test("rejects bad flags, ports, hosts and hex", () => {
    // Bare `nc HOST PORT` is TCP now (T6); the pin was a T4 placeholder.
    expect(accepted(`nc ${IP_B_SAME_SUBNET} ${ECHO_PORT}`)).toEqual({
      kind: "nc.tcp",
      host: IP_B_SAME_SUBNET,
      port: ECHO_PORT,
      payload: "",
    });
    expect(rejected(`nc -l ${ECHO_PORT}`).code).toBe("unknown_flag");
    expect(rejected(`nc -u ${IP_B_SAME_SUBNET}`).code).toBe("missing_argument");
    expect(rejected(`nc -u ${IP_B_SAME_SUBNET} 0`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`nc -u ${IP_B_SAME_SUBNET} 65536`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT} abc`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT} zz`).code).toBe(
      "invalid_argument",
    );
    expect(rejected(`nc -u localhost ${ECHO_PORT}`).code).toBe(
      "invalid_argument",
    );
    expect(
      rejected(`nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT} ${HEX_HELLO} x`).code,
    ).toBe("unexpected_argument");
  });
});

describe("parse: total over hostile input (T4)", () => {
  test("never throws, always returns a typed result", () => {
    const lines = [
      "",
      "   ",
      "\t",
      "dig",
      "dig @",
      "dig @ @",
      "dig @1.2.3.4",
      "dig web.lab A A",
      "dig web.lab 99999999999999999999",
      "dhclient",
      "dhclient -x eth0",
      "nc",
      "nc -u",
      "nc -u ::1 53",
      "nc -u 1.2.3.4 -1",
      "nc -u 1.2.3.4 53 0x41",
      "\u0000",
      "dig \u00ff.lab",
    ];
    for (const line of lines) {
      const result = parseCommandLine(line);
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) {
        expect(result.error.kind).toBe("shell_error");
        expect(typeof result.error.message).toBe("string");
      }
    }
  });
});

describe("dig over the lab (T4)", () => {
  test("resolves an A record against an explicit @server", async () => {
    const lab = sameSubnetLab(141);
    const server = new DnsServer({
      host: lab.b,
      zone: { [ZONE_NAME]: IP_B_SAME_SUBNET },
      ttlSeconds: 60,
    });
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const startedAt = lab.sim.now;
    const lines = await shell.exec(`dig @${IP_B_SAME_SUBNET} ${ZONE_NAME}`);
    expect(lines[0]).toBe(`; <<>> netlab dig <<>> ${ZONE_NAME}`);
    expect(lines).toContain(";; status: NOERROR");
    expect(lines).toContain(";; attempts: 1");
    expect(lines).toContain(";; ANSWER SECTION:");
    expect(lines).toContain(`${ZONE_NAME}.\t60\tIN\tA\t${IP_B_SAME_SUBNET}`);
    expect(lines).toContain(`;; SERVER: ${IP_B_SAME_SUBNET}#53`);
    expect(lines).toContain(
      `;; timeout: ${DEFAULT_DIG_TIMEOUT_US} us (retries: 2)`,
    );
    expect(lines).not.toContain(";; cache: hit");

    // One attempt window: the resolver pins the clock to its deadline, the
    // same contract `ping`/`traceroute` follow via `runUntil`.
    expect(lab.sim.now).toBe(startedAt + DEFAULT_DIG_TIMEOUT_US);
    server.close();
  });

  test("uses the configured resolver and answers the second query from cache", async () => {
    const lab = sameSubnetLab(143);
    const server = new DnsServer({
      host: lab.b,
      zone: { [ZONE_NAME]: IP_B_SAME_SUBNET },
      ttlSeconds: 60,
    });
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      dnsServer: IP_B_SAME_SUBNET,
    });

    const first = await shell.exec(`dig ${ZONE_NAME} A`);
    expect(first).toContain(";; status: NOERROR");
    expect(first).toContain(";; attempts: 1");
    expect(first).not.toContain(";; cache: hit");

    // The stub resolver keeps only one server: the second query is a hit.
    const second = await shell.exec(`dig ${ZONE_NAME}`);
    expect(second).toContain(";; status: NOERROR");
    expect(second).toContain(";; attempts: 0");
    expect(second).toContain(";; cache: hit");
    expect(second).toContain(`${ZONE_NAME}.\t60\tIN\tA\t${IP_B_SAME_SUBNET}`);
    server.close();
  });

  test("reports NXDOMAIN for an unknown name", async () => {
    const lab = sameSubnetLab(145);
    const server = new DnsServer({
      host: lab.b,
      zone: { [ZONE_NAME]: IP_B_SAME_SUBNET },
      ttlSeconds: 60,
    });
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec(`dig @${IP_B_SAME_SUBNET} missing.lab`);
    expect(lines).toContain(";; status: NXDOMAIN");
    expect(lines).toContain(";; attempts: 1");
    expect(lines).not.toContain(";; ANSWER SECTION:");
    expect(lines).toContain(`;; SERVER: ${IP_B_SAME_SUBNET}#53`);
    server.close();
  });

  test("reports a timeout after the retries are exhausted", async () => {
    const lab = sameSubnetLab(147);
    const server = new DnsServer({
      host: lab.b,
      zone: { [ZONE_NAME]: IP_B_SAME_SUBNET },
      ttlSeconds: 60,
    });
    server.close();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      dnsServer: IP_B_SAME_SUBNET,
      digTimeoutUs: 500,
      digRetries: 1,
    });

    const lines = await shell.exec(`dig ${ZONE_NAME}`);
    expect(lines).toContain(";; status: TIMEOUT");
    expect(lines).toContain(";; attempts: 2");
    expect(lines).toContain(";; timeout: 500 us (retries: 1)");
    // Two attempts of 500 us each, driven by the virtual clock only.
    expect(lab.sim.now).toBe(1_000);
  });

  test("falls back to the gateway DNS when no resolver is configured", async () => {
    const lab = twoSubnetLab(149);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      digTimeoutUs: 500,
      digRetries: 0,
    });

    const lines = await shell.exec(`dig ${ZONE_NAME}`);
    expect(lines).toContain(`;; SERVER: ${IP_R1_A}#53`);
    expect(lines).toContain(";; status: TIMEOUT");
    expect(lines).toContain(";; attempts: 1");
  });

  test("fails with a typed error when there is no server at all", async () => {
    const lab = sameSubnetLab(151);
    const shell = new Shell({ host: lab.a, sim: lab.sim });
    expect(await rejection(shell.exec(`dig ${ZONE_NAME}`))).toBe(
      "invalid_argument",
    );
    expect(lab.sim.now).toBe(0);
  });
});

describe("dhclient over the lab (T4)", () => {
  test("obtains an address, gateway and DNS server over DHCP", async () => {
    const lab = dhcpLab(153);
    const server = dhcpServer(lab);
    const shell = new Shell({ host: lab.client, sim: lab.sim });

    expect(lab.client.getIpConfig("eth0")).toBeUndefined();
    const lines = await shell.exec("dhclient");
    expect(lines[0]).toBe("DHCPDISCOVER on eth0 to 255.255.255.255 port 67");
    expect(lines).toContain(
      `DHCPACK from ${IP_B_SAME_SUBNET}: bound to ${DHCP_POOL_IP} ` +
        `mask ${MASK_24}`,
    );
    expect(lines).toContain(`  gateway ${IP_B_SAME_SUBNET}`);
    expect(lines).toContain(`  nameserver ${IP_B_SAME_SUBNET}`);
    expect(lines[lines.length - 1]).toMatch(
      /^lease acquired at [1-9]\d* us, lease time 3600 s$/,
    );

    const config = lab.client.getIpConfig("eth0");
    expect(config?.ip.toString()).toBe(DHCP_POOL_IP);
    expect(config?.mask?.toString()).toBe(MASK_24);
    expect(config?.gateway?.toString()).toBe(IP_B_SAME_SUBNET);
    expect(server.getLeases()).toHaveLength(1);
    expect(lab.sim.now).toBeGreaterThan(0);
    server.close();
  });

  test("accepts an explicit interface", async () => {
    const lab = dhcpLab(155);
    const server = dhcpServer(lab);
    const shell = new Shell({ host: lab.client, sim: lab.sim });

    const lines = await shell.exec("dhclient eth0");
    expect(lines[0]).toBe("DHCPDISCOVER on eth0 to 255.255.255.255 port 67");
    expect(lab.client.getIpConfig("eth0")?.ip.toString()).toBe(DHCP_POOL_IP);
    server.close();
  });

  test("reports a failed exchange when no server answers", async () => {
    const lab = dhcpLab(157);
    const shell = new Shell({
      host: lab.client,
      sim: lab.sim,
      dhcpTimeoutUs: 500,
      dhcpRetries: 0,
    });

    const lines = await shell.exec("dhclient");
    expect(lines).toEqual([
      "DHCPDISCOVER on eth0 to 255.255.255.255 port 67",
      "dhclient: no DHCPACK on eth0 after 1 attempts",
    ]);
    expect(lab.client.getIpConfig("eth0")).toBeUndefined();
    expect(lab.sim.now).toBe(500);
  });

  test("rejects an unknown interface with a typed error", async () => {
    const lab = dhcpLab(159);
    const shell = new Shell({ host: lab.client, sim: lab.sim });
    expect(await rejection(shell.exec("dhclient eth9"))).toBe(
      "invalid_argument",
    );
  });
});

describe("nc -u over the lab (T4)", () => {
  test("sends a datagram and prints the echoed reply", async () => {
    const lab = sameSubnetLab(161);
    lab.b.bindUdp(ECHO_PORT, (datagram) => {
      lab.b.sendUdp(datagram.srcIp, datagram.srcPort, datagram.payload, {
        iface: datagram.iface,
        srcPort: ECHO_PORT,
      });
    });
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: 500,
    });

    const lines = await shell.exec(
      `nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT} ${HEX_HELLO}`,
    );
    expect(lines).toEqual([
      `UDP ${IP_B_SAME_SUBNET}:${ECHO_PORT}`,
      `sent 5 bytes: ${HEX_HELLO}`,
      `received 5 bytes from ${IP_B_SAME_SUBNET}:${ECHO_PORT}: ${HEX_HELLO}`,
      `--- ${IP_B_SAME_SUBNET}:${ECHO_PORT} udp ---`,
      "1 sent, 1 received",
    ]);
    // `nc` listens for the whole window before it reports.
    expect(lab.sim.now).toBe(500);
  });

  test("sends an empty datagram when no payload is given", async () => {
    const lab = sameSubnetLab(163);
    lab.b.bindUdp(ECHO_PORT, (datagram) => {
      lab.b.sendUdp(datagram.srcIp, datagram.srcPort, datagram.payload, {
        iface: datagram.iface,
        srcPort: ECHO_PORT,
      });
    });
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const lines = await shell.exec(`nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT}`);
    expect(lines).toEqual([
      `UDP ${IP_B_SAME_SUBNET}:${ECHO_PORT}`,
      "sent 0 bytes",
      `received 0 bytes from ${IP_B_SAME_SUBNET}:${ECHO_PORT}`,
      `--- ${IP_B_SAME_SUBNET}:${ECHO_PORT} udp ---`,
      "1 sent, 1 received",
    ]);
  });

  test("waits for the timeout when nothing answers", async () => {
    const lab = sameSubnetLab(165);
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      ncTimeoutUs: 2_000,
    });

    const lines = await shell.exec(
      `nc -u ${IP_B_SAME_SUBNET} ${DARK_PORT} ${HEX_HELLO}`,
    );
    expect(lines).toEqual([
      `UDP ${IP_B_SAME_SUBNET}:${DARK_PORT}`,
      `sent 5 bytes: ${HEX_HELLO}`,
      `--- ${IP_B_SAME_SUBNET}:${DARK_PORT} udp ---`,
      "1 sent, 0 received",
    ]);
    expect(lab.sim.now).toBe(2_000);
  });

  test("turns a routing failure into a typed execution error", async () => {
    const sim = new Simulation(167);
    const bus = new TraceBus();
    const bare = new Host(sim, "bare", bus);
    bare.addInterface("eth0", { mac: MAC_A });
    const shell = new Shell({ host: bare, sim });

    expect(await rejection(shell.exec(`nc -u ${IP_A} ${ECHO_PORT}`))).toBe(
      "execution_failed",
    );
    expect(sim.now).toBe(0);
  });
});

describe("fase 4 shell determinism (T4)", () => {
  test("identical labs and seeds produce identical output", async () => {
    async function run(): Promise<Array<string>> {
      const lab = sameSubnetLab(171);
      const dns = new DnsServer({
        host: lab.b,
        zone: { [ZONE_NAME]: IP_B_SAME_SUBNET },
        ttlSeconds: 60,
      });
      lab.b.bindUdp(ECHO_PORT, (datagram) => {
        lab.b.sendUdp(datagram.srcIp, datagram.srcPort, datagram.payload, {
          iface: datagram.iface,
          srcPort: ECHO_PORT,
        });
      });
      const shell = new Shell({
        host: lab.a,
        sim: lab.sim,
        dnsServer: IP_B_SAME_SUBNET,
      });
      const first = await shell.exec(`dig ${ZONE_NAME}`);
      const second = await shell.exec(`dig ${ZONE_NAME}`);
      const echoed = await shell.exec(
        `nc -u ${IP_B_SAME_SUBNET} ${ECHO_PORT} ${HEX_HELLO}`,
      );
      const dark = await shell.exec(
        `nc -u ${IP_B_SAME_SUBNET} ${DARK_PORT} ${HEX_HELLO}`,
      );
      dns.close();
      return [...first, ...second, ...echoed, ...dark];
    }

    const left = await run();
    const right = await run();
    expect(left).toEqual(right);
    expect(left.length).toBeGreaterThan(10);
    // No wall-clock timestamp ever leaks into the output.
    expect(left.join("\n")).not.toMatch(/\b(19|20)\d\d-\d\d-\d\d\b/);
  });
});

// `IP_MISSING` documents that an unreachable-but-shaped address is still a
// legal argument for the new parsers (the lab itself has no such host).
describe("fase 4 parse constants (T4)", () => {
  test("unroutable lab addresses still parse", () => {
    expect(accepted(`dig @${IP_MISSING} ${ZONE_NAME}`)).toEqual({
      kind: "dig",
      name: ZONE_NAME,
      server: IP_MISSING,
    });
  });
});
