/**
 * Fase 4 / T5: the deliverable of the UDP, DNS and DHCP slice, end to end.
 *
 * A host boots with no address, runs `dhclient` against a DHCP server on its
 * own segment (this slice has no relay, so the pool lives with the client),
 * and then resolves a name with `dig` against the DNS service that exchange
 * points at (the gateway in the same-segment fixture, an explicit `@server`
 * across the router). Both commands ride the real Ethernet/IPv4/UDP stack:
 * the first fixture goes through a switch, the second one also across a
 * router.
 *
 * Deterministic by construction: fixed seed, explicit MACs and addresses, and
 * virtual time only — the shell advances `sim.now` through `runUntil`, while
 * `Simulation.random` is the single source of randomness. No wall clock, no
 * `Math.random`.
 *
 * `runScenario()` knows hosts, switches, routers and hubs, and a scenario
 * action is an `exec` string; it has no node type for a service. So the
 * fixtures wire the `DhcpServer`/`DnsServer` objects code-side (the same
 * shape `packages/shell/test/lab.ts` uses) and drive the hosts through
 * `Shell.exec()`, which is exactly the path an `exec` action takes. The last
 * test pins the schema: Fase 4 needs no new node type and no new action kind.
 */

import { describe, expect, test } from "bun:test";
import {
  connect,
  DhcpServer,
  DnsServer,
  Host,
  Link,
  Router,
  Simulation,
  Switch,
  TraceBus,
} from "@netlab/core";
import { DEFAULT_DIG_TIMEOUT_US, parseCommandLine, Shell } from "@netlab/shell";
import { parseScenarioJson } from "../src/scenario";

const SEED = 71;
const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";

const MAC_CLIENT = "02:00:00:00:00:0a";
const MAC_SERVICE = "02:00:00:00:00:0b";
const MAC_WEB = "02:00:00:00:00:0c";
const MAC_R1_A = "02:00:00:00:00:01";
const MAC_R1_B = "02:00:00:00:00:02";

/** DHCP + DNS server, and the web host it advertises, on subnet A. */
const SERVICE_IP = "10.0.0.3";
const WEB_IP = "10.0.0.4";
/** Router legs: subnet A is 10.0.0.0/24, subnet B is 10.0.1.0/24. */
const GATEWAY_A = "10.0.0.1";
const GATEWAY_B = "10.0.1.1";
/** The routed fixture keeps its DNS service on subnet B. */
const DNS_IP_B = "10.0.1.2";

const DHCP_POOL = ["10.0.0.100", "10.0.0.101"];
const ZONE_NAME = "web.lab";
const ZONE_TTL_SECONDS = 60;

type Lab = { sim: Simulation; bus: TraceBus; client: Host; close(): void };

function wire(id: string, sim: Simulation, bus: TraceBus): Link {
  return new Link(sim, id, { latencyUs: LATENCY_US }, bus);
}

/**
 * `client` -- sw1 -- `service` (DHCP + DNS), plus a static web host, all on
 * one segment. The client starts bare; `getIpConfig()` is undefined until the
 * DHCP Ack lands.
 */
function sameSegmentLab(seed = SEED): Lab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const swtch = new Switch(sim, "sw1", bus);
  const client = new Host(sim, "client", bus);
  const service = new Host(sim, "service", bus);
  const web = new Host(sim, "web", bus);

  connect(
    wire("l1", sim, bus),
    swtch.addPort("p1"),
    client.addInterface("eth0", { mac: MAC_CLIENT }),
  );
  connect(
    wire("l2", sim, bus),
    swtch.addPort("p2"),
    service.addInterface("eth0", {
      mac: MAC_SERVICE,
      ip: SERVICE_IP,
      mask: MASK_24,
    }),
  );
  connect(
    wire("l3", sim, bus),
    swtch.addPort("p3"),
    web.addInterface("eth0", { mac: MAC_WEB, ip: WEB_IP, mask: MASK_24 }),
  );

  const dhcp = new DhcpServer({
    host: service,
    pool: DHCP_POOL,
    gateway: SERVICE_IP,
    dnsServers: [SERVICE_IP],
  });
  const dns = new DnsServer({
    host: service,
    zone: { [ZONE_NAME]: WEB_IP },
    ttlSeconds: ZONE_TTL_SECONDS,
  });
  return {
    sim,
    bus,
    client,
    close: () => {
      dhcp.close();
      dns.close();
    },
  };
}

