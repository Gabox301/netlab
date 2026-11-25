/**
 * DHCP client and server (F-72/73): a client without an address runs DORA
 * over UDP and leaves with IP, mask, gateway and DNS; the server hands out
 * pool addresses, keeps leases and NAKs a Request for somebody else's lease.
 *
 * Everything rides a direct link or a hub, exactly like the UDP socket tests:
 * the client has no address yet, so its Discover leaves as a raw broadcast
 * frame and the server answers with a raw frame too. The codec is exercised
 * from the outside: frames are inspected by parsing them back.
 */

import { describe, expect, test } from "bun:test";
import { Ipv4Address, MacAddress } from "@netlab/bytes";
import {
  DHCP_CHADDR_LENGTH,
  DHCP_CLIENT_PORT,
  DHCP_FILE_LENGTH,
  DHCP_MESSAGE_ACK,
  DHCP_MESSAGE_DISCOVER,
  DHCP_MESSAGE_NAK,
  DHCP_MESSAGE_OFFER,
  DHCP_MESSAGE_REQUEST,
  DHCP_OP_REPLY,
  DHCP_OP_REQUEST,
  DHCP_SERVER_PORT,
  DHCP_SNAME_LENGTH,
  type DhcpMessage,
  dhcpMessageType,
  ETHERTYPE_IPV4,
  IPV4_PROTOCOL_UDP,
  parseDhcp,
  parseIpv4,
  parseUdp,
  serializeDhcp,
  serializeIpv4,
  serializeUdp,
} from "@netlab/protocols";
import { connect } from "../src/devices";
import { DhcpClient, DhcpServer } from "../src/dhcp";
import { Host } from "../src/host";
import { Link } from "../src/link";
import { Simulation } from "../src/sim";
import { Hub } from "../src/switch";
import { TraceBus } from "../src/trace";

const LATENCY_US = 10;
const MASK_24 = "255.255.255.0";
const SERVER_IP = "10.0.0.1";
const GATEWAY = "10.0.0.254";
const DNS_IP = "10.0.0.53";
const FIRST_IP = "10.0.0.100";
const SECOND_IP = "10.0.0.101";

const UNSPECIFIED = Ipv4Address.parse("0.0.0.0");
const LIMITED_BROADCAST = Ipv4Address.parse("255.255.255.255");

function macFor(suffix: number): string {
  return `02:00:00:00:00:${suffix.toString(16).padStart(2, "0")}`;
}

const CLIENT_A_MAC = macFor(0x0a);
const CLIENT_B_MAC = macFor(0x0b);

function chaddrOf(mac: string): Uint8Array {
  const padded = new Uint8Array(DHCP_CHADDR_LENGTH);
  padded.set(MacAddress.parse(mac).toBytes());
  return padded;
}

/** Minimal DHCP frame; overrides carry whatever the scenario needs. */
function dhcpMessage(overrides: Partial<DhcpMessage> = {}): DhcpMessage {
  return {
    op: DHCP_OP_REQUEST,
    htype: 1,
    hlen: 6,
    hops: 0,
    xid: 0x1234,
    secs: 0,
    flags: 0x8000,
    ciaddr: "0.0.0.0",
    yiaddr: "0.0.0.0",
    siaddr: "0.0.0.0",
    giaddr: "0.0.0.0",
    chaddr: chaddrOf(CLIENT_A_MAC),
    sname: new Uint8Array(DHCP_SNAME_LENGTH),
    file: new Uint8Array(DHCP_FILE_LENGTH),
    options: [{ kind: "message-type", type: DHCP_MESSAGE_DISCOVER }],
    ...overrides,
  };
}

function ipv4(
  src: Ipv4Address,
  dst: Ipv4Address,
  payload: Uint8Array,
): Uint8Array {
  return serializeIpv4(
    {
      version: 4,
      ihl: 5,
      dscp: 0,
      ecn: 0,
      totalLength: 0,
      identification: 1,
      flags: { reserved: false, dontFragment: false, moreFragments: false },
      fragmentOffset: 0,
      ttl: 64,
      protocol: IPV4_PROTOCOL_UDP,
      checksum: 0,
      src,
      dst,
      options: new Uint8Array(0),
    },
    payload,
  );
}

