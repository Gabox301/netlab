/**
 * TCP connection state machine (F-54/55) and data transfer (F-56/57).
 *
 * The eleven states of RFC 793, the three-way handshake (including the
 * simultaneous open that starts from SYN_SENT on both ends), the four-way
 * close and the TIME_WAIT timeout, plus RST handling. The host only owns the
 * TCP port namespace (`Host.bindTcp` / `Host.onTcpSegment`); all connection
 * state lives here.
 *
 * Scope of hito 5.2: payload counts against the sequence space. `send()`
 * segments by MSS into a send buffer tracked with SND.UNA/SND.NXT; inbound
 * payload is delivered in order (an out-of-order segment is buffered until the
 * gap is filled) and every valid segment earns one cumulative ACK carrying
 * RCV.NXT. Duplicates are re-ACKed without being delivered.
 *
 * Scope of hito 5.3 — the sliding window and flow control:
 *
 * - Sender. The bytes in flight are the ones with `SND.NXT - SND.UNA` below
 *   the effective send window, `min(cwnd, sendWindow, SND.WND)`, where SND.WND
 *   is the window the peer last advertised (taken from the SYN and then from
 *   every *valid* ACK, i.e. every ACK in `[SND.UNA, SND.NXT]`, duplicates
 *   included — a duplicate ACK is a legal carrier for a window update).
 *   `sendWindow` was the fixed stand-in for `cwnd` in this milestone; hito 5.5
 *   replaced it with a real congestion window and left it as the configured
 *   top. A queued chunk is truncated to whatever window space is left, so a
 *   window that is not a multiple of the MSS still makes progress.
 * - Zero-window probing. When SND.WND reaches zero with data still queued, a
 *   *fixed-interval persist timer* (`zeroWindowProbeUs`) sends the first
 *   pending byte at SND.NXT without spending sequence space and re-arms
 *   itself, so the peer answers with its current window. This is deliberately
 *   not the RTO of hito 5.4: no RTT estimate, no backoff, no retransmission
 *   queue — it only asks for a window, the data stays queued.
 * - Receiver. The advertised window is `capacity - buffered`, where the
 *   buffer is both the in-order bytes `read()` has not drained yet and the
 *   out-of-order bytes held for reassembly, and `capacity` (`receiveCapacity`,
 *   default 64 KB - 1 so it fits the 16-bit header field) is configurable.
 *   Shrink is forbidden: in-order delivery advances RCV.NXT by exactly the
 *   bytes it removes from the free space, so the advertised right edge
 *   `RCV.NXT + window` never moves left; the only decrease a peer can see is
 *   the floor of zero when the buffer is completely full. `read()` that
 *   reopens a zero window sends a window update at once. Payload that does not
 *   fit the current window is dropped and re-ACKed, never delivered.
 *
 * Scope of hito 5.4 — retransmission:
 *
 * - RTO. Every segment that spends sequence space (data, SYN, FIN) is kept in
 *   a copy queue until a cumulative ACK covers it, and the first one in that
 *   queue arms the retransmission timer. When the timer expires the oldest
 *   unacknowledged segment is resent byte for byte (same sequence number, same
 *   payload) and the timeout doubles, up to `maxRtoUs`. Any ACK that advances
 *   SND.UNA drops the copies it covers, puts the timeout back to `rtoUs` and
 *   restarts the timer for whatever is still outstanding. Timeouts do **not**
 *   produce an RTT sample (Karn's rule: a resent segment is ambiguous), so the
 *   base value stays fixed; an estimator on top of it is not in this
 *   milestone.
 * - Fast retransmit. Three duplicate ACKs at SND.UNA mean the head segment is
 *   missing while later ones got through, so it is resent immediately instead
 *   of waiting for the timer.
 *
 * Scope of hito 5.5 — congestion control, classic Reno (RFC 5681):
 *
 * - `cwnd` is a byte count that starts at one MSS when the connection opens
 *   and `ssthresh` starts at the configured top (`sendWindow`), the only
 *   ceiling a lossless path can meet. The bytes allowed in flight are
 *   `min(cwnd, SND.WND, sendWindow)`: **cwnd is the congestion limit and the
 *   one that reacts to loss**, SND.WND is the peer's flow-control window, and
 *   `sendWindow` is the operator's fixed top — it stopped being the cwnd
 *   stand-in of hito 5.3 and now only bounds how much this socket may ever put
 *   in flight.
 * - Slow start: every ACK that advances SND.UNA adds `min(acked, MSS)` to cwnd
 *   while `cwnd < ssthresh`, so the window doubles every round trip. Once
 *   `cwnd >= ssthresh` comes congestion avoidance (AIMD's additive part): the
 *   same ACK adds `MSS*MSS/cwnd`, about one MSS per round trip.
 * - Timeout: an RTO is a loss the duplicates did not report, so it halves the
 *   window (Tahoe behaviour): `ssthresh = max(2*MSS, cwnd/2)`, `cwnd = 1 MSS`
 *   and slow start starts over. Repeated timeouts keep halving ssthresh from
 *   the standby one-MSS window, i.e. they floor it at `2*MSS`.
 * - Fast recovery: the third duplicate ACK (the one that already fast
 *   retransmits) sets `ssthresh = max(2*MSS, cwnd/2)` and inflates `cwnd` to
 *   `ssthresh + 3*MSS`, because three segments left the network and sit in the
 *   peer's buffer. Each further duplicate ACK inflates one more MSS, which is
 *   what lets new data leave while the hole is repaired. The first ACK that
 *   covers new data deflates `cwnd` back to `ssthresh` and returns to
 *   congestion avoidance. No SACK and no NewReno partial-ACK handling: one
 *   advancing ACK is taken as the end of recovery.
 * - Observability. `cwnd` and `ssthresh` are public getters and every change is
 *   published on the `TraceBus` given to the socket as a `state()` record in
 *   the same `key=value` mold the router uses, so the UI/CLI can plot the
 *   sawtooth. Hosts keep their bus private, so a caller that wants these
 *   samples passes the same bus it handed the host.
 *
 * Still out of scope: the socket/HTTP API (5.6). Control traffic does not gate
 * on data: FIN is queued behind outstanding data and only leaves once the peer
 * has acknowledged every byte.
 *
 * Time and randomness come from the `Simulation`: the ISN and the ephemeral
 * local port are drawn from `sim.random` (overridable for tests), while
 * TIME_WAIT, the zero-window persist timer and the RTO are `sim.schedule()`
 * events, so `runUntil()` — never `runAll()` — drives a close, a stalled
 * sender or a dead wire with a timer still re-arming.
 */

import { Ipv4Address } from "@netlab/bytes";
import {
  serializeTcp,
  type TcpFlags,
  type TcpSegment,
} from "@netlab/protocols";
import type { Host, HostTcpSegment, HostTcpSocket } from "./host";
import type { Simulation, TimerHandle } from "./sim";
import type { TraceBus } from "./trace";

/** Connection states of RFC 793 (F-54). */
export type TcpState =
  | "CLOSED"
  | "LISTEN"
  | "SYN_SENT"
  | "SYN_RECEIVED"
  | "ESTABLISHED"
  | "CLOSE_WAIT"
  | "LAST_ACK"
  | "FIN_WAIT_1"
  | "FIN_WAIT_2"
  | "CLOSING"
  | "TIME_WAIT";

/** How long the connection that closes first stays in TIME_WAIT. */
export const DEFAULT_TIME_WAIT_US = 60_000_000;

