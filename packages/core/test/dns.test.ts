/**
 * DNS integration (F-70/71): an authoritative server and a caching resolver
 * over the UDP sockets from T1, on two hosts joined by a direct link.
 */

import { describe, expect, test } from "bun:test";
import { DNS_RCODE_NXDOMAIN } from "@netlab/protocols";
import { connect } from "../src/devices";
import { DnsResolver, DnsServer } from "../src/dns";
import { Host } from "../src/host";
import { Link } from "../src/link";
import { Simulation } from "../src/sim";
import { TraceBus } from "../src/trace";

const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";
const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";
const IP_A = "10.0.0.2";
const IP_B = "10.0.0.3";

function directLink(): {
  sim: Simulation;
  a: Host;
  b: Host;
} {
  const sim = new Simulation(41);
  const bus = new TraceBus();
  const a = new Host(sim, "a", bus);
  const b = new Host(sim, "b", bus);
  connect(
    new Link(sim, "l0", { latencyUs: LATENCY_US }, bus),
    a.addInterface("eth0", { mac: MAC_A, ip: IP_A, mask: MASK_24 }),
    b.addInterface("eth0", { mac: MAC_B, ip: IP_B, mask: MASK_24 }),
  );
  return { sim, a, b };
}

describe("DNS resolver and authoritative server", () => {
  test("resolves a name and answers a second query from cache", () => {
    const { sim, a, b } = directLink();
    const server = new DnsServer({
      host: b,
      zone: { "web.lab": "10.0.0.3" },
      ttlSeconds: 60,
    });
    const resolver = new DnsResolver({
      host: a,
      sim,
      serverIp: IP_B,
      timeoutUs: 1_000_000,
      retries: 1,
    });

    const first = resolver.resolve("web.lab");
    expect(first.status).toBe("ok");
    expect(first.address).toBe("10.0.0.3");
    expect(first.fromCache).toBe(false);
    expect(first.attempts).toBe(1);

    // With the server gone, only a cache hit can succeed.
    server.close();
    const second = resolver.resolve("web.lab");
    expect(second.status).toBe("ok");
    expect(second.address).toBe("10.0.0.3");
    expect(second.fromCache).toBe(true);
    expect(second.attempts).toBe(0);

    resolver.close();
    expect(sim.now).toBeGreaterThan(0);
  });

  test("reports NXDOMAIN for an unknown name", () => {
    const { sim, a, b } = directLink();
    const server = new DnsServer({
      host: b,
      zone: { "web.lab": "10.0.0.3" },
      ttlSeconds: 60,
    });
    const resolver = new DnsResolver({
      host: a,
      sim,
      serverIp: IP_B,
      retries: 0,
    });

    const result = resolver.resolve("missing.lab");
    expect(result.status).toBe("nxdomain");
    expect(result.rcode).toBe(DNS_RCODE_NXDOMAIN);
    expect(result.address).toBeUndefined();
    expect(result.fromCache).toBe(false);

    resolver.close();
    server.close();
  });

  test("expires cached answers according to sim.now and the RR TTL", () => {
    const { sim, a, b } = directLink();
    const server = new DnsServer({
      host: b,
      zone: { "web.lab": "10.0.0.3" },
      ttlSeconds: 1,
    });
    const resolver = new DnsResolver({
      host: a,
      sim,
      serverIp: IP_B,
      retries: 0,
    });

    const first = resolver.resolve("web.lab");
    expect(first.status).toBe("ok");
    expect(first.fromCache).toBe(false);

    sim.runUntil(sim.now + 1_000_000 + 1);
    const second = resolver.resolve("web.lab");
    expect(second.status).toBe("ok");
    expect(second.fromCache).toBe(false);
    expect(second.attempts).toBe(1);

    resolver.close();
    server.close();
  });
});