/** Send `message` as a broadcast DHCP frame, the way a booting client does. */
function sendBroadcast(from: Host, message: DhcpMessage): void {
  const segment = serializeUdp(
    {
      srcPort: DHCP_CLIENT_PORT,
      dstPort: DHCP_SERVER_PORT,
      payload: serializeDhcp(message),
    },
    UNSPECIFIED,
    LIMITED_BROADCAST,
  );
  from.sendRaw(
    "eth0",
    MacAddress.BROADCAST,
    ETHERTYPE_IPV4,
    ipv4(UNSPECIFIED, LIMITED_BROADCAST, segment),
  );
}

/** Answer `request` with `overrides`, unicast at L2 and broadcast at L3. */
function sendReply(
  from: Host,
  request: DhcpMessage,
  overrides: Partial<DhcpMessage>,
): void {
  const message = dhcpMessage({
    op: DHCP_OP_REPLY,
    xid: request.xid,
    chaddr: request.chaddr,
    ...overrides,
  });
  const segment = serializeUdp(
    {
      srcPort: DHCP_SERVER_PORT,
      dstPort: DHCP_CLIENT_PORT,
      payload: serializeDhcp(message),
    },
    Ipv4Address.parse(SERVER_IP),
    LIMITED_BROADCAST,
  );
  from.sendRaw(
    "eth0",
    MacAddress.fromBytes(request.chaddr.slice(0, request.hlen)),
    ETHERTYPE_IPV4,
    ipv4(Ipv4Address.parse(SERVER_IP), LIMITED_BROADCAST, segment),
  );
}

/** Decode the DHCP message carried by a frame destined to `port`. */
function dhcpFrom(payload: Uint8Array, port: number): DhcpMessage | undefined {
  const datagram = parseIpv4(payload);
  if (!datagram.ok) {
    return undefined;
  }
  const segment = parseUdp(datagram.value.payload);
  if (!segment.ok || segment.value.dstPort !== port) {
    return undefined;
  }
  const message = parseDhcp(segment.value.payload);
  return message.ok ? message.value : undefined;
}

interface Rig {
  sim: Simulation;
  bus: TraceBus;
  serverHost: Host;
  clientA: Host;
  clientB: Host;
}

function directLink(seed = 43): Rig {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const serverHost = new Host(sim, "server", bus);
  const clientA = new Host(sim, "a", bus);
  const clientB = new Host(sim, "b", bus);
  connect(
    new Link(sim, "l0", { latencyUs: LATENCY_US }, bus),
    serverHost.addInterface("eth0", {
      mac: macFor(1),
      ip: SERVER_IP,
      mask: MASK_24,
    }),
    clientA.addInterface("eth0", { mac: CLIENT_A_MAC }),
  );
  return { sim, bus, serverHost, clientA, clientB };
}

/** Server plus two address-less clients behind one hub. */
function hubLink(seed = 44): Rig {
  const sim = new Simulation(seed);
  const bus = new TraceBus();
  const hub = new Hub(sim, "hub0", bus);
  const serverHost = new Host(sim, "server", bus);
  const clientA = new Host(sim, "a", bus);
  const clientB = new Host(sim, "b", bus);
  connect(
    new Link(sim, "l1", { latencyUs: LATENCY_US }, bus),
    serverHost.addInterface("eth0", {
      mac: macFor(1),
      ip: SERVER_IP,
      mask: MASK_24,
    }),
    hub.addPort("h1"),
  );
  connect(
    new Link(sim, "l2", { latencyUs: LATENCY_US }, bus),
    clientA.addInterface("eth0", { mac: CLIENT_A_MAC }),
    hub.addPort("h2"),
  );
  connect(
    new Link(sim, "l3", { latencyUs: LATENCY_US }, bus),
    clientB.addInterface("eth0", { mac: CLIENT_B_MAC }),
    hub.addPort("h3"),
  );
  return { sim, bus, serverHost, clientA, clientB };
}

function buildServer(
  rig: Rig,
  pool: readonly string[] = [FIRST_IP],
): DhcpServer {
  return new DhcpServer({
    host: rig.serverHost,
    pool,
    gateway: GATEWAY,
    dnsServers: [DNS_IP],
  });
}

