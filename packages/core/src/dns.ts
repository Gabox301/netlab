/**
 * DNS application layer (F-70/71): an authoritative in-memory server and a
 * caching stub resolver, both riding the UDP sockets implemented in T1.
 *
 * The server binds port 53 (by default) and answers A queries from a static
 * `name -> address` zone with `AA=1`; unknown names produce NXDOMAIN. The
 * resolver sends one query per attempt, matches responses by DNS ID and uses
 * `Simulation.runUntil()` as its timeout, mirroring the shell probe pattern.
 * Positive answers are cached until `sim.now` reaches `receivedAt + TTL`.
 */

import { Ipv4Address } from "@netlab/bytes";
import {
  DNS_CLASS_IN,
  DNS_RCODE_NOERROR,
  DNS_RCODE_NXDOMAIN,
  DNS_TYPE_A,
  type DnsFlags,
  type DnsMessage,
  type DnsRecord,
  dnsNameKey,
  parseDns,
  serializeDns,
  serializeDnsResponse,
} from "@netlab/protocols";
import type { Host, HostUdpDatagram, HostUdpSocket } from "./host";
import type { Simulation } from "./sim";

/** Standard DNS server port. */
export const DEFAULT_DNS_PORT = 53;

/** Virtual wait per query attempt. */
export const DEFAULT_DNS_TIMEOUT_US = 1_000_000;

/** Retransmissions after the first query (total attempts = retries + 1). */
export const DEFAULT_DNS_RETRIES = 2;

/** Default A-record TTL in seconds. */
export const DEFAULT_DNS_TTL_SECONDS = 300;

const MICROS_PER_SECOND = 1_000_000;
const DNS_EPHEMERAL_MIN = 49152;
const DNS_EPHEMERAL_MAX = 65535;
const DNS_EPHEMERAL_PORTS = DNS_EPHEMERAL_MAX - DNS_EPHEMERAL_MIN + 1;

const QUERY_FLAGS: DnsFlags = {
  qr: false,
  opcode: 0,
  aa: false,
  tc: false,
  rd: true,
  ra: false,
  rcode: DNS_RCODE_NOERROR,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkPort(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be 0..65535: ${value}`);
  }
  return value;
}

function checkDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite value >= 0: ${value}`);
  }
  return value;
}

function checkRetries(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`retries must be a non-negative integer: ${value}`);
  }
  return value;
}

function checkTtlSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`ttlSeconds must be 0..4294967295: ${value}`);
  }
  return value;
}

function parseAddress(name: string, text: string): string {
  try {
    return Ipv4Address.parse(text).toString();
  } catch (err) {
    throw new RangeError(
      `${name} has an invalid IPv4 address: ${errorMessage(err)}`,
    );
  }
}

/** Static zone accepted by {@link DnsServer}: name -> dotted-decimal IPv4. */
export type DnsZone = Record<string, string> | ReadonlyMap<string, string>;

/** Options for {@link DnsServer}. */
export interface DnsServerOptions {
  host: Host;
  /** Authoritative records, keyed by presentation-form name. */
  zone: DnsZone;
  /** Listening port; default {@link DEFAULT_DNS_PORT}. */
  port?: number;
  /** TTL given to every A record; default {@link DEFAULT_DNS_TTL_SECONDS}. */
  ttlSeconds?: number;
}

/** Options for {@link DnsResolver}. */
export interface DnsResolverOptions {
  host: Host;
  /** Simulation whose clock and timers drive retries and cache expiry. */
  sim: Simulation;
  /** Authoritative server address. */
  serverIp: string;
  /** Server port; default {@link DEFAULT_DNS_PORT}. */
  port?: number;
  /** Wait per attempt; default {@link DEFAULT_DNS_TIMEOUT_US}. */
  timeoutUs?: number;
  /** Retransmissions; default {@link DEFAULT_DNS_RETRIES}. */
  retries?: number;
  /** Explicit source port; default a random port in the dynamic range. */
  srcPort?: number;
}

/** Outcome kind of one {@link DnsResolver.resolve} call. */
export type DnsResolutionStatus = "ok" | "nxdomain" | "timeout" | "error";

/** Result of one name resolution. */
export interface DnsResolution {
  /** Normalized (lowercase, no trailing dot) queried name. */
  name: string;
  status: DnsResolutionStatus;
  /** IPv4 address for `ok`; undefined otherwise. */
  address: string | undefined;
  /** DNS RCODE when a response arrived; undefined on timeout. */
  rcode: number | undefined;
  /** True when the answer came from the TTL cache with no transmission. */
  fromCache: boolean;
  /** Query attempts transmitted (0 for a cache hit). */
  attempts: number;
  /** TTL carried by the cached/answered A record. */
  ttlSeconds?: number;
}