/**
 * `client` and `service` (DHCP only) on subnet A through sw1, then r1, then
 * `web` on subnet B running the DNS service of the zone.
 */
function routedLab(seed = SEED): Lab {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const swtch = new Switch(sim, "sw1", bus);
  const client = new Host(sim, "client", bus);
  const service = new Host(sim, "service", bus);
  const router = new Router(sim, "r1", bus);
  const web = new Host(sim, "web", bus);

  connect(
    wire("l1", sim, bus),
    swtch.addPort("p1"),
    client.addInterface("eth0", { mac: MAC_CLIENT }),
  );
  connect(
    wire("l2", sim, bus),
    swtch.addPort("p2"),
    service.addInterface("eth0", {
      mac: MAC_SERVICE,
      ip: SERVICE_IP,
      mask: MASK_24,
    }),
  );
  connect(
    wire("l3", sim, bus),
    swtch.addPort("p3"),
    router.addPort("p1", { mac: MAC_R1_A, ip: GATEWAY_A, prefixLength: 24 }),
  );
  connect(
    wire("l4", sim, bus),
    router.addPort("p2", { mac: MAC_R1_B, ip: GATEWAY_B, prefixLength: 24 }),
    web.addInterface("eth0", {
      mac: MAC_WEB,
      ip: DNS_IP_B,
      mask: MASK_24,
      gateway: GATEWAY_B,
    }),
  );

  const dhcp = new DhcpServer({
    host: service,
    pool: DHCP_POOL,
    gateway: GATEWAY_A,
    dnsServers: [DNS_IP_B],
  });
  const dns = new DnsServer({
    host: web,
    zone: { [ZONE_NAME]: DNS_IP_B },
    ttlSeconds: ZONE_TTL_SECONDS,
  });
  return {
    sim,
    bus,
    client,
    close: () => {
      dhcp.close();
      dns.close();
    },
  };
}

