/**
 * Virtual clock and deterministic event queue.
 *
 * Time is a `number` of integer microseconds (exact up to 2^53, ~285 years
 * of virtual time). Events order by `(at, seq)`: the monotonic `seq`
 * tie-break keeps same-timestamp delivery FIFO and replay-identical. The
 * queue is a binary min-heap, so scheduling is O(log n).
 *
 * Execution modes for later UI/CLI work build on three primitives:
 * `step()` (one event), `runUntil()` (horizon) and `runAll()` (instant,
 * with an event budget that turns infinite rescheduling into an error
 * instead of a hang).
 */

import { Mulberry32 } from "./prng";

export const DEFAULT_MAX_EVENTS = 1000000;

interface QueueEntry {
  at: number;
  seq: number;
  cancelled: boolean;
  fired: boolean;
  run: (sim: Simulation) => void;
}

/** Handle to a scheduled event. `cancel()` succeeds at most once. */
export interface TimerHandle {
  /** Absolute virtual time the event is scheduled for. */
  readonly at: number;
  /** Cancel the event if still pending. Returns false if already fired. */
  cancel(): boolean;
}

function checkDelay(delayUs: number): void {
  if (!Number.isFinite(delayUs) || delayUs < 0) {
    throw new RangeError(`delay must be a finite value >= 0: ${delayUs}`);
  }
}

/** Deterministic discrete-event simulation. */
export class Simulation {
  /** Current virtual time in microseconds. */
  now = 0;

  /** The simulation-owned PRNG. Never use `Math.random()` instead. */
  readonly random: Mulberry32;

  private heap: Array<QueueEntry> = [];
  private nextSeq = 0;
  private pending = 0;

  constructor(seed = 0) {
    this.random = new Mulberry32(seed);
  }

  /** Pending (non-cancelled, non-fired) events. Handy for UI backpressure later. */
  get pendingEvents(): number {
    return this.pending;
  }

  /**
   * Schedule `fn` to run `delayUs` after now. Zero delay is allowed and
   * runs after already-queued same-time events (FIFO by schedule order).
   */
  schedule(delayUs: number, fn: (sim: Simulation) => void): TimerHandle {
    checkDelay(delayUs);
    return this.scheduleAt(this.now + delayUs, fn);
  }

  /** Schedule `fn` at an absolute virtual time (must not be in the past). */
  scheduleAt(atUs: number, fn: (sim: Simulation) => void): TimerHandle {
    if (!Number.isFinite(atUs) || atUs < this.now) {
      throw new RangeError(
        `cannot schedule at ${atUs} when now is ${this.now}`,
      );
    }
    if (typeof fn !== "function") {
      throw new TypeError("scheduled callback must be a function");
    }
    const entry: QueueEntry = {
      at: atUs,
      seq: this.nextSeq++,
      cancelled: false,
      fired: false,
      run: fn,
    };
    this.push(entry);
    this.pending++;
    return {
      at: entry.at,
      cancel: () => {
        if (entry.cancelled || entry.fired) {
          return false;
        }
        entry.cancelled = true;
        this.pending--;
        return true;
      },
    };
  }

  /**
   * Run the next pending event. Returns false when the queue is empty
   * (leaves `now` untouched). Cancelled entries are skipped lazily.
   */
  step(): boolean {
    for (;;) {
      const entry = this.pop();
      if (entry === undefined) {
        return false;
      }
      if (entry.cancelled) {
        continue;
      }
      this.now = entry.at;
      entry.fired = true;
      this.pending--;
      entry.run(this);
      return true;
    }
  }

  /**
   * Run events with `at <= untilUs`, then pin `now` to `untilUs`.
   * Returns the events processed. Throws if `untilUs` is behind now.
   */
  runUntil(untilUs: number): number {
    if (!Number.isFinite(untilUs) || untilUs < this.now) {
      throw new RangeError(
        `cannot run until ${untilUs} when now is ${this.now}`,
      );
    }
    let processed = 0;
    while (
      this.peekTime() !== undefined &&
      (this.peekTime() as number) <= untilUs
    ) {
      this.step();
      processed++;
    }
    this.now = untilUs;
    return processed;
  }

  /**
   * Run until the queue drains. Returns the events processed. Throws after
   * `maxEvents` (default 1M): an infinite rescheduling loop is a model bug,
   * and hanging the UI/CLI is worse than failing loudly.
   */
  runAll(maxEvents: number = DEFAULT_MAX_EVENTS): number {
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new RangeError(
        `maxEvents must be a positive integer: ${maxEvents}`,
      );
    }
    let processed = 0;
    while (this.pendingEvents > 0) {
      if (processed >= maxEvents) {
        throw new Error(
          `event budget exhausted after ${processed} events: ` +
            `probable infinite rescheduling loop`,
        );
      }
      this.step();
      processed++;
    }
    return processed;
  }

  private peekTime(): number | undefined {
    for (;;) {
      const top = this.heap[0];
      if (top === undefined || !top.cancelled) {
        return top?.at;
      }
      this.pop();
    }
  }

  private push(entry: QueueEntry): void {
    const heap = this.heap;
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(heap[parent] as QueueEntry, entry) <= 0) {
        break;
      }
      heap[i] = heap[parent] as QueueEntry;
      i = parent;
    }
    heap[i] = entry;
  }

  private pop(): QueueEntry | undefined {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) {
      return undefined;
    }
    const last = heap.pop() as QueueEntry;
    if (heap.length > 0) {
      let i = 0;
      const half = heap.length >> 1;
      while (i < half) {
        let child = i * 2 + 1;
        const right = child + 1;
        if (
          right < heap.length &&
          compare(heap[right] as QueueEntry, heap[child] as QueueEntry) < 0
        ) {
          child = right;
        }
        if (compare(heap[child] as QueueEntry, last) >= 0) {
          break;
        }
        heap[i] = heap[child] as QueueEntry;
        i = child;
      }
      heap[i] = last;
    }
    return top;
  }
}

function compare(a: QueueEntry, b: QueueEntry): number {
  if (a.at !== b.at) {
    return a.at - b.at;
  }
  return a.seq - b.seq;
}