interface CacheEntry {
  address: string;
  ttlSeconds: number;
  expiresAt: number;
}

interface ExchangeResult {
  message: DnsMessage;
  receivedAt: number;
}

function zoneEntries(zone: DnsZone): Array<[string, string]> {
  if (zone instanceof Map) {
    return [...zone.entries()];
  }
  const maybeMap = zone as ReadonlyMap<string, string>;
  if (typeof maybeMap.entries === "function") {
    return [...maybeMap.entries()];
  }
  return Object.entries(zone as Record<string, string>);
}

/**
 * Authoritative DNS server for a static zone.
 *
 * Binds the configured UDP port in the constructor and keeps it until
 * `close()`. Malformed queries are ignored, never thrown back into the host
 * receive path.
 */
export class DnsServer {
  readonly host: Host;
  readonly port: number;
  private readonly ttlSeconds: number;
  private readonly zone = new Map<string, string>();
  private socket: HostUdpSocket | undefined;

  constructor(options: DnsServerOptions) {
    this.host = options.host;
    this.port = checkPort("port", options.port ?? DEFAULT_DNS_PORT);
    this.ttlSeconds = checkTtlSeconds(
      options.ttlSeconds ?? DEFAULT_DNS_TTL_SECONDS,
    );
    for (const [name, address] of zoneEntries(options.zone)) {
      const key = dnsNameKey(name);
      if (key.length === 0) {
        throw new RangeError(`zone name must not be empty: ${name}`);
      }
      this.zone.set(key, parseAddress(`zone entry ${name}`, address));
    }
    this.socket = this.host.bindUdp(this.port, (datagram) => {
      this.answer(datagram);
    });
  }

  /** Stop answering queries. Idempotent. */
  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private answer(datagram: HostUdpDatagram): void {
    const parsed = parseDns(datagram.payload);
    if (!parsed.ok) {
      return;
    }
    const query = parsed.value;
    if (query.flags.qr) {
      return;
    }
    const question = query.questions[0];
    if (question === undefined) {
      return;
    }
    const address = this.zone.get(dnsNameKey(question.name));
    const answers: DnsRecord[] = [];
    let rcode = DNS_RCODE_NOERROR;
    if (address === undefined) {
      rcode = DNS_RCODE_NXDOMAIN;
    } else if (question.type === DNS_TYPE_A) {
      answers.push({
        kind: "a",
        name: question.name,
        type: DNS_TYPE_A,
        class: DNS_CLASS_IN,
        ttl: this.ttlSeconds,
        address,
      });
    }
    const response: DnsMessage = {
      id: query.id,
      flags: {
        qr: true,
        opcode: query.flags.opcode,
        aa: true,
        tc: false,
        rd: query.flags.rd,
        ra: false,
        rcode,
      },
      questions: query.questions,
      answers,
      authorities: [],
      additionals: [],
    };
    try {
      this.host.sendUdp(
        datagram.srcIp,
        datagram.srcPort,
        serializeDnsResponse(response),
        { iface: datagram.iface, srcPort: this.port },
      );
    } catch {
      // A routing/serialization failure must not escape the receive path.
    }
  }
}

/**
 * Caching stub resolver for one authoritative server.
 *
 * `resolve()` is synchronous from the caller's point of view: it advances
 * the simulation until a matching response or the per-attempt deadline, so
 * the caller always sees the deterministic virtual clock afterwards.
 */
export class DnsResolver {
  readonly host: Host;
  readonly sim: Simulation;
  readonly serverIp: string;
  readonly port: number;
  readonly sourcePort: number;
  private readonly timeoutUs: number;
  private readonly retries: number;
  private readonly cache = new Map<string, CacheEntry>();
  private socket: HostUdpSocket | undefined;
  private pending: ((message: DnsMessage) => void) | undefined;
  private idSeed = 0;

  constructor(options: DnsResolverOptions) {
    this.host = options.host;
    this.sim = options.sim;
    this.serverIp = parseAddress("serverIp", options.serverIp);
    this.port = checkPort("port", options.port ?? DEFAULT_DNS_PORT);
    this.timeoutUs = checkDuration(
      "timeoutUs",
      options.timeoutUs ?? DEFAULT_DNS_TIMEOUT_US,
    );
    this.retries = checkRetries(options.retries ?? DEFAULT_DNS_RETRIES);
    this.sourcePort = checkPort(
      "srcPort",
      options.srcPort ??
        DNS_EPHEMERAL_MIN +
          Math.floor(this.sim.random.next() * DNS_EPHEMERAL_PORTS),
    );
    this.socket = this.host.bindUdp(this.sourcePort, (datagram) => {
      this.receive(datagram);
    });
  }

