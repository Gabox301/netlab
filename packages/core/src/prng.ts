/**
 * Seedable PRNG (mulberry32) for the simulation.
 *
 * All randomness in `@netlab/core` (and everything built on it: links,
 * backoffs, jitter) must flow through an instance owned by `Simulation`.
 * `Math.random()` and `Date.now()` are forbidden in simulation code: they
 * break replay determinism. A 32-bit state is plenty for link models; what
 * matters is that the same seed reproduces the same stream, bit for bit.
 */
export class Mulberry32 {
  private state: number;

  /** Seeds coerce with `>>> 0`, so `-1` and `0xffffffff` match. */
  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next pseudo-random value in `[0, 1)`. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
