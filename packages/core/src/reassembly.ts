/**
 * IPv4 fragmentation reassembly (F-34, S3).
 *
 * A destination (or a router delivering to itself) keeps one buffer per
 * `(src, dst, identification, protocol)` tuple. Fragments may arrive in any
 * order and may overlap: the first copy of every byte wins. A buffer is
 * forgotten when the datagram completes, when `timeoutUs` elapses after its
 * first fragment, or when `maxBytes` of fragment payload would be exceeded
 * (RFC 815 shape: the limit is on buffered payload, not on datagram count).
 *
 * The reassembler never throws on wire data: every failure is a typed
 * {@link ReassemblyResult}. It only schedules timers, so time advances
 * through the simulation clock like the rest of the stack.
 */

import type { Ipv4Header, Ipv4Packet } from "@netlab/protocols";
import type { Simulation, TimerHandle } from "./sim";

/** Default time a partial datagram stays buffered: 30 s. */
export const DEFAULT_REASSEMBLY_TIMEOUT_US = 30_000_000;

/** Default fragment-payload memory budget: 1 MiB. */
export const DEFAULT_REASSEMBLY_MAX_BYTES = 1_048_576;

/** Hard cap on fragments held for one datagram (abuse guard). */
const MAX_FRAGMENTS_PER_DATAGRAM = 256;

/** Buffer identity: the tuple RFC 791 uses to group fragments. */
export interface ReassemblyKey {
  src: string;
  dst: string;
  identification: number;
  protocol: number;
}

/** Details reported when an incomplete datagram times out. */
export interface ReassemblyExpiry {
  key: ReassemblyKey;
  /** Fragment payload bytes released. */
  bytes: number;
  /** Fragments that had arrived. */
  fragments: number;
}

/** Tunables for {@link Reassembler}. */
export interface ReassemblyOptions {
  /** Time after the first fragment before the buffer is dropped. */
  timeoutUs?: number;
  /** Maximum fragment payload bytes held across all datagrams. */
  maxBytes?: number;
  /** Called after a partial datagram is dropped by timeout. */
  onExpire?: (expiry: ReassemblyExpiry) => void;
}

/** Why a fragment was refused. */
export type ReassemblyDropReason = "memory_limit" | "invalid";

/** Outcome of offering one datagram (possibly a fragment) to the buffer. */
export type ReassemblyResult =
  | { kind: "complete"; packet: Ipv4Packet }
  | { kind: "pending"; key: ReassemblyKey; bufferedBytes: number }
  | { kind: "dropped"; key: ReassemblyKey; reason: ReassemblyDropReason };

interface Piece {
  /** Byte offset in the reassembled payload. */
  offset: number;
  data: Uint8Array;
}

interface Entry {
  key: ReassemblyKey;
  id: string;
  /** Header of the offset-0 fragment, kept for the reassembled packet. */
  header: Ipv4Header | undefined;
  pieces: Array<Piece>;
  bufferedBytes: number;
  /** Total payload length, known once the last fragment arrives. */
  totalPayload: number | undefined;
  timer: TimerHandle | undefined;
}

function checkTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`reassembly timeoutUs must be >= 0: ${value}`);
  }
  return value;
}

function checkMaxBytes(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `reassembly maxBytes must be a positive integer: ${value}`,
    );
  }
  return value;
}

/** True when the datagram carries a fragment (either flag or offset). */
export function isFragmented(packet: Ipv4Packet): boolean {
  return packet.header.flags.moreFragments || packet.header.fragmentOffset > 0;
}

/** Identity of the reassembly buffer this datagram belongs to. */
export function fragmentKey(packet: Ipv4Packet): ReassemblyKey {
  return {
    src: packet.header.src.toString(),
    dst: packet.header.dst.toString(),
    identification: packet.header.identification,
    protocol: packet.header.protocol,
  };
}