  /** Stop listening and drop cached answers. Idempotent. */
  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.pending = undefined;
    this.cache.clear();
  }

  /** Resolve one A record, consulting the TTL cache before the network. */
  resolve(name: string): DnsResolution {
    if (typeof name !== "string" || name.length === 0) {
      throw new RangeError("name must be a non-empty string");
    }
    if (this.socket === undefined) {
      throw new Error("dns resolver is closed");
    }
    const key = dnsNameKey(name);
    if (key.length === 0) {
      throw new RangeError("dns resolver does not support the root name");
    }

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (this.sim.now < cached.expiresAt) {
        return {
          name: key,
          status: "ok",
          address: cached.address,
          rcode: DNS_RCODE_NOERROR,
          fromCache: true,
          attempts: 0,
          ttlSeconds: Math.max(
            0,
            Math.ceil((cached.expiresAt - this.sim.now) / MICROS_PER_SECOND),
          ),
        };
      }
      this.cache.delete(key);
    }

    const maxAttempts = this.retries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const exchange = this.exchange(key);
      if (exchange === undefined) {
        continue;
      }
      const { message, receivedAt } = exchange;
      if (message.flags.rcode === DNS_RCODE_NXDOMAIN) {
        return {
          name: key,
          status: "nxdomain",
          address: undefined,
          rcode: message.flags.rcode,
          fromCache: false,
          attempts: attempt,
        };
      }
      if (message.flags.rcode !== DNS_RCODE_NOERROR) {
        return {
          name: key,
          status: "error",
          address: undefined,
          rcode: message.flags.rcode,
          fromCache: false,
          attempts: attempt,
        };
      }
      const answer = message.answers.find(
        (record) => record.kind === "a" && dnsNameKey(record.name) === key,
      );
      if (answer === undefined || answer.kind !== "a") {
        return {
          name: key,
          status: "error",
          address: undefined,
          rcode: DNS_RCODE_NOERROR,
          fromCache: false,
          attempts: attempt,
        };
      }
      const ttlSeconds = answer.ttl;
      if (ttlSeconds > 0) {
        this.cache.set(key, {
          address: answer.address,
          ttlSeconds,
          expiresAt: receivedAt + ttlSeconds * MICROS_PER_SECOND,
        });
      }
      return {
        name: key,
        status: "ok",
        address: answer.address,
        rcode: DNS_RCODE_NOERROR,
        fromCache: false,
        attempts: attempt,
        ttlSeconds,
      };
    }

    return {
      name: key,
      status: "timeout",
      address: undefined,
      rcode: undefined,
      fromCache: false,
      attempts: maxAttempts,
    };
  }

  private receive(datagram: HostUdpDatagram): void {
    if (datagram.srcIp !== this.serverIp || datagram.srcPort !== this.port) {
      return;
    }
    const parsed = parseDns(datagram.payload);
    if (!parsed.ok || !parsed.value.flags.qr) {
      return;
    }
    this.pending?.(parsed.value);
  }

  private exchange(name: string): ExchangeResult | undefined {
    const id = this.nextId();
    const deadline = this.sim.now + this.timeoutUs;
    let received: DnsMessage | undefined;
    let receivedAt: number | undefined;
    this.pending = (message) => {
      if (message.id !== id || this.sim.now > deadline) {
        return;
      }
      received = message;
      receivedAt = this.sim.now;
    };
    const query: DnsMessage = {
      id,
      flags: { ...QUERY_FLAGS },
      questions: [{ name, type: DNS_TYPE_A, class: DNS_CLASS_IN }],
      answers: [],
      authorities: [],
      additionals: [],
    };
    this.host.sendUdp(this.serverIp, this.port, serializeDns(query), {
      srcPort: this.sourcePort,
    });
    try {
      this.sim.runUntil(deadline);
    } finally {
      this.pending = undefined;
    }
    if (received === undefined || receivedAt === undefined) {
      return undefined;
    }
    return { message: received, receivedAt };
  }

  private nextId(): number {
    this.idSeed = (this.idSeed % 0xffff) + 1;
    return this.idSeed;
  }
}
