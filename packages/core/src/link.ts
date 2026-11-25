/**
 * Point-to-point link with a per-direction impairment model.
 *
 * A `Link` joins two `Port`s (devices come later; tests use recording
 * doubles). `send()` snapshots the frame once, decides all impairments
 * synchronously in call order, and schedules arrivals on the simulation
 * clock — so the same seed always reproduces the same run.
 *
 * Drop checks run in a fixed order: `link_down` → `mtu_exceeded` →
 * `queue_full` → `loss`/burst. PRNG draws are skipped for degenerate
 * parameters (0/1 rates, zero jitter), keeping the random stream stable
 * when a feature is off. Corruption flips exactly one bit of the shared
 * copy; receivers observe it as a checksum failure, exactly like wire
 * damage. Bandwidth serializes frames per direction through `freeAt`
 * chaining; `queueLimit` bounds in-flight frames (tail drop).
 *
 * Fault injection (F-100) is the same `link_down` path: `setUp(false)` cuts
 * the cable administratively, so both frames handed to `send()` and frames
 * already in flight are dropped with that reason until `setUp(true)`.
 */

import type { Simulation } from "./sim";
import type { DropReason, EndpointId, TraceBus } from "./trace";

/** Receiving side of a link. Devices implement this; tests use doubles. */
export interface Port {
  receive(frame: Uint8Array): void;
}

/** Gilbert-Elliott burst-loss: good state delivers, bad state drops. */
export interface BurstLoss {
  /** Good → bad transition probability per frame. */
  pGoodToBad: number;
  /** Bad → good transition probability per frame. */
  pBadToGood: number;
}

export interface LinkParams {
  /** Base one-way propagation delay in microseconds. */
  latencyUs: number;
  /** Extra uniform delay in [0, jitterUs]. Default 0. */
  jitterUs?: number;
  /** Independent drop probability. Default 0. Replaced by `burst` when set. */
  lossRate?: number;
  /** Two-state burst loss model. Replaces `lossRate` when set. */
  burst?: BurstLoss;
  /** Probability of one extra `latencyUs` of delay (reordering). Default 0. */
  reorderRate?: number;
  /** Probability of delivering a second copy. Default 0. */
  duplicateRate?: number;
  /** Probability of flipping exactly one bit. Default 0. */
  corruptRate?: number;
  /** Bits per second; serializes frames per direction. Unset = infinite. */
  bandwidthBps?: number;
  /** Frames longer than this are dropped. Unset = no enforcement. */
  mtuBytes?: number;
  /** Max in-flight frames per direction (tail drop). Unset = unlimited. */
  queueLimit?: number;
}

interface ResolvedParams {
  latencyUs: number;
  jitterUs: number;
  lossRate: number;
  burst: BurstLoss | undefined;
  reorderRate: number;
  duplicateRate: number;
  corruptRate: number;
  bandwidthBps: number | undefined;
  mtuBytes: number | undefined;
  queueLimit: number;
}

function rate(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new RangeError(`${name} must be a probability in [0, 1]: ${value}`);
  }
  return v;
}

function resolveParams(params: LinkParams): ResolvedParams {
  if (!Number.isFinite(params.latencyUs) || params.latencyUs < 0) {
    throw new RangeError(`latencyUs must be >= 0: ${params.latencyUs}`);
  }
  const jitterUs = params.jitterUs ?? 0;
  if (!Number.isFinite(jitterUs) || jitterUs < 0) {
    throw new RangeError(`jitterUs must be >= 0: ${params.jitterUs}`);
  }
  let burst = params.burst;
  if (burst !== undefined) {
    rate("burst.pGoodToBad", burst.pGoodToBad, 0);
    rate("burst.pBadToGood", burst.pBadToGood, 0);
    burst = { pGoodToBad: burst.pGoodToBad, pBadToGood: burst.pBadToGood };
  }
  const bandwidthBps = params.bandwidthBps;
  if (
    bandwidthBps !== undefined &&
    (!Number.isFinite(bandwidthBps) || bandwidthBps <= 0)
  ) {
    throw new RangeError(`bandwidthBps must be > 0: ${params.bandwidthBps}`);
  }
  const mtuBytes = params.mtuBytes;
  if (
    mtuBytes !== undefined &&
    (!Number.isInteger(mtuBytes) || mtuBytes <= 0)
  ) {
    throw new RangeError(
      `mtuBytes must be a positive integer: ${params.mtuBytes}`,
    );
  }
  const queueLimit = params.queueLimit ?? Number.POSITIVE_INFINITY;
  if (
    queueLimit !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(queueLimit) || queueLimit <= 0)
  ) {
    throw new RangeError(
      `queueLimit must be a positive integer: ${params.queueLimit}`,
    );
  }
  return {
    latencyUs: params.latencyUs,
    jitterUs,
    lossRate: rate("lossRate", params.lossRate, 0),
    burst,
    reorderRate: rate("reorderRate", params.reorderRate, 0),
    duplicateRate: rate("duplicateRate", params.duplicateRate, 0),
    corruptRate: rate("corruptRate", params.corruptRate, 0),
    bandwidthBps,
    mtuBytes,
    queueLimit,
  };
}

export class Link {
  /** Administrative state. Set false to cut the cable (fault injection). */
  up = true;

