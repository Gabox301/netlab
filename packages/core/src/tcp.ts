/**
 * TCP connection state machine (F-54/55) and data transfer (F-56).
 *
 * The eleven states of RFC 793, the three-way handshake (including the
 * simultaneous open that starts from SYN_SENT on both ends), the four-way
 * close and the TIME_WAIT timeout, plus RST handling. The host only owns the
 * TCP port namespace (`Host.bindTcp` / `Host.onTcpSegment`); all connection
 * state lives here.
 *
 * Scope of hito 5.2: payload now counts against the sequence space. `send()`
 * segments by MSS into a send buffer tracked with SND.UNA/SND.NXT and gated
 * by a *fixed* send window; inbound payload is delivered in order (an
 * out-of-order segment is buffered until the gap is filled) and every valid
 * segment earns one cumulative ACK carrying RCV.NXT. Duplicates are
 * re-ACKed without being delivered. There is still no sliding/flow-control
 * window (5.3), no round-trip timer and no retransmission (5.4) and no
 * congestion control (5.5): a lost segment stays pending forever, so a
 * transfer only completes on a lossless path. Control traffic does not gate
 * on data: FIN is queued behind outstanding data and only leaves once the
 * peer has acknowledged every byte, which needs the same lossless path.
 *
 * Time and randomness come from the `Simulation`: the ISN and the ephemeral
 * local port are drawn from `sim.random` (overridable for tests) and
 * TIME_WAIT is a `sim.schedule()` event, so `runUntil()` — never `runAll()`
 * — drives a close with a timer still armed.
 */

import { Ipv4Address } from "@netlab/bytes";
import {
  serializeTcp,
  type TcpFlags,
  type TcpSegment,
} from "@netlab/protocols";
import type { Host, HostTcpSegment, HostTcpSocket } from "./host";
import type { Simulation, TimerHandle } from "./sim";

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
 * Fixed send window (4 segments) until the sliding window of hito 5.3 lands.
 * The peer's advertised window is not consulted yet: we never reduce it.
 */
export const DEFAULT_SEND_WINDOW = 4 * DEFAULT_MSS;

/** Window we advertise: constant until flow control lands in hito 5.3. */
const ADVERTISED_WINDOW = 65535;

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
   * Fixed number of unacknowledged bytes allowed in flight; default
   * {@link DEFAULT_SEND_WINDOW}. The peer's advertised window is not
   * consulted until hito 5.3.
   */
  sendWindow?: number;
  /** Called with each in-order chunk of received data (a fresh copy). */
  onData?: (data: Uint8Array) => void;
}