/** Default maximum segment size for the payload we hand to one segment. */
export const DEFAULT_MSS = 1460;

/**
 * Fixed cap on the bytes this socket may ever put in flight: the operator's
 * top, on top of `cwnd` and the peer's window.
 *
 * Since hito 5.5 the effective send window is `min(cwnd, sendWindow, SND.WND)`:
 * the congestion window moves with the path, SND.WND with the peer's buffer,
 * and this value is the fixed ceiling that no congestion growth can cross.
 */
export const DEFAULT_SEND_WINDOW = 4 * DEFAULT_MSS;

/**
 * Receive buffer granted by default, and therefore the window a fresh socket
 * advertises. 65535 is the largest value the 16-bit header field can carry.
 */
export const DEFAULT_RECEIVE_CAPACITY = 0xffff;

/**
 * Fixed interval of the zero-window persist timer. It probes for a window
 * opening only; it is not the retransmission timeout of hito 5.4.
 */
export const DEFAULT_ZERO_WINDOW_PROBE_US = 1_000_000;

/** Largest window value the 16-bit header field can carry. */
const MAX_WINDOW = 0xffff;

/**
 * Retransmission timeout before any backoff (hito 5.4).
 *
 * The value is deliberately fixed: an RTT estimator lands in hito 5.5, so for
 * now every timeout starts from this base and only grows by backoff.
 */
export const DEFAULT_RTO_US = 1_000_000;

/** Ceiling of the exponential RTO backoff (hito 5.4). */
export const DEFAULT_MAX_RTO_US = 60_000_000;

/** RFC 6335 dynamic port range used for ephemeral local ports. */
const TCP_EPHEMERAL_MIN = 49152;
const TCP_EPHEMERAL_MAX = 65535;
const TCP_EPHEMERAL_PORTS = TCP_EPHEMERAL_MAX - TCP_EPHEMERAL_MIN + 1;

const NO_FLAGS: TcpFlags = {
  fin: false,
  syn: false,
  rst: false,
  psh: false,
  ack: false,
  urg: false,
};

const NO_PAYLOAD = new Uint8Array(0);

/** Options for {@link TcpSocket}. */
export interface TcpSocketOptions {
  /** Host that carries the segments and owns the port namespace. */
  host: Host;
  /** Simulation whose clock, timers and PRNG this socket uses. */
  sim: Simulation;
  /** Fixed initial sequence number; default a random 32-bit value. */
  initialSequence?: number;
  /** TIME_WAIT duration; default {@link DEFAULT_TIME_WAIT_US} (60 s). */
  timeWaitUs?: number;
  /** Initial state-change hook. */
  onStateChange?: (state: TcpState, previous: TcpState) => void;
  /** MSS used to segment `send()` data; default {@link DEFAULT_MSS}. */
  mss?: number;
  /**
   * Fixed cap on unacknowledged bytes allowed in flight; default
   * {@link DEFAULT_SEND_WINDOW}. It is the configured top of the effective
   * send window, `min(cwnd, sendWindow, SND.WND)`, and it no longer stands in
   * for `cwnd` (hito 5.5): the congestion window is the one that grows and
   * backs off, this value only bounds it.
   */
  sendWindow?: number;
  /**
   * Receive buffer this socket advertises; default
   * {@link DEFAULT_RECEIVE_CAPACITY}. The advertised window is the free part
   * of it, so a small value is the observable form of backpressure.
   */
  receiveCapacity?: number;
  /**
   * Interval of the zero-window persist timer; default
   * {@link DEFAULT_ZERO_WINDOW_PROBE_US}. Fixed on purpose: no backoff, and
   * unrelated to the RTO of hito 5.4.
   */
  zeroWindowProbeUs?: number;
  /**
   * Retransmission timeout before backoff; default {@link DEFAULT_RTO_US}
   * (1 s). It is the value the timer returns to whenever an ACK advances
   * SND.UNA, and the starting point of the exponential backoff.
   */
  rtoUs?: number;
  /** Ceiling of the RTO backoff; default {@link DEFAULT_MAX_RTO_US} (60 s). */
  maxRtoUs?: number;
  /** Called with each in-order chunk of received data (a fresh copy). */
  onData?: (data: Uint8Array) => void;
  /**
   * Trace bus that receives the congestion `state()` samples (`cwnd`,
   * `ssthresh`, the phase transition). Hosts keep their own bus private, so a
   * caller that wants the sawtooth passes the bus it also gave the host.
   * Without one the connection still works, it just publishes nothing.
   */
  bus?: TraceBus;
}

/** Options for {@link TcpSocket.connect}. */
export interface TcpConnectOptions {
  /** Fixed local port; default an ephemeral port from the dynamic range. */
  localPort?: number;
}

/**
 * One segment put on the wire and not acknowledged yet: the copy the RTO
 * resends. `ack` and `flags` are the ones the original segment carried, so a
 * retransmission repeats its sequence number and payload byte for byte.
 */
interface OutstandingSegment {
  seq: number;
  ack: number;
  flags: TcpFlags;
  payload: Uint8Array;
}

function checkPort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`port must be 0..65535: ${value}`);
  }
  return value;
}