describe("dhcp client/server (F-72/73)", () => {
  test("a client without an address completes DORA and applies the lease", () => {
    const rig = directLink();
    const server = buildServer(rig, [FIRST_IP, SECOND_IP]);
    const client = new DhcpClient({ host: rig.clientA, sim: rig.sim });
    const states: string[] = [];
    client.onStateChange = (state) => states.push(state);

    expect(rig.clientA.getIpConfig("eth0")).toBeUndefined();
    client.start();
    rig.sim.runAll();

    expect(states).toEqual(["discover", "request", "bound"]);
    expect(client.state).toBe("bound");
    const config = rig.clientA.getIpConfig("eth0");
    expect(config?.ip.toString()).toBe(FIRST_IP);
    expect(config?.mask?.toString()).toBe(MASK_24);
    expect(config?.gateway?.toString()).toBe(GATEWAY);
    expect(client.dnsServers).toEqual([DNS_IP]);
    expect(client.lease?.ip).toBe(FIRST_IP);
    expect(client.lease?.serverId).toBe(SERVER_IP);
    expect(client.stats).toEqual({
      discovers: 1,
      offers: 1,
      requests: 1,
      acks: 1,
      naks: 0,
    });
    expect(server.stats).toEqual({
      discovers: 1,
      offers: 1,
      requests: 1,
      acks: 1,
      naks: 0,
      ignored: 0,
    });
    expect(server.getLeases()).toEqual([
      expect.objectContaining({
        mac: CLIENT_A_MAC,
        ip: FIRST_IP,
        state: "bound",
      }),
    ]);

    client.close();
    server.close();
  });

  test("a second client gets the next address in the pool", () => {
    const rig = hubLink();
    const server = buildServer(rig, [FIRST_IP, SECOND_IP]);
    const a = new DhcpClient({ host: rig.clientA, sim: rig.sim });
    const b = new DhcpClient({ host: rig.clientB, sim: rig.sim });

    a.start();
    b.start();
    rig.sim.runAll();

    expect(a.state).toBe("bound");
    expect(b.state).toBe("bound");
    const ipA = rig.clientA.getIpConfig("eth0")?.ip.toString();
    const ipB = rig.clientB.getIpConfig("eth0")?.ip.toString();
    expect([ipA, ipB].sort()).toEqual([FIRST_IP, SECOND_IP]);
    expect(server.getLeases()).toHaveLength(2);
    expect(a.dnsServers).toEqual([DNS_IP]);
    expect(b.dnsServers).toEqual([DNS_IP]);

    a.close();
    b.close();
    server.close();
  });

  test("an exhausted pool leaves the second client retrying until it fails", () => {
    const rig = hubLink();
    const server = buildServer(rig, [FIRST_IP]);
    const a = new DhcpClient({ host: rig.clientA, sim: rig.sim });
    const b = new DhcpClient({ host: rig.clientB, sim: rig.sim, retries: 1 });

    a.start();
    b.start();
    rig.sim.runAll();

    expect(a.state).toBe("bound");
    expect(b.state).toBe("failed");
    expect(rig.clientB.getIpConfig("eth0")).toBeUndefined();
    expect(b.stats.discovers).toBe(2);
    expect(server.stats.offers).toBe(1);
    expect(server.getLeases()).toHaveLength(1);

    a.close();
    b.close();
    server.close();
  });

  test("a Request for a leased address is answered with a NAK", () => {
    const rig = hubLink();
    const server = buildServer(rig, [FIRST_IP, SECOND_IP]);
    const a = new DhcpClient({ host: rig.clientA, sim: rig.sim });
    a.start();
    rig.sim.runAll();
    const leased = rig.clientA.getIpConfig("eth0")?.ip.toString();
    expect(leased).toBe(FIRST_IP);

    const replies: DhcpMessage[] = [];
    rig.clientB.onPayload = (_iface, _etherType, payload) => {
      const message = dhcpFrom(payload, DHCP_CLIENT_PORT);
      if (message !== undefined) {
        replies.push(message);
      }
    };
    sendBroadcast(
      rig.clientB,
      dhcpMessage({
        xid: 0xbad,
        chaddr: chaddrOf(CLIENT_B_MAC),
        options: [
          { kind: "message-type", type: DHCP_MESSAGE_REQUEST },
          { kind: "requested-ip", ip: leased as string },
        ],
      }),
    );
    rig.sim.runAll();

    expect(server.stats.naks).toBe(1);
    expect(server.stats.acks).toBe(1);
    expect(replies).toHaveLength(1);
    expect(dhcpMessageType(replies[0]?.options ?? [])).toBe(DHCP_MESSAGE_NAK);
    expect(replies[0]?.xid).toBe(0xbad);
    expect(replies[0]?.yiaddr).toBe("0.0.0.0");

    a.close();
    server.close();
  });

  test("answers a unicast Request over the UDP socket path", () => {
    const rig = hubLink();
    const server = buildServer(rig, [FIRST_IP, SECOND_IP]);
    const a = new DhcpClient({ host: rig.clientA, sim: rig.sim });
    a.start();
    rig.sim.runAll();
    expect(rig.clientA.getIpConfig("eth0")?.ip.toString()).toBe(FIRST_IP);

    // clientB has an address of its own and asks for the second pool entry
    // the way a renewal does: unicast to the server, ciaddr already set.
    rig.clientB.setIpConfig("eth0", { ip: SECOND_IP, mask: MASK_24 });
    const replies: DhcpMessage[] = [];
    rig.clientB.bindUdp(DHCP_CLIENT_PORT, (datagram) => {
      const parsed = parseDhcp(datagram.payload);
      if (parsed.ok) {
        replies.push(parsed.value);
      }
    });
    rig.clientB.sendUdp(
      SERVER_IP,
      DHCP_SERVER_PORT,
      serializeDhcp(
        dhcpMessage({
          xid: 0x51,
          ciaddr: SECOND_IP,
          chaddr: chaddrOf(CLIENT_B_MAC),
          options: [{ kind: "message-type", type: DHCP_MESSAGE_REQUEST }],
        }),
      ),
    );
    rig.sim.runAll();

    expect(server.stats.requests).toBe(2);
    expect(server.stats.acks).toBe(2);
    expect(replies).toHaveLength(1);
    expect(dhcpMessageType(replies[0]?.options ?? [])).toBe(DHCP_MESSAGE_ACK);
    expect(replies[0]?.yiaddr).toBe(SECOND_IP);
    expect(replies[0]?.xid).toBe(0x51);

    a.close();
    server.close();
  });

  test("a NAK sends the client back to discovery until it binds", () => {
    const rig = directLink();
    let offers = 0;
    rig.serverHost.onPayload = (_iface, _etherType, payload) => {
      const request = dhcpFrom(payload, DHCP_SERVER_PORT);
      if (request === undefined) {
        return;
      }
      const type = dhcpMessageType(request.options);
      if (type === DHCP_MESSAGE_DISCOVER) {
        const ip = offers++ === 0 ? FIRST_IP : SECOND_IP;
        sendReply(rig.serverHost, request, {
          yiaddr: ip,
          options: [
            { kind: "message-type", type: DHCP_MESSAGE_OFFER },
            { kind: "server-id", id: SERVER_IP },
          ],
        });
        return;
      }
      if (type !== DHCP_MESSAGE_REQUEST) {
        return;
      }
      if (offers === 1) {
        sendReply(rig.serverHost, request, {
          options: [
            { kind: "message-type", type: DHCP_MESSAGE_NAK },
            { kind: "server-id", id: SERVER_IP },
          ],
        });
        return;
      }
      sendReply(rig.serverHost, request, {
        yiaddr: SECOND_IP,
        options: [
          { kind: "message-type", type: DHCP_MESSAGE_ACK },
          { kind: "server-id", id: SERVER_IP },
          { kind: "subnet-mask", mask: MASK_24 },
          { kind: "router", routers: [GATEWAY] },
          { kind: "dns", servers: [DNS_IP] },
          { kind: "lease-time", seconds: 600 },
        ],
      });
    };

    const client = new DhcpClient({ host: rig.clientA, sim: rig.sim });
    client.start();
    rig.sim.runAll();

    expect(client.state).toBe("bound");
    expect(client.stats).toEqual({
      discovers: 2,
      offers: 2,
      requests: 2,
      acks: 1,
      naks: 1,
    });
    const config = rig.clientA.getIpConfig("eth0");
    expect(config?.ip.toString()).toBe(SECOND_IP);
    expect(config?.gateway?.toString()).toBe(GATEWAY);
    expect(client.dnsServers).toEqual([DNS_IP]);
    expect(client.lease?.leaseTimeSeconds).toBe(600);
    expect(client.lease?.serverId).toBe(SERVER_IP);

    client.close();
  });

  test("retries the Discover on timers and gives up after `retries`", () => {
    const rig = directLink();
    const client = new DhcpClient({
      host: rig.clientA,
      sim: rig.sim,
      retries: 2,
      timeoutUs: 1_000_000,
    });
    client.start();
    rig.sim.runAll();

    expect(client.state).toBe("failed");
    expect(client.stats.discovers).toBe(3);
    expect(client.stats.acks).toBe(0);
    expect(rig.sim.now).toBe(3_000_000);
    expect(rig.clientA.getIpConfig("eth0")).toBeUndefined();

    client.close();
  });

  test("draws the transaction id from sim.random, never Math.random", () => {
    const xids: number[] = [];
    for (const seed of [7, 7]) {
      const rig = directLink(seed);
      rig.serverHost.onPayload = (_iface, _etherType, payload) => {
        const message = dhcpFrom(payload, DHCP_SERVER_PORT);
        if (message !== undefined) {
          xids.push(message.xid);
        }
      };
      const client = new DhcpClient({
        host: rig.clientA,
        sim: rig.sim,
        retries: 0,
      });
      client.start();
      rig.sim.runAll();
      client.close();
    }
    expect(xids).toHaveLength(2);
    expect(xids[0]).toBe(xids[1] as number);
    expect(xids[0]).not.toBe(0);
  });

  test("chains the host onPayload hook and restores it on close()", () => {
    const rig = directLink();
    const seen: number[] = [];
    const previous = (): void => {
      seen.push(1);
    };
    rig.clientA.onPayload = previous;
    const server = buildServer(rig, [FIRST_IP]);
    const client = new DhcpClient({ host: rig.clientA, sim: rig.sim });

    client.start();
    rig.sim.runAll();

    expect(client.state).toBe("bound");
    expect(seen.length).toBeGreaterThan(0);

    client.close();
    server.close();
    expect(rig.clientA.onPayload).toBe(previous);
    expect(rig.serverHost.onPayload).toBeUndefined();
  });

  test("ignores malformed and unrelated datagrams on port 67", () => {
    const rig = directLink();
    const server = buildServer(rig, [FIRST_IP]);

    // Wrong cookie, then a well-formed non-DHCP UDP datagram on port 67.
    const broken = dhcpMessage();
    const bytes = serializeDhcp(broken);
    bytes[236] = 0x00;
    rig.clientA.sendRaw(
      "eth0",
      MacAddress.BROADCAST,
      ETHERTYPE_IPV4,
      ipv4(
        UNSPECIFIED,
        LIMITED_BROADCAST,
        serializeUdp(
          {
            srcPort: DHCP_CLIENT_PORT,
            dstPort: DHCP_SERVER_PORT,
            payload: bytes,
          },
          UNSPECIFIED,
          LIMITED_BROADCAST,
        ),
      ),
    );
    rig.clientA.sendRaw(
      "eth0",
      MacAddress.BROADCAST,
      ETHERTYPE_IPV4,
      ipv4(
        UNSPECIFIED,
        LIMITED_BROADCAST,
        serializeUdp(
          {
            srcPort: 4000,
            dstPort: DHCP_SERVER_PORT,
            payload: new Uint8Array([1, 2, 3]),
          },
          UNSPECIFIED,
          LIMITED_BROADCAST,
        ),
      ),
    );
    rig.sim.runAll();

    expect(server.stats.offers).toBe(0);
    expect(server.stats.acks).toBe(0);
    expect(server.getLeases()).toHaveLength(0);

    server.close();
  });
});
