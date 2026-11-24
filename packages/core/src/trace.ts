/**
 * Structured event bus: every significant simulation event becomes an
 * inspectable record.
 *
 * Consumers (UI inspector, PCAP exporter, exercise validators, tests) read
 * through `TraceBus`. Frames travel by reference (no copy): devices and
 * links share one `Uint8Array` per transmission and must treat it as
 * read-only after `send()`. Anything that persists beyond the run (PCAP
 * files, saved replays) copies the bytes it needs.
 */

/** Link endpoint identifier. */
export type EndpointId = "a" | "b";

/** Why a frame never reached its destination. */
export type DropReason = "link_down" | "loss" | "queue_full" | "mtu_exceeded";

/** One observable simulation event. Extended by devices later. */
export type Trace =
  | {
      t: number;
      kind: "frame_tx";
      link: string;
      from: EndpointId;
      length: number;
      frame: Uint8Array;
    }
  | {
      t: number;
      kind: "frame_rx";
      link: string;
      to: EndpointId;
      length: number;
      frame: Uint8Array;
    }
  | {
      t: number;
      kind: "frame_drop";
      link: string;
      where: string;
      reason: DropReason;
      length: number;
      frame: Uint8Array;
    }
  | {
      t: number;
      kind: "state";
      scope: string;
      detail: string;
    }
  | {
      t: number;
      kind: "log";
      scope: string;
      level: string;
      message: string;
    };

/** Fan-out bus with drainable history for tests and batching UI. */
export class TraceBus {
  private traces: Array<Trace> = [];
  private listeners = new Set<(trace: Trace) => void>();

  /** Append a trace and notify subscribers synchronously. */
  emit(trace: Trace): void {
    this.traces.push(trace);
    for (const listener of this.listeners) {
      listener(trace);
    }
  }

  /**
   * Subscribe to future traces. Returns an unsubscribe function.
   * Listeners must not throw: an exception propagates to the emitter.
   */
  subscribe(listener: (trace: Trace) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Buffered traces (tests, UI batching window). */
  get length(): number {
    return this.traces.length;
  }

  /** Take all buffered traces and clear the buffer. */
  drain(): Array<Trace> {
    const taken = this.traces;
    this.traces = [];
    return taken;
  }
}