  private readonly sim: Simulation;
  private readonly id: string;
  private readonly params: ResolvedParams;
  private readonly bus: TraceBus;
  private ports: [Port, Port] | undefined;
  private badState = false;
  private readonly freeAt = [0, 0];
  private readonly inflight = [0, 0];

  constructor(sim: Simulation, id: string, params: LinkParams, bus: TraceBus) {
    this.sim = sim;
    this.id = id;
    this.params = resolveParams(params);
    this.bus = bus;
  }

  /** Attach (or re-attach, for UI rewiring) both endpoints. */
  attach(a: Port, b: Port): void {
    this.ports = [a, b];
  }

  /**
   * Set the administrative state (F-100 `cut` / `restore`).
   *
   * A cut is a plain flag with two effects: the next `send()` reports
   * `link_down` immediately, and every frame already scheduled for arrival is
   * dropped there with the same reason. Nothing crosses a cut cable in either
   * direction, and restoring it makes the next frame pass as usual.
   */
  setUp(up: boolean): void {
    this.up = up;
  }

  /** Transmit a frame from one endpoint toward the other. */
  send(from: EndpointId, frame: Uint8Array): void {
    if (this.ports === undefined) {
      throw new Error(`link ${this.id}: no ports attached`);
    }
    if (!(frame instanceof Uint8Array)) {
      throw new TypeError("link frame must be a Uint8Array");
    }
    const dir = from === "a" ? 0 : 1;
    const to: EndpointId = from === "a" ? "b" : "a";
    const now = this.sim.now;
    const snapshot = frame.slice();

    const drop = (reason: DropReason, where: string): void => {
      this.bus.emit({
        t: now,
        kind: "frame_drop",
        link: this.id,
        where,
        reason,
        length: snapshot.length,
        frame: snapshot,
      });
    };

    if (!this.up) {
      drop("link_down", `${this.id}:${from}>${to}`);
      return;
    }
    const mtu = this.params.mtuBytes;
    if (mtu !== undefined && snapshot.length > mtu) {
      drop("mtu_exceeded", `${this.id}:${from}>${to}`);
      return;
    }

    // Impairment draws, in fixed order, skipped when degenerate.
    const random = this.sim.random;
    let copies = 1;
    const dup = this.params.duplicateRate;
    if (dup === 1 || (dup > 0 && random.next() < dup)) {
      copies = 2;
    }
    if ((this.inflight[dir] as number) + copies > this.params.queueLimit) {
      drop("queue_full", `${this.id}:${from}>${to}`);
      return;
    }
    if (this.shouldDrop()) {
      drop("loss", `${this.id}:${from}>${to}`);
      return;
    }
    const corrupt = this.params.corruptRate;
    if (
      (corrupt === 1 || (corrupt > 0 && random.next() < corrupt)) &&
      snapshot.length > 0
    ) {
      const bit = Math.floor(random.next() * snapshot.length * 8);
      snapshot[bit >> 3] = (snapshot[bit >> 3] as number) ^ (1 << (bit & 7));
    }

    let propagation = this.params.latencyUs;
    if (this.params.jitterUs > 0) {
      propagation += random.next() * this.params.jitterUs;
    }
    const reorder = this.params.reorderRate;
    if (reorder === 1 || (reorder > 0 && random.next() < reorder)) {
      propagation += this.params.latencyUs;
    }

    let serial = 0;
    if (this.params.bandwidthBps !== undefined) {
      serial =
        (snapshot.length * 8 * 1e6) / (this.params.bandwidthBps as number);
    }
    const start = Math.max(now, this.freeAt[dir] as number);
    this.freeAt[dir] = start + serial;
    const arrival = start + serial + propagation;

    this.bus.emit({
      t: now,
      kind: "frame_tx",
      link: this.id,
      from,
      length: snapshot.length,
      frame: snapshot,
    });

    const ports = this.ports;
    const linkId = this.id;
    const bus = this.bus;
    this.inflight[dir] = (this.inflight[dir] as number) + copies;
    for (let c = 0; c < copies; c++) {
      this.sim.scheduleAt(arrival, (s) => {
        this.inflight[dir] = (this.inflight[dir] as number) - 1;
        if (!this.up) {
          bus.emit({
            t: s.now,
            kind: "frame_drop",
            link: linkId,
            where: `${linkId}:${from}>${to}`,
            reason: "link_down",
            length: snapshot.length,
            frame: snapshot,
          });
          return;
        }
        const dst = to === "a" ? ports[0] : ports[1];
        dst.receive(snapshot);
        bus.emit({
          t: s.now,
          kind: "frame_rx",
          link: linkId,
          to,
          length: snapshot.length,
          frame: snapshot,
        });
      });
    }
  }

  private shouldDrop(): boolean {
    const burst = this.params.burst;
    if (burst !== undefined) {
      const random = this.sim.random;
      if (this.badState) {
        if (
          burst.pBadToGood === 1 ||
          (burst.pBadToGood > 0 && random.next() < burst.pBadToGood)
        ) {
          this.badState = false;
        }
      } else {
        if (
          burst.pGoodToBad === 1 ||
          (burst.pGoodToBad > 0 && random.next() < burst.pGoodToBad)
        ) {
          this.badState = true;
        }
      }
      return this.badState;
    }
    const loss = this.params.lossRate;
    return loss === 1 || (loss > 0 && this.sim.random.next() < loss);
  }
}