describe("Fase 4 deliverable: IP over DHCP, then a name over DNS", () => {
  test("dhclient configures a bare host from the pool", async () => {
    const lab = sameSegmentLab();
    const shell = new Shell({ host: lab.client, sim: lab.sim });
    expect(lab.client.getIpConfig("eth0")).toBeUndefined();

    const lines = await shell.exec("dhclient");
    expect(lines[0]).toBe("DHCPDISCOVER on eth0 to 255.255.255.255 port 67");
    expect(lines).toContain(
      `DHCPACK from ${SERVICE_IP}: bound to ${DHCP_POOL[0]} mask ${MASK_24}`,
    );
    expect(lines).toContain(`  gateway ${SERVICE_IP}`);
    expect(lines).toContain(`  nameserver ${SERVICE_IP}`);

    const config = lab.client.getIpConfig("eth0");
    expect(config?.ip.toString()).toBe(DHCP_POOL[0]);
    expect(config?.mask?.toString()).toBe(MASK_24);
    expect(config?.gateway?.toString()).toBe(SERVICE_IP);
    lab.close();
  });

  test("dig resolves the zone through the gateway DHCP handed out", async () => {
    const lab = sameSegmentLab();
    const shell = new Shell({ host: lab.client, sim: lab.sim });

    // Without an address there is no resolver at all: `dhclient` is what
    // turns the name lookup on.
    await expect(shell.exec(`dig ${ZONE_NAME}`)).rejects.toThrow(/DNS server/);

    const lease = await shell.exec("dhclient");
    expect(lease).toContain(
      `DHCPACK from ${SERVICE_IP}: bound to ${DHCP_POOL[0]} mask ${MASK_24}`,
    );
    expect(lab.client.getIpConfig("eth0")?.gateway?.toString()).toBe(
      SERVICE_IP,
    );
    const boundAt = lab.sim.now;

    // No `@SERVER`: the shell falls back to the gateway it just learned (the
    // DHCP nameserver option is reported, not adopted yet, so the gateway is
    // the one carrying it), and that gateway hosts the zone's authority.
    const lines = await shell.exec(`dig ${ZONE_NAME}`);
    expect(lines[0]).toBe(`; <<>> netlab dig <<>> ${ZONE_NAME}`);
    expect(lines).toContain(";; status: NOERROR");
    expect(lines).toContain(";; attempts: 1");
    expect(lines).toContain(`;; SERVER: ${SERVICE_IP}#53`);
    expect(lines).toContain(
      `${ZONE_NAME}.\t${ZONE_TTL_SECONDS}\tIN\tA\t${WEB_IP}`,
    );
    // One attempt window, measured on the virtual clock only.
    expect(lab.sim.now).toBe(boundAt + DEFAULT_DIG_TIMEOUT_US);
    lab.close();
  });

  test("dig crosses a router to the DNS server in the other subnet", async () => {
    const lab = routedLab();
    const shell = new Shell({ host: lab.client, sim: lab.sim });

    const lease = await shell.exec("dhclient");
    expect(lease).toContain(
      `DHCPACK from ${SERVICE_IP}: bound to ${DHCP_POOL[0]} mask ${MASK_24}`,
    );
    expect(lease).toContain(`  gateway ${GATEWAY_A}`);
    expect(lease).toContain(`  nameserver ${DNS_IP_B}`);
    expect(lab.client.getIpConfig("eth0")?.gateway?.toString()).toBe(GATEWAY_A);

    // The DHCP Ack names 10.0.1.2, but the gateway is r1 and the shell has no
    // resolver there, so the routed query names the server explicitly: the
    // query and the answer both leave the segment through r1, which means
    // `attempts: 1` can only be a real round trip.
    const lines = await shell.exec(`dig @${DNS_IP_B} ${ZONE_NAME}`);
    expect(lines).toContain(";; status: NOERROR");
    expect(lines).toContain(";; attempts: 1");
    expect(lines).toContain(`;; SERVER: ${DNS_IP_B}#53`);
    expect(lines).toContain(
      `${ZONE_NAME}.\t${ZONE_TTL_SECONDS}\tIN\tA\t${DNS_IP_B}`,
    );
    lab.close();
  });

  test("the same seed replays the same transcript", async () => {
    const transcript = async (seed: number): Promise<Array<string>> => {
      const lab = routedLab(seed);
      const shell = new Shell({ host: lab.client, sim: lab.sim });
      const lines = [
        ...(await shell.exec("dhclient")),
        ...(await shell.exec(`dig @${DNS_IP_B} ${ZONE_NAME}`)),
      ];
      const config = lab.client.getIpConfig("eth0");
      lab.close();
      return [...lines, `now: ${lab.sim.now}`, `ip: ${config?.ip.toString()}`];
    };
    expect(await transcript(SEED)).toEqual(await transcript(SEED));
    expect((await transcript(SEED)).join("\n")).toContain(
      `${ZONE_NAME}.\t${ZONE_TTL_SECONDS}\tIN\tA\t${DNS_IP_B}`,
    );
  });

  test("the scenario schema carries the deliverable as exec actions", () => {
    const scenario = parseScenarioJson({
      version: 1,
      seed: SEED,
      until: "3s",
      nodes: [
        {
          type: "host",
          id: "client",
          interfaces: [{ name: "eth0", mac: MAC_CLIENT }],
        },
        { type: "switch", id: "sw1", ports: [{ name: "p1" }, { name: "p2" }] },
        {
          type: "host",
          id: "service",
          interfaces: [
            { name: "eth0", mac: MAC_SERVICE, ip: SERVICE_IP, mask: MASK_24 },
          ],
        },
      ],
      links: [
        {
          id: "l1",
          a: { node: "client", iface: "eth0" },
          b: { node: "sw1", iface: "p1" },
          params: { latencyUs: LATENCY_US },
        },
        {
          id: "l2",
          a: { node: "service", iface: "eth0" },
          b: { node: "sw1", iface: "p2" },
          params: { latencyUs: LATENCY_US },
        },
      ],
      actions: [
        { at: 0, host: "client", exec: "dhclient" },
        { at: "1s", host: "client", exec: `dig @${SERVICE_IP} ${ZONE_NAME}` },
      ],
    });

    // No new node type and no new action kind: the fixture's commands are
    // plain `exec` strings, so `parseCommandLine` decides what they mean.
    expect(scenario.nodes.map((node) => node.type)).toEqual([
      "host",
      "switch",
      "host",
    ]);
    const commands = scenario.actions.flatMap((action) =>
      "exec" in action ? [action.exec] : [],
    );
    expect(commands).toEqual(["dhclient", `dig @${SERVICE_IP} ${ZONE_NAME}`]);
    for (const command of commands) {
      const parsed = parseCommandLine(command);
      expect(parsed.ok).toBe(true);
    }
    // Total over hostile input: the parser never throws.
    for (const line of ["", "dig", "dhclient -r", "dig @", "nc -u"]) {
      expect(typeof parseCommandLine(line).ok).toBe("boolean");
    }
  });
});