function keyId(key: ReassemblyKey): string {
  return `${key.src}|${key.dst}|${key.identification}|${key.protocol}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Bounded IPv4 reassembly buffer keyed by `(src, dst, id, protocol)`. */
export class Reassembler {
  private readonly sim: Simulation;
  private readonly timeoutUs: number;
  private readonly maxBytes: number;
  private readonly onExpire: ((expiry: ReassemblyExpiry) => void) | undefined;
  private readonly entries = new Map<string, Entry>();
  private buffered = 0;
  private completedCount = 0;
  private expiredCount = 0;
  private droppedCount = 0;

  constructor(sim: Simulation, opts: ReassemblyOptions = {}) {
    this.sim = sim;
    this.timeoutUs = checkTimeout(
      opts.timeoutUs ?? DEFAULT_REASSEMBLY_TIMEOUT_US,
    );
    this.maxBytes = checkMaxBytes(
      opts.maxBytes ?? DEFAULT_REASSEMBLY_MAX_BYTES,
    );
    this.onExpire = opts.onExpire;
  }

  /** Fragment payload bytes currently held. */
  get bufferedBytes(): number {
    return this.buffered;
  }

  /** Partial datagrams currently buffered. */
  get pendingDatagrams(): number {
    return this.entries.size;
  }

  /** Datagrams completed (unfragmented packets are not counted). */
  get completed(): number {
    return this.completedCount;
  }

  /** Partials dropped by timeout. */
  get expired(): number {
    return this.expiredCount;
  }

  /** Fragments/datagrams refused because of the memory limit or bad data. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Offer one parsed datagram. Unfragmented packets complete immediately;
   * fragments are buffered until the payload is contiguous or dropped.
   */
  add(packet: Ipv4Packet): ReassemblyResult {
    const key = fragmentKey(packet);
    const id = keyId(key);
    if (!isFragmented(packet)) {
      return { kind: "complete", packet };
    }

    const offset = packet.header.fragmentOffset * 8;
    const end = offset + packet.payload.length;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      end > 0xffff ||
      packet.payload.length > 0xffff
    ) {
      return this.drop(id, key, "invalid");
    }

    const entry = this.entries.get(id);
    if (entry !== undefined) {
      const duplicate = entry.pieces.find((piece) => piece.offset === offset);
      if (duplicate !== undefined) {
        return sameBytes(duplicate.data, packet.payload)
          ? this.pending(entry)
          : this.drop(id, key, "invalid");
      }
      if (
        !packet.header.flags.moreFragments &&
        entry.totalPayload !== undefined &&
        entry.totalPayload !== end
      ) {
        return this.drop(id, key, "invalid");
      }
      if (entry.pieces.length >= MAX_FRAGMENTS_PER_DATAGRAM) {
        return this.drop(id, key, "invalid");
      }
    }

    if (this.buffered + packet.payload.length > this.maxBytes) {
      this.droppedCount += 1;
      return { kind: "dropped", key, reason: "memory_limit" };
    }

    const target = entry ?? this.createEntry(key, id);
    const data = packet.payload.slice();
    target.pieces.push({ offset, data });
    target.bufferedBytes += data.length;
    this.buffered += data.length;
    if (offset === 0 && target.header === undefined) {
      target.header = packet.header;
    }
    if (!packet.header.flags.moreFragments) {
      target.totalPayload = end;
    }
    return this.tryComplete(target);
  }

  /** Drop every partial datagram (cancels their timers). */
  clear(): void {
    for (const entry of this.entries.values()) {
      entry.timer?.cancel();
    }
    this.entries.clear();
    this.buffered = 0;
  }

  private createEntry(key: ReassemblyKey, id: string): Entry {
    const entry: Entry = {
      key,
      id,
      header: undefined,
      pieces: [],
      bufferedBytes: 0,
      totalPayload: undefined,
      timer: undefined,
    };
    entry.timer = this.sim.schedule(this.timeoutUs, () => this.expire(entry));
    this.entries.set(id, entry);
    return entry;
  }

  private tryComplete(entry: Entry): ReassemblyResult {
    const total = entry.totalPayload;
    if (total === undefined) {
      return this.pending(entry);
    }
    const data = new Uint8Array(total);
    const covered = new Uint8Array(total);
    let coveredBytes = 0;
    const pieces = entry.pieces
      .slice()
      .sort((left, right) => left.offset - right.offset);
    for (const piece of pieces) {
      const start = Math.max(0, piece.offset);
      if (start >= total) {
        continue;
      }
      const limit = Math.min(total, piece.offset + piece.data.length);
      for (let i = start; i < limit; i++) {
        if (covered[i] !== 0) {
          continue;
        }
        covered[i] = 1;
        data[i] = piece.data[i - piece.offset] as number;
        coveredBytes += 1;
      }
    }
    if (coveredBytes !== total) {
      return this.pending(entry);
    }
    const header = entry.header;
    if (header === undefined) {
      return this.drop(entry.id, entry.key, "invalid");
    }
    const headerLen = 20 + header.options.length;
    const packet: Ipv4Packet = {
      header: {
        ...header,
        totalLength: headerLen + total,
        flags: { ...header.flags, moreFragments: false },
        fragmentOffset: 0,
        options: header.options.slice(),
      },
      payload: data,
    };
    this.remove(entry);
    this.completedCount += 1;
    return { kind: "complete", packet };
  }

  private pending(entry: Entry): ReassemblyResult {
    return {
      kind: "pending",
      key: { ...entry.key },
      bufferedBytes: entry.bufferedBytes,
    };
  }

  private drop(
    id: string,
    key: ReassemblyKey,
    reason: ReassemblyDropReason,
  ): ReassemblyResult {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.remove(entry);
    }
    this.droppedCount += 1;
    return { kind: "dropped", key, reason };
  }

  private expire(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) {
      return;
    }
    const bytes = entry.bufferedBytes;
    const fragments = entry.pieces.length;
    this.remove(entry);
    this.expiredCount += 1;
    this.onExpire?.({ key: { ...entry.key }, bytes, fragments });
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) {
      return;
    }
    entry.timer?.cancel();
    entry.timer = undefined;
    this.entries.delete(entry.id);
    this.buffered = Math.max(0, this.buffered - entry.bufferedBytes);
  }
}