/** Options for {@link TcpSocket.connect}. */
export interface TcpConnectOptions {
  /** Fixed local port; default an ephemeral port from the dynamic range. */
  localPort?: number;
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
  /** Fixed bytes of unacknowledged data allowed in flight. */
  readonly sendWindow: number;

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
  private timeWaitTimer: TimerHandle | undefined = undefined;
  /** Payload waiting for window space; each entry is already an MSS chunk. */
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
    if (!Number.isInteger(mss) || mss <= 0 || mss > ADVERTISED_WINDOW) {
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
    this.transition("SYN_SENT");
    this.emit({ syn: true }, this.issValue, 0);
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
   * The bytes are copied. Segments leave immediately while the fixed send
   * window has room; the rest stays buffered until valid ACKs advance
   * SND.UNA. Without retransmission (hito 5.4) a lost segment stalls the
   * window forever, so this only completes on a lossless path.
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
   * Data stays here until `read()` even when `onData` is installed.
   */
  read(): Uint8Array {
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
    this.issValue = this.pickInitialSequence();
    this.sndUnaValue = nextSequence(this.issValue);
    this.sndNxtValue = nextSequence(this.issValue);
    this.transition("SYN_RECEIVED");
    this.emit({ syn: true, ack: true }, this.issValue, this.rcvNxtValue);
  }

  /** SYN_SENT: SYN+ACK completes the open, a bare SYN is a simultaneous open. */
  private receiveInSynSent(segment: TcpSegment): void {
    if (!segment.flags.syn) {
      return;
    }
    this.irsValue = segment.seq;
    this.rcvNxtValue = nextSequence(segment.seq);
    if (segment.flags.ack) {
      if (segment.ack !== this.sndNxtValue) {
        return;
      }
      this.transition("ESTABLISHED");
      this.emit({ ack: true }, this.sndNxtValue, this.rcvNxtValue);
      return;
    }
    // Both ends opened at once: answer the peer's SYN with our SYN+ACK.
    this.transition("SYN_RECEIVED");
    this.emit({ syn: true, ack: true }, this.issValue ?? 0, this.rcvNxtValue);
  }

  /** SYN_RECEIVED: the ACK of our SYN+ACK (or of our SYN) opens both ends. */
  private receiveInSynReceived(segment: TcpSegment): void {
    if (!segment.flags.ack || segment.ack !== this.sndNxtValue) {
      return;
    }
    this.transition("ESTABLISHED");
  }

  /**
   * ESTABLISHED: payload is delivered in order and ACKed cumulatively; a FIN
   * that lands on RCV.NXT moves the socket to CLOSE_WAIT.
   */
  private receiveInEstablished(segment: TcpSegment): void {
    this.processAck(segment);
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
   * Advance SND.UNA with an ACK of data (or of the SYN/FIN in flight).
   *
   * ACKs at or below SND.UNA are duplicates and ACKs beyond SND.NXT are
   * invalid; both are ignored. A valid ACK frees window space, so queued
   * payload is flushed and a waiting FIN may leave.
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
    if (acked === 0 || acked > inFlight) {
      return;
    }
    this.sndUnaValue = segment.ack;
    this.flushSend();
    this.maybeSendFin();
  }

  /**
   * Send payload while the fixed send window has room.
   *
   * Each queued chunk is at most one MSS, so the window is never split mid
   * segment and a chunk always fits once the window is empty.
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
      if (inFlight + chunk.length > this.sendWindow) {
        return;
      }
      this.sendQueueHead += 1;
      this.sndNxtValue = advanceSequence(sndNxt, chunk.length);
      this.emit({ ack: true, psh: true }, sndNxt, this.rcvNxtValue ?? 0, chunk);
    }
    this.sendQueue.length = 0;
    this.sendQueueHead = 0;
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
    this.emit({ fin: true, ack: true }, sndNxt, this.rcvNxtValue ?? 0);
  }

  /**
   * Buffer, trim or deliver the payload of one inbound segment.
   *
   * Returns true when the segment earns an ACK: every payload does, whether
   * it was in order, out of order, partial or fully duplicated. Bytes starting
   * exactly at RCV.NXT are delivered (and drain buffered successors); a gap
   * ahead of RCV.NXT is buffered up to the advertised receive window; the
   * already-received prefix of a duplicate is trimmed off.
   */
  private acceptPayload(segment: TcpSegment): boolean {
    const payload = segment.payload;
    if (payload.length === 0) {
      return false;
    }
    const rcvNxt = this.rcvNxtValue ?? 0;
    const offset = (segment.seq - rcvNxt) >>> 0;
    if (offset === 0) {
      this.deliverInOrder(payload);
      return true;
    }
    if (offset < ADVERTISED_WINDOW) {
      if (
        offset + payload.length <= ADVERTISED_WINDOW &&
        !this.reordered.has(segment.seq)
      ) {
        this.reordered.set(segment.seq, new Uint8Array(payload));
      }
      return true;
    }
    const behind = (rcvNxt - segment.seq) >>> 0;
    if (behind < payload.length) {
      this.deliverInOrder(payload.subarray(behind));
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
        window: ADVERTISED_WINDOW,
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
    const binding = this.binding;
    this.binding = undefined;
    binding?.close();
  }

  /** Forget the peer and sequence state of a previous connection. */
  private clearTcb(): void {
    this.remoteIpValue = undefined;
    this.remotePortValue = undefined;
    this.issValue = undefined;
    this.irsValue = undefined;
    this.sndUnaValue = undefined;
    this.sndNxtValue = undefined;
    this.rcvNxtValue = undefined;
    this.sendQueue.length = 0;
    this.sendQueueHead = 0;
    this.finQueued = false;
    this.reordered.clear();
    this.receivedChunks.length = 0;
  }

  private cancelTimeWait(): void {
    const timer = this.timeWaitTimer;
    this.timeWaitTimer = undefined;
    timer?.cancel();
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