function checkSequence(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be 0..4294967295: ${value}`);
  }
  return value;
}

function nextSequence(value: number): number {
  return (value + 1) >>> 0;
}

/** Advance a sequence number by `length` bytes, wrapping at 2^32. */
function advanceSequence(value: number, length: number): number {
  return (value + length) >>> 0;
}

/**
 * True when `a` comes strictly before `b` in the 32-bit sequence space.
 * Plain `<` would break across the wrap, and the distance has to stay below
 * half the space for the comparison to mean anything.
 */
function sequenceBefore(a: number, b: number): boolean {
  const delta = (b - a) >>> 0;
  return delta !== 0 && delta < 0x8000_0000;
}

/**
 * One TCP connection (or one listening port) on a host.
 *
 * `listen()` reserves a port and waits for a SYN; `connect()` starts the
 * handshake towards a peer; `close()` runs the closing handshake and, from
 * the side that closes first, parks the connection in TIME_WAIT until the
 * timer expires. A received RST tears the connection down from any state.
 */
export class TcpSocket {
  readonly host: Host;
  readonly sim: Simulation;
  /** Called after every state change, with the new and the previous state. */
  onStateChange: ((state: TcpState, previous: TcpState) => void) | undefined =
    undefined;
  /** Called with each in-order chunk of received data (a copy the callee owns). */
  onData: ((data: Uint8Array) => void) | undefined = undefined;
  /** Segment size used by {@link TcpSocket.send}. */
  readonly mss: number;
  /** Fixed top on unacknowledged data, above `cwnd` and the peer's window. */
  readonly sendWindow: number;
  /** Receive buffer whose free part is what this socket advertises. */
  readonly receiveCapacity: number;
  /** Fixed interval of the zero-window persist timer. */
  readonly zeroWindowProbeUs: number;
  /** Retransmission timeout used after an ACK advances SND.UNA. */
  readonly rtoBaseUs: number;
  /** Ceiling the exponential backoff saturates at. */
  readonly maxRtoUs: number;
  /** Bus that receives the congestion `state()` samples, if one was given. */
  readonly bus: TraceBus | undefined;

  private readonly initialSequence: number | undefined;
  private readonly timeWaitUs: number;
  private readonly handler = (segment: HostTcpSegment): void => {
    this.onSegment(segment);
  };

  private stateValue: TcpState = "CLOSED";
  private binding: HostTcpSocket | undefined = undefined;
  private localPortValue: number | undefined = undefined;
  private remoteIpValue: string | undefined = undefined;
  private remotePortValue: number | undefined = undefined;
  private issValue: number | undefined = undefined;
  private irsValue: number | undefined = undefined;
  private sndUnaValue: number | undefined = undefined;
  private sndNxtValue: number | undefined = undefined;
  private rcvNxtValue: number | undefined = undefined;
  /** Peer's advertised window (SND.WND); undefined until its SYN arrives. */
  private sndWndValue: number | undefined = undefined;
  private timeWaitTimer: TimerHandle | undefined = undefined;
  private zeroWindowTimer: TimerHandle | undefined = undefined;
  /** Retransmission timer: armed whenever a segment is unacknowledged. */
  private rtoTimer: TimerHandle | undefined = undefined;
  /** RTO currently in force: the base value, doubled by each timeout. */
  private rtoValue: number;
  /** Consecutive duplicate ACKs seen at SND.UNA (fast retransmit, RFC 5681). */
  private duplicateAcks = 0;
  /** Congestion window in bytes (cwnd); starts at one MSS, grows and halves. */
  private cwndValue: number = DEFAULT_MSS;
  /** Slow-start threshold in bytes (ssthresh), floored at two MSS. */
  private ssthreshValue: number = DEFAULT_SEND_WINDOW;
  /** True while Reno fast recovery is in progress. */
  private fastRecoveryValue = false;
  /**
   * Segments sent and not acknowledged yet, oldest first: the copies the RTO
   * resends. Data, SYN and FIN all spend sequence space, so all three are
   * kept until a cumulative ACK covers them.
   */
  private readonly outstanding: Array<OutstandingSegment> = [];
  /**
   * Payload waiting for window space, as MSS chunks. The head entry can shrink
   * when only part of the advertised window is left, so it always starts at
   * SND.NXT.
   */
  private readonly sendQueue: Array<Uint8Array> = [];
  private sendQueueHead = 0;
  /** FIN asked for by `close()` but not sent yet (data still outstanding). */
  private finQueued = false;
  /** Out-of-order payload keyed by its sequence number. */
  private readonly reordered = new Map<number, Uint8Array>();
  /** In-order bytes not yet drained by `read()`. */
  private readonly receivedChunks: Array<Uint8Array> = [];

  constructor(options: TcpSocketOptions) {
    this.host = options.host;
    this.sim = options.sim;
    this.bus = options.bus;
    this.initialSequence =
      options.initialSequence === undefined
        ? undefined
        : checkSequence("initialSequence", options.initialSequence);
    const timeWaitUs = options.timeWaitUs ?? DEFAULT_TIME_WAIT_US;
    if (!Number.isFinite(timeWaitUs) || timeWaitUs < 0) {
      throw new RangeError(`timeWaitUs must be a finite value >= 0`);
    }
    this.timeWaitUs = timeWaitUs;
    this.onStateChange = options.onStateChange;
    this.onData = options.onData;
    const mss = options.mss ?? DEFAULT_MSS;
    if (!Number.isInteger(mss) || mss <= 0 || mss > MAX_WINDOW) {
      throw new RangeError(`mss must be an integer in 1..65535: ${mss}`);
    }
    this.mss = mss;
    const sendWindow = options.sendWindow ?? DEFAULT_SEND_WINDOW;
    if (!Number.isInteger(sendWindow) || sendWindow < mss) {
      throw new RangeError(
        `sendWindow must be an integer >= mss (${mss}): ${sendWindow}`,
      );
    }
    this.sendWindow = sendWindow;
    const receiveCapacity = options.receiveCapacity ?? DEFAULT_RECEIVE_CAPACITY;
    if (
      !Number.isInteger(receiveCapacity) ||
      receiveCapacity <= 0 ||
      receiveCapacity > MAX_WINDOW
    ) {
      throw new RangeError(
        `receiveCapacity must be an integer in 1..65535: ${receiveCapacity}`,
      );
    }
    this.receiveCapacity = receiveCapacity;
    const zeroWindowProbeUs =
      options.zeroWindowProbeUs ?? DEFAULT_ZERO_WINDOW_PROBE_US;
    if (!Number.isFinite(zeroWindowProbeUs) || zeroWindowProbeUs <= 0) {
      throw new RangeError(
        `zeroWindowProbeUs must be a finite value > 0: ${zeroWindowProbeUs}`,
      );
    }
    this.zeroWindowProbeUs = zeroWindowProbeUs;
    const rtoUs = options.rtoUs ?? DEFAULT_RTO_US;
    if (!Number.isFinite(rtoUs) || rtoUs <= 0) {
      throw new RangeError(`rtoUs must be a finite value > 0: ${rtoUs}`);
    }
    const maxRtoUs = options.maxRtoUs ?? DEFAULT_MAX_RTO_US;
    if (!Number.isFinite(maxRtoUs) || maxRtoUs < rtoUs) {
      throw new RangeError(
        `maxRtoUs must be a finite value >= rtoUs (${rtoUs}): ${maxRtoUs}`,
      );
    }
    this.rtoBaseUs = rtoUs;
    this.maxRtoUs = maxRtoUs;
    this.rtoValue = rtoUs;
    this.resetCongestion();
  }

  /** Current state of the connection. */
  get state(): TcpState {
    return this.stateValue;
  }

  /** Local port, once the socket is listening or connecting. */
  get localPort(): number | undefined {
    return this.localPortValue;
  }

  /** Peer IPv4 address in presentation form, once known. */
  get remoteIp(): string | undefined {
    return this.remoteIpValue;
  }

  /** Peer port, once known. */
  get remotePort(): number | undefined {
    return this.remotePortValue;
  }

  /** Initial sequence number this side sent (or will send) in its SYN. */
  get iss(): number | undefined {
    return this.issValue;
  }

  /** Initial sequence number the peer sent in its SYN. */
  get irs(): number | undefined {
    return this.irsValue;
  }

  /** Next sequence number this side will use. */
  get sndNxt(): number | undefined {
    return this.sndNxtValue;
  }

  /** Oldest sequence number this side has not seen acknowledged. */
  get sndUna(): number | undefined {
    return this.sndUnaValue;
  }

  /** Next sequence number this side expects from the peer. */
  get rcvNxt(): number | undefined {
    return this.rcvNxtValue;
  }

  /**
   * Window the peer last advertised (SND.WND), or undefined before its SYN.
   * The bytes actually allowed in flight are `min(cwnd, sendWindow, sndWnd)`.
   */
  get sndWnd(): number | undefined {
    return this.sndWndValue;
  }

  /** Window this socket would advertise right now (RCV.WND). */
  get rcvWnd(): number {
    return this.freeReceiveWindow();
  }

  /**
   * Retransmission timeout currently in force.
   *
   * Starts at {@link rtoBaseUs}, doubles on every timeout up to
   * {@link maxRtoUs}, and returns to the base value whenever an ACK advances
   * SND.UNA. There is no RTT sample yet: a retransmitted segment produces
   * none (Karn), and the estimator arrives with congestion control (5.5).
   */
  get rtoUs(): number {
    return this.rtoValue;
  }

  /**
   * Congestion window (cwnd) in bytes, RFC 5681.
   *
   * One MSS when the connection opens, doubling per round trip while in slow
   * start, growing by about one MSS per round trip in congestion avoidance and
   * collapsing on a loss. The bytes actually allowed in flight are
   * `min(cwnd, SND.WND, sendWindow)`. It is the number the UI plots; the same
   * value goes out on the trace bus with every change.
   */
  get cwnd(): number {
    return this.cwndValue;
  }

  /**
   * Slow-start threshold (ssthresh) in bytes: where growth switches from
   * doubling to additive. Starts at the configured top, halves on a loss and
   * never drops below two MSS.
   */
  get ssthresh(): number {
    return this.ssthreshValue;
  }

  /** True while Reno fast recovery is repairing a single hole. */
  get fastRecovery(): boolean {
    return this.fastRecoveryValue;
  }

  /**
   * Reserve `port` and wait for a SYN (CLOSED → LISTEN).
   *
   * One connection per socket in this milestone: there is no accept backlog
   * yet (hito 5.6), so a second handshake on the same port is ignored.
   */
  listen(port: number): void {
    this.requireClosed("listen");
    checkPort(port);
    this.clearTcb();
    this.binding = this.host.bindTcp(port, this.handler);
    this.localPortValue = port;
    this.transition("LISTEN");
  }

  /**
   * Start the three-way handshake towards `remoteIp:remotePort`
   * (CLOSED → SYN_SENT).
   *
   * The route is resolved before any state changes, so an unroutable
   * destination throws without leaving a half-open socket behind.
   */
  connect(
    remoteIp: string,
    remotePort: number,
    opts: TcpConnectOptions = {},
  ): void {
    this.requireClosed("connect");
    checkPort(remotePort);
    const destination = Ipv4Address.parse(remoteIp);
    this.host.routeSourceIp(remoteIp);
    this.clearTcb();
    if (opts.localPort !== undefined) {
      checkPort(opts.localPort);
      this.binding = this.host.bindTcp(opts.localPort, this.handler);
      this.localPortValue = opts.localPort;
    } else {
      this.localPortValue = this.openEphemeralPort();
    }
    this.remoteIpValue = destination.toString();
    this.remotePortValue = remotePort;
    this.issValue = this.pickInitialSequence();
    this.sndUnaValue = nextSequence(this.issValue);
    this.sndNxtValue = nextSequence(this.issValue);
    this.traceCongestion("open");
    this.transition("SYN_SENT");
    this.transmit({ syn: true }, this.issValue, 0);
  }

  /**
   * Start the closing handshake.
   *
   * ESTABLISHED → FIN_WAIT_1 and CLOSE_WAIT → LAST_ACK send a FIN; before
   * ESTABLISHED the connection is aborted (RFC 793 §3.8 lets an
   * unimplemented user ABORT use RST, but dropping the TCB is enough here).
   * From LISTEN the socket simply stops listening. Calling it in any other
   * state is a no-op.
   */
  close(): void {
    switch (this.stateValue) {
      case "ESTABLISHED": {
        this.transition("FIN_WAIT_1");
        this.queueFin();
        return;
      }
      case "CLOSE_WAIT": {
        this.transition("LAST_ACK");
        this.queueFin();
        return;
      }
      case "LISTEN":
      case "SYN_SENT":
      case "SYN_RECEIVED": {
        this.transition("CLOSED");
        this.release();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Queue `data` for transmission, segmenting it by MSS.
   *
   * The bytes are copied. Segments leave while `SND.NXT - SND.UNA` stays under
   * `min(cwnd, sendWindow, SND.WND)`, i.e. while the congestion window, the
   * configured top and the window the peer advertised all have room; the rest
   * stays buffered until valid ACKs advance SND.UNA, grow cwnd or the peer
   * reopens its window. A lost segment is repaired by the RTO or the fast
   * retransmit of hito 5.4, so the transfer completes under loss too.
   */
  send(data: Uint8Array): void {
    if (this.stateValue !== "ESTABLISHED" && this.stateValue !== "CLOSE_WAIT") {
      throw new Error(
        `${this.host.id}: send() needs ESTABLISHED or CLOSE_WAIT, ` +
          `state is ${this.stateValue}`,
      );
    }
    if (data.length === 0) {
      return;
    }
    for (let offset = 0; offset < data.length; offset += this.mss) {
      this.sendQueue.push(
        new Uint8Array(data.subarray(offset, offset + this.mss)),
      );
    }
    this.flushSend();
  }

  /**
   * Drain the bytes delivered in order so far.
   *
   * Every returned byte is a copy: mutating it cannot corrupt the connection.
   * Data stays here until `read()` even when `onData` is installed. Draining
   * frees buffer, so a window that had reached zero is reopened here — and a
   * zero-to-positive transition is announced at once with an ACK carrying the
   * new window, otherwise the sender would sit in zero-window probing until its
   * next persist timer fires.
   */
  read(): Uint8Array {
    const wasClosed = this.freeReceiveWindow() === 0;
    const total = this.receivedChunks.reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.receivedChunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.receivedChunks.length = 0;
    if (wasClosed && this.freeReceiveWindow() > 0 && this.canSendSegments()) {
      // A window update is a plain ACK: same sequence numbers, fresh window.
      this.sendAck();
    }
    return out;
  }

  /**
   * Dispatch one inbound segment.
   *
   * RST is honoured from any state, LISTEN only accepts a SYN, and every
   * connected state first checks that the segment belongs to this connection
   * (peer address and port), exactly like RFC 793's segment lookup.
   */
  private onSegment(inbound: HostTcpSegment): void {
    const segment = inbound.segment;
    if (segment.flags.rst) {
      // A reset ends the connection from any state (RFC 793 §3.4).
      this.transition("CLOSED");
      this.release();
      return;
    }
    if (this.stateValue === "LISTEN") {
      this.receiveInListen(inbound, segment);
      return;
    }
    if (this.stateValue === "CLOSED") {
      return;
    }
    if (
      this.remoteIpValue !== inbound.srcIp ||
      this.remotePortValue !== segment.srcPort
    ) {
      return;
    }
    switch (this.stateValue) {
      case "SYN_SENT":
        this.receiveInSynSent(segment);
        return;
      case "SYN_RECEIVED":
        this.receiveInSynReceived(segment);
        return;
      case "ESTABLISHED":
        this.receiveInEstablished(segment);
        return;
      case "FIN_WAIT_1":
        this.receiveInFinWait1(segment);
        return;
      case "FIN_WAIT_2":
        this.receiveInFinWait2(segment);
        return;
      case "CLOSING":
        this.receiveInClosing(segment);
        return;
      case "CLOSE_WAIT":
        // Half-closed: we may still send, and the peer's FIN is re-ACKed.
        this.receiveInCloseWait(segment);
        return;
      case "LAST_ACK":
        this.receiveInLastAck(segment);
        return;
      case "TIME_WAIT":
        this.receiveInTimeWait(segment);
        return;
      default:
        return;
    }
  }

  /** LISTEN: a SYN opens the connection, anything else is not ours. */
  private receiveInListen(inbound: HostTcpSegment, segment: TcpSegment): void {
    if (!segment.flags.syn || segment.flags.ack) {
      return;
    }
    this.remoteIpValue = inbound.srcIp;
    this.remotePortValue = segment.srcPort;
    this.irsValue = segment.seq;
    this.rcvNxtValue = nextSequence(segment.seq);
    // The SYN is where a TCP first learns the peer's window (SND.WND).
    this.sndWndValue = segment.window;
    this.issValue = this.pickInitialSequence();
    this.sndUnaValue = nextSequence(this.issValue);
    this.sndNxtValue = nextSequence(this.issValue);
    this.resetCongestion();
    this.traceCongestion("open");
    this.transition("SYN_RECEIVED");
    this.transmit({ syn: true, ack: true }, this.issValue, this.rcvNxtValue);
  }

  /** SYN_SENT: SYN+ACK completes the open, a bare SYN is a simultaneous open. */
  private receiveInSynSent(segment: TcpSegment): void {
    if (!segment.flags.syn) {
      return;
    }
    this.irsValue = segment.seq;
    this.rcvNxtValue = nextSequence(segment.seq);
    this.sndWndValue = segment.window;
    if (segment.flags.ack) {
      if (segment.ack !== this.sndNxtValue) {
        return;
      }
      this.acknowledgeAll();
      this.transition("ESTABLISHED");
      this.emit({ ack: true }, this.sndNxtValue, this.rcvNxtValue);
      return;
    }
    // Both ends opened at once: answer the peer's SYN with our SYN+ACK.
    this.transition("SYN_RECEIVED");
    this.transmit(
      { syn: true, ack: true },
      this.issValue ?? 0,
      this.rcvNxtValue,
    );
  }

  /** SYN_RECEIVED: the ACK of our SYN+ACK (or of our SYN) opens both ends. */
  private receiveInSynReceived(segment: TcpSegment): void {
    if (!segment.flags.ack || segment.ack !== this.sndNxtValue) {
      return;
    }
    this.acknowledgeAll();
    this.sndWndValue = segment.window;
    this.transition("ESTABLISHED");
  }

  /**
   * ESTABLISHED: payload is delivered in order and ACKed cumulatively; a FIN
   * that lands on RCV.NXT moves the socket to CLOSE_WAIT.
   */
  private receiveInEstablished(segment: TcpSegment): void {
    this.processAck(segment);
    if (segment.flags.syn) {
      // The peer is still in SYN_RECEIVED, so the ACK that completed its open
      // was lost and its RTO re-sent the SYN+ACK: acknowledge it again.
      this.sendAck();
      return;
    }
    const dataAcked = this.acceptPayload(segment);
    if (!segment.flags.fin) {
      if (dataAcked) {
        this.sendAck();
      }
      return;
    }
    const fin = this.acceptFin(segment);
    if (fin === "accepted") {
      this.transition("CLOSE_WAIT");
      this.sendAck();
      return;
    }
    // A retransmitted FIN is re-acknowledged; a FIN with a hole before it
    // waits for the missing bytes (retransmission lands in hito 5.4).
    if (fin === "duplicate" || dataAcked) {
      this.sendAck();
    }
  }

  /**
   * CLOSE_WAIT: our send half is still open for ACKs; the peer's FIN is only
   * re-acknowledged (any payload after it is out of scope for this milestone).
   */
  private receiveInCloseWait(segment: TcpSegment): void {
    this.processAck(segment);
    if (segment.flags.fin) {
      this.acceptFin(segment);
      this.sendAck();
    }
  }

  /** FIN_WAIT_1: the ACK of our FIN moves to FIN_WAIT_2, a FIN to TIME_WAIT. */
  private receiveInFinWait1(segment: TcpSegment): void {
    this.processAck(segment);
    const finAcked = segment.flags.ack && segment.ack === this.sndNxtValue;
    if (segment.flags.fin) {
      const fin = this.acceptFin(segment);
      if (fin === "pending") {
        return;
      }
      this.sendAck();
      if (finAcked) {
        this.enterTimeWait();
        return;
      }
      // Simultaneous close: our FIN is not acknowledged yet.
      this.transition("CLOSING");
      return;
    }
    if (finAcked) {
      this.transition("FIN_WAIT_2");
    }
  }

  /** FIN_WAIT_2: the peer's FIN completes our close. */
  private receiveInFinWait2(segment: TcpSegment): void {
    this.processAck(segment);
    if (!segment.flags.fin) {
      return;
    }
    if (this.acceptFin(segment) === "pending") {
      return;
    }
    this.sendAck();
    this.enterTimeWait();
  }

  /** CLOSING: the last ACK sends us into TIME_WAIT. */
  private receiveInClosing(segment: TcpSegment): void {
    this.processAck(segment);
    if (!segment.flags.ack || segment.ack !== this.sndNxtValue) {
      return;
    }
    this.enterTimeWait();
  }

  /** LAST_ACK: the ACK of our FIN retires the TCB. */
  private receiveInLastAck(segment: TcpSegment): void {
    this.processAck(segment);
    if (!segment.flags.ack || segment.ack !== this.sndNxtValue) {
      return;
    }
    this.transition("CLOSED");
    this.release();
  }

  /** TIME_WAIT: a retransmitted FIN is re-acknowledged, nothing else happens. */
  private receiveInTimeWait(segment: TcpSegment): void {
    if (!segment.flags.fin) {
      return;
    }
    if (this.acceptFin(segment) === "pending") {
      return;
    }
    this.sendAck();
  }

  /**
   * Advance SND.UNA with an ACK of data (or of the SYN/FIN in flight) and
   * refresh SND.WND from the window the peer advertises.
   *
   * Any ACK in `[SND.UNA, SND.NXT]` is valid and carries a fresh window; ACKs
   * beyond SND.NXT are invalid and change nothing (RFC 793 §3.9). An ACK at
   * SND.UNA is a duplicate for the sequence space but still a legitimate
   * window update — it is how a zero-window probe learns the peer has room
   * again — so it refreshes SND.WND and retries the send path. An ACK that
   * advances SND.UNA also frees window space, so queued payload is flushed and
   * a waiting FIN may leave.
   */
  private processAck(segment: TcpSegment): void {
    if (!segment.flags.ack) {
      return;
    }
    const sndUna = this.sndUnaValue;
    const sndNxt = this.sndNxtValue;
    if (sndUna === undefined || sndNxt === undefined) {
      return;
    }
    const acked = (segment.ack - sndUna) >>> 0;
    const inFlight = (sndNxt - sndUna) >>> 0;
    if (acked > inFlight) {
      return;
    }
    this.sndWndValue = segment.window;
    if (acked === 0) {
      // A duplicate ACK still carries a window update, and it is how a
      // fast retransmit learns that a segment went missing (RFC 5681).
      if (
        segment.payload.length === 0 &&
        !segment.flags.syn &&
        !segment.flags.fin &&
        this.outstanding.length > 0
      ) {
        this.duplicateAcks += 1;
        if (this.duplicateAcks === 3) {
          this.enterFastRecovery();
        } else if (this.duplicateAcks > 3 && this.fastRecoveryValue) {
          // Every further duplicate ACK means one more segment left the
          // network and is waiting in the peer's buffer, so the window is
          // inflated by one MSS and new data may follow (Reno).
          this.cwndValue += this.mss;
          this.traceCongestion("fast_recovery_inflate");
        }
      }
      this.flushSend();
      return;
    }
    this.sndUnaValue = segment.ack;
    this.onAckAdvanced(acked);
    this.flushSend();
    this.maybeSendFin();
  }

  /**
   * Send payload while the effective send window has room.
   *
   * A queued chunk is truncated to the space left, so a window that is not a
   * multiple of the MSS still makes progress instead of deadlocking. A chunk
   * always fits once the window is empty and at least one byte is free. When
   * the peer window is closed the persist timer takes over.
   */
  private flushSend(): void {
    while (this.sendQueueHead < this.sendQueue.length) {
      const chunk = this.sendQueue[this.sendQueueHead];
      const sndUna = this.sndUnaValue;
      const sndNxt = this.sndNxtValue;
      if (chunk === undefined || sndUna === undefined || sndNxt === undefined) {
        return;
      }
      const inFlight = (sndNxt - sndUna) >>> 0;
      const window = this.effectiveSendWindow();
      const space = window - inFlight;
      if (space <= 0) {
        if (window === 0) {
          this.armZeroWindowProbe();
        }
        return;
      }
      const length = Math.min(chunk.length, space);
      const piece = length < chunk.length ? chunk.subarray(0, length) : chunk;
      if (length < chunk.length) {
        this.sendQueue[this.sendQueueHead] = chunk.subarray(length);
      } else {
        this.sendQueueHead += 1;
      }
      this.sndNxtValue = advanceSequence(sndNxt, length);
      this.transmit(
        { ack: true, psh: true },
        sndNxt,
        this.rcvNxtValue ?? 0,
        piece,
      );
    }
    this.sendQueue.length = 0;
    this.sendQueueHead = 0;
    this.cancelZeroWindowProbe();
  }

  /**
   * Bytes allowed in flight: `min(cwnd, SND.WND, sendWindow)`.
   *
   * `cwnd` is the congestion limit and the one that reacts to loss, SND.WND is
   * the peer's flow-control window and `sendWindow` the operator's fixed top.
   * Additive increase keeps cwnd as a fraction, so the byte boundary is
   * floored here: a window is a whole number of bytes.
   */
  private effectiveSendWindow(): number {
    const sndWnd = this.sndWndValue ?? 0;
    return Math.min(Math.floor(this.cwndValue), sndWnd, this.sendWindow);
  }

  /** Arm the fixed-interval zero-window persist timer (idempotent). */
  private armZeroWindowProbe(): void {
    if (this.zeroWindowTimer !== undefined) {
      return;
    }
    this.zeroWindowTimer = this.sim.schedule(this.zeroWindowProbeUs, () => {
      this.zeroWindowTimer = undefined;
      this.sendZeroWindowProbe();
    });
  }

  private cancelZeroWindowProbe(): void {
    const timer = this.zeroWindowTimer;
    this.zeroWindowTimer = undefined;
    timer?.cancel();
  }

  /**
   * Zero-window probe: resend the first pending byte at SND.NXT without
   * spending sequence space, so the peer answers with its current window.
   *
   * The byte is outside the peer's closed window, so the peer drops it and
   * re-ACKs; nothing is lost because SND.NXT did not move. This is a persist
   * timer, not an RTO: no RTT estimate, no backoff, no retransmission queue
   * (hito 5.4) — the interval is the fixed `zeroWindowProbeUs`.
   */
  private sendZeroWindowProbe(): void {
    if (!this.canSendSegments()) {
      return;
    }
    if (this.sendQueueHead >= this.sendQueue.length) {
      return;
    }
    const sndNxt = this.sndNxtValue;
    const head = this.sendQueue[this.sendQueueHead];
    if (sndNxt === undefined || head === undefined || head.length === 0) {
      return;
    }
    if (this.effectiveSendWindow() > 0) {
      // The window reopened while the timer was queued: send normally.
      this.flushSend();
      return;
    }
    this.emit(
      { ack: true, psh: true },
      sndNxt,
      this.rcvNxtValue ?? 0,
      head.subarray(0, 1),
    );
    this.armZeroWindowProbe();
  }

  /** True while this side may still put payload (not just ACKs) on the wire. */
  private canSendSegments(): boolean {
    return (
      this.stateValue === "ESTABLISHED" ||
      this.stateValue === "CLOSE_WAIT" ||
      this.stateValue === "FIN_WAIT_1" ||
      this.stateValue === "LAST_ACK"
    );
  }

  /**
   * Emit one segment and, when it spends sequence space, keep a copy for
   * retransmission and arm the RTO.
   *
   * The copy is what the timer and the fast retransmit resend: the payload is
   * taken by value, so later reuse of the send buffer cannot change bytes that
   * are already on the wire.
   */
  private transmit(
    flags: Partial<TcpFlags>,
    seq: number,
    ack: number,
    payload: Uint8Array = NO_PAYLOAD,
  ): void {
    this.emit(flags, seq, ack, payload);
    if (payload.length === 0 && flags.syn !== true && flags.fin !== true) {
      // Pure ACKs spend no sequence space and are never retransmitted.
      return;
    }
    const stored: OutstandingSegment = {
      seq,
      ack,
      flags: { ...NO_FLAGS, ...flags },
      payload: new Uint8Array(payload),
    };
    const last = this.outstanding.at(-1);
    if (last !== undefined && last.seq === seq) {
      // A simultaneous open answers our SYN with our own SYN+ACK: same
      // sequence number, so it replaces the queued SYN instead of stacking.
      this.outstanding[this.outstanding.length - 1] = stored;
    } else {
      this.outstanding.push(stored);
    }
    this.armRto();
  }

  /** Arm the retransmission timer when something is outstanding and idle. */
  private armRto(): void {
    if (this.rtoTimer !== undefined || this.outstanding.length === 0) {
      return;
    }
    this.rtoTimer = this.sim.schedule(this.rtoValue, () => {
      this.rtoTimer = undefined;
      this.onRto();
    });
  }

  private cancelRto(): void {
    const timer = this.rtoTimer;
    this.rtoTimer = undefined;
    timer?.cancel();
  }

  /**
   * RTO expiry: resend the oldest unacknowledged segment and back off.
   *
   * Karn's rule keeps the clock honest: a resent segment carries no RTT
   * sample, so the timeout only doubles — up to `maxRtoUs` — until an ACK
   * advances SND.UNA. The window reaction is Tahoe's: a timeout means the
   * duplicates never reported the loss, so `ssthresh` halves (floored at two
   * MSS), `cwnd` drops to one MSS and slow start starts over. A timeout also
   * ends fast recovery, if one was in progress.
   */
  private onRto(): void {
    if (this.outstanding.length === 0 || !this.canRetransmit()) {
      return;
    }
    // The resend restarts the duplicate-ACK count: those ACKs were about the
    // lost attempt, and it is the timer that answered them now.
    this.duplicateAcks = 0;
    this.fastRecoveryValue = false;
    this.ssthreshValue = Math.max(2 * this.mss, Math.floor(this.cwndValue / 2));
    this.cwndValue = this.mss;
    this.traceCongestion("timeout");
    this.retransmitOldest();
    this.rtoValue = Math.min(this.rtoValue * 2, this.maxRtoUs);
    this.armRto();
  }

  /**
   * Fast recovery, classic Reno (RFC 5681 §3.2): the third duplicate ACK at
   * SND.UNA both fast retransmits the head segment and opens the recovery
   * window.
   *
   * `ssthresh` drops to half the current window (floored at two MSS) and
   * `cwnd` is inflated to `ssthresh + 3*MSS`: three segments already left the
   * network and wait in the peer's buffer, so the sender may replace them.
   * Every further duplicate ACK inflates one more MSS, and the first ACK that
   * covers new data deflates the window back to `ssthresh` and returns to
   * congestion avoidance — no await for a timeout, no Tahoe collapse. Without
   * SACK there is no way to tell a partial ACK from a full one, so classic
   * Reno is what closes the recovery here.
   */
  private enterFastRecovery(): void {
    const oldest = this.outstanding[0];
    if (oldest === undefined || oldest.payload.length === 0) {
      return;
    }
    this.ssthreshValue = Math.max(2 * this.mss, Math.floor(this.cwndValue / 2));
    this.cwndValue = this.ssthreshValue + 3 * this.mss;
    this.fastRecoveryValue = true;
    this.retransmitOldest();
    this.traceCongestion("fast_recovery");
  }

  /** Resend the oldest outstanding segment: same SEQ, same ACK, same bytes. */
  private retransmitOldest(): void {
    const segment = this.outstanding[0];
    if (segment === undefined) {
      return;
    }
    this.emit(segment.flags, segment.seq, segment.ack, segment.payload);
  }

  /** States in which an outstanding segment may still be resent. */
  private canRetransmit(): boolean {
    switch (this.stateValue) {
      case "CLOSED":
      case "LISTEN":
      case "FIN_WAIT_2":
      case "TIME_WAIT":
        return false;
      default:
        return true;
    }
  }

  /** Drop the copies a cumulative ACK has fully covered. */
  private purgeAcknowledged(): void {
    const sndUna = this.sndUnaValue;
    if (sndUna === undefined) {
      this.outstanding.length = 0;
      return;
    }
    while (this.outstanding.length > 0) {
      const head = this.outstanding[0];
      if (head === undefined) {
        break;
      }
      const control = (head.flags.syn ? 1 : 0) + (head.flags.fin ? 1 : 0);
      const end = advanceSequence(head.seq, head.payload.length + control);
      if (sequenceBefore(sndUna, end)) {
        // Still (partly) outstanding. A partially acknowledged segment stays
        // queued whole: resending a few acknowledged bytes is legal, and this
        // sender never hands out a segment longer than the free window.
        break;
      }
      this.outstanding.shift();
    }
  }

  /** Forget the duplicate-ACK count and put the RTO back at its base value. */
  private resetRetransmission(): void {
    this.duplicateAcks = 0;
    this.rtoValue = this.rtoBaseUs;
    this.cancelRto();
  }

  /** An ACK advanced SND.UNA: the path is alive again, restart the clock. */
  private onAckAdvanced(acked: number): void {
    this.resetRetransmission();
    this.purgeAcknowledged();
    this.onCongestionAck(acked);
    this.armRto();
  }

  /**
   * Move `cwnd` on an ACK that advances SND.UNA (RFC 5681 §3.1).
   *
   * Slow start adds one MSS per acknowledged segment while cwnd is under
   * ssthresh, so the window doubles every round trip; congestion avoidance
   * adds `MSS*MSS/cwnd` instead, about one MSS per round trip. The ACK that
   * ends Reno fast recovery only deflates the window to `ssthresh`: the loss
   * was already paid for when the recovery opened.
   */
  private onCongestionAck(acked: number): void {
    if (this.fastRecoveryValue) {
      this.fastRecoveryValue = false;
      this.cwndValue = this.ssthreshValue;
      this.traceCongestion("fast_recovery_exit");
      return;
    }
    const cwnd = this.cwndValue;
    if (cwnd < this.ssthreshValue) {
      // Byte counting: a cumulative ACK never grows the window by more than
      // one segment, and a short one grows it by exactly what it covered.
      this.cwndValue = cwnd + Math.min(acked, this.mss);
      this.traceCongestion("slow_start");
      return;
    }
    this.cwndValue = cwnd + (this.mss * this.mss) / cwnd;
    this.traceCongestion("congestion_avoidance");
  }

  /**
   * Reset the congestion state for a fresh connection: one MSS of window and
   * a threshold at the configured top, the only ceiling a lossless path meets.
   *
   * It also runs from `clearTcb()`, so a socket reused after a close starts
   * from a clean window instead of the one the previous connection left.
   */
  private resetCongestion(): void {
    this.cwndValue = this.mss;
    this.ssthreshValue = this.sendWindow;
    this.fastRecoveryValue = false;
  }

  /** The handshake acknowledged everything we sent (our SYN or SYN+ACK). */
  private acknowledgeAll(): void {
    this.resetRetransmission();
    this.outstanding.length = 0;
  }

  /** Window this socket advertises: the free part of its receive buffer. */
  private freeReceiveWindow(): number {
    const free = this.receiveCapacity - this.bufferedBytes();
    if (free <= 0) {
      return 0;
    }
    return Math.min(free, MAX_WINDOW);
  }

  /** Bytes held for the application: delivered plus out-of-order buffered. */
  private bufferedBytes(): number {
    let total = 0;
    for (const chunk of this.receivedChunks) {
      total += chunk.length;
    }
    for (const chunk of this.reordered.values()) {
      total += chunk.length;
    }
    return total;
  }

  /** Queue the FIN asked for by `close()` and send it if no data is pending. */
  private queueFin(): void {
    if (this.finQueued) {
      return;
    }
    this.finQueued = true;
    this.flushSend();
    this.maybeSendFin();
  }

  /**
   * Emit a queued FIN once every byte queued before `close()` was sent and
   * acknowledged. Without retransmission (hito 5.4) a lost byte blocks it.
   */
  private maybeSendFin(): void {
    if (!this.finQueued) {
      return;
    }
    if (this.stateValue !== "FIN_WAIT_1" && this.stateValue !== "LAST_ACK") {
      return;
    }
    if (this.sendQueueHead < this.sendQueue.length) {
      return;
    }
    const sndUna = this.sndUnaValue;
    const sndNxt = this.sndNxtValue;
    if (sndUna === undefined || sndNxt === undefined || sndUna !== sndNxt) {
      return;
    }
    this.finQueued = false;
    this.sndNxtValue = nextSequence(sndNxt);
    this.transmit({ fin: true, ack: true }, sndNxt, this.rcvNxtValue ?? 0);
  }

  /**
   * Buffer, trim or deliver the payload of one inbound segment.
   *
   * Returns true when the segment earns an ACK: every payload does, whether
   * it was in order, out of order, partial or fully duplicated, and a segment
   * that falls outside the advertised window is dropped but still ACKed (that
   * ACK is what tells a zero-window prober the window is still closed). Bytes
   * starting exactly at RCV.NXT are delivered (and drain buffered successors)
   * while they fit the advertised window; a gap ahead of RCV.NXT is buffered
   * when it fits; the already-received prefix of a duplicate is trimmed off.
   */
  private acceptPayload(segment: TcpSegment): boolean {
    const payload = segment.payload;
    if (payload.length === 0) {
      return false;
    }
    const rcvNxt = this.rcvNxtValue ?? 0;
    const window = this.freeReceiveWindow();
    const offset = (segment.seq - rcvNxt) >>> 0;
    if (offset === 0) {
      if (payload.length > window) {
        return true;
      }
      this.deliverInOrder(payload);
      return true;
    }
    if (offset < 0x8000_0000) {
      if (
        offset + payload.length <= window &&
        !this.reordered.has(segment.seq)
      ) {
        this.reordered.set(segment.seq, new Uint8Array(payload));
      }
      return true;
    }
    const behind = (rcvNxt - segment.seq) >>> 0;
    if (behind < payload.length) {
      const tail = payload.subarray(behind);
      if (tail.length <= window) {
        this.deliverInOrder(tail);
      }
    }
    return true;
  }

  /** Deliver bytes that start exactly at RCV.NXT, then any buffered run. */
  private deliverInOrder(bytes: Uint8Array): void {
    const rcvNxt = this.rcvNxtValue ?? 0;
    this.rcvNxtValue = advanceSequence(rcvNxt, bytes.length);
    this.deliver(bytes);
    while (true) {
      const next = this.rcvNxtValue ?? 0;
      const buffered = this.reordered.get(next);
      if (buffered === undefined) {
        return;
      }
      this.reordered.delete(next);
      this.rcvNxtValue = advanceSequence(next, buffered.length);
      this.deliver(buffered);
    }
  }

  /** Hand one in-order chunk to the application (always as a fresh copy). */
  private deliver(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes);
    this.receivedChunks.push(copy);
    this.onData?.(new Uint8Array(copy));
  }

  /**
   * Apply a FIN against RCV.NXT: "accepted" consumes one sequence number,
   * "duplicate" is a FIN already accounted for and "pending" means the gap
   * before it is still missing (retransmission lands in hito 5.4).
   */
  private acceptFin(segment: TcpSegment): "accepted" | "duplicate" | "pending" {
    const finSeq = advanceSequence(segment.seq, segment.payload.length);
    const rcvNxt = this.rcvNxtValue ?? 0;
    const offset = (finSeq - rcvNxt) >>> 0;
    if (offset === 0) {
      this.rcvNxtValue = nextSequence(finSeq);
      return "accepted";
    }
    if (offset < 0x8000_0000) {
      return "pending";
    }
    return "duplicate";
  }

  /** Acknowledge everything received so far (ACK = RCV.NXT). */
  private sendAck(): void {
    this.emit({ ack: true }, this.sndNxtValue ?? 0, this.rcvNxtValue ?? 0);
  }

  /** Enter TIME_WAIT and arm the 2MSL timer on the simulation clock. */
  private enterTimeWait(): void {
    this.transition("TIME_WAIT");
    this.cancelTimeWait();
    this.timeWaitTimer = this.sim.schedule(this.timeWaitUs, () => {
      this.timeWaitTimer = undefined;
      this.transition("CLOSED");
      this.release();
    });
  }

  /** Emit one segment of this connection (control or payload). */
  private emit(
    flags: Partial<TcpFlags>,
    seq: number,
    ack: number,
    payload: Uint8Array = NO_PAYLOAD,
  ): void {
    const remoteIp = this.remoteIpValue;
    const localPort = this.localPortValue;
    const remotePort = this.remotePortValue;
    if (
      remoteIp === undefined ||
      localPort === undefined ||
      remotePort === undefined
    ) {
      return;
    }
    const destination = Ipv4Address.parse(remoteIp);
    const source = this.host.routeSourceIp(remoteIp);
    const bytes = serializeTcp(
      {
        srcPort: localPort,
        dstPort: remotePort,
        seq,
        ack,
        flags: { ...NO_FLAGS, ...flags },
        window: this.freeReceiveWindow(),
        urgent: 0,
        payload,
      },
      source,
      destination,
    );
    this.host.sendTcpSegment(remoteIp, bytes, { srcIp: source.toString() });
  }

  /** ISN: the configured override, else a random 32-bit value from `sim`. */
  private pickInitialSequence(): number {
    if (this.initialSequence !== undefined) {
      return this.initialSequence;
    }
    return Math.floor(this.sim.random.next() * 0x1_0000_0000) >>> 0;
  }

  /**
   * Reserve a free ephemeral local port, starting from a random one drawn
   * from `sim.random` and scanning forward when it is taken.
   */
  private openEphemeralPort(): number {
    const first = Math.floor(this.sim.random.next() * TCP_EPHEMERAL_PORTS);
    const start = TCP_EPHEMERAL_MIN + first;
    for (let offset = 0; offset < TCP_EPHEMERAL_PORTS; offset += 1) {
      const port =
        TCP_EPHEMERAL_MIN +
        ((start - TCP_EPHEMERAL_MIN + offset) % TCP_EPHEMERAL_PORTS);
      // A taken port throws from bindTcp: keep scanning, the loop below ends.
      const binding = this.tryBind(port);
      if (binding !== undefined) {
        this.binding = binding;
        return port;
      }
    }
    throw new Error(
      `${this.host.id}: no free ephemeral TCP port in ` +
        `${TCP_EPHEMERAL_MIN}..${TCP_EPHEMERAL_MAX}`,
    );
  }

  private tryBind(port: number): HostTcpSocket | undefined {
    try {
      return this.host.bindTcp(port, this.handler);
    } catch {
      // Port already reserved by another socket: caller tries the next one.
      return undefined;
    }
  }

  /** Release the port reservation; the TCB keeps its last-known numbers. */
  private release(): void {
    this.cancelTimeWait();
    this.cancelZeroWindowProbe();
    // A torn-down connection has nothing left to retransmit.
    this.resetRetransmission();
    this.outstanding.length = 0;
    const binding = this.binding;
    this.binding = undefined;
    binding?.close();
  }

  /** Forget the peer and sequence state of a previous connection. */
  private clearTcb(): void {
    this.cancelZeroWindowProbe();
    this.resetRetransmission();
    this.outstanding.length = 0;
    this.remoteIpValue = undefined;
    this.remotePortValue = undefined;
    this.issValue = undefined;
    this.irsValue = undefined;
    this.sndUnaValue = undefined;
    this.sndNxtValue = undefined;
    this.rcvNxtValue = undefined;
    this.sndWndValue = undefined;
    this.sendQueue.length = 0;
    this.sendQueueHead = 0;
    this.finQueued = false;
    this.reordered.clear();
    this.receivedChunks.length = 0;
    this.resetCongestion();
  }

  private cancelTimeWait(): void {
    const timer = this.timeWaitTimer;
    this.timeWaitTimer = undefined;
    timer?.cancel();
  }

  /** Scope of this socket's congestion records: host id plus local port. */
  private traceScope(): string {
    const port = this.localPortValue;
    return port === undefined
      ? `${this.host.id}:tcp`
      : `${this.host.id}:tcp/${port}`;
  }

  /**
   * Publish one congestion-window sample on the trace bus.
   *
   * The record follows the `state()` mold the router already uses: `key=value`
   * tokens whose first word names the phase transition (`open`,
   * `slow_start`, `congestion_avoidance`, `fast_recovery`,
   * `fast_recovery_inflate`, `fast_recovery_exit`, `timeout`). `cwnd` and
   * `ssthresh` are the rounded byte counts the getters expose, so the UI/CLI
   * can plot the sawtooth straight from the trace stream.
   */
  private traceCongestion(event: string): void {
    const bus = this.bus;
    if (bus === undefined) {
      return;
    }
    bus.emit({
      t: this.sim.now,
      kind: "state",
      scope: this.traceScope(),
      detail:
        `${event} cwnd=${Math.round(this.cwndValue)} ` +
        `ssthresh=${Math.round(this.ssthreshValue)} ` +
        `sndUna=${this.sndUnaValue ?? 0}`,
    });
  }

  private transition(state: TcpState): void {
    const previous = this.stateValue;
    if (previous === state) {
      return;
    }
    this.stateValue = state;
    this.onStateChange?.(state, previous);
  }

  private requireClosed(action: string): void {
    if (this.stateValue !== "CLOSED") {
      throw new Error(
        `${this.host.id}: ${action}() needs a CLOSED socket, ` +
          `state is ${this.stateValue}`,
      );
    }
  }
}
