/**
 * TCP connection state machine (F-54/55).
 *
 * The eleven states of RFC 793, the three-way handshake (including the
 * simultaneous open that starts from SYN_SENT on both ends), the four-way
 * close and the TIME_WAIT timeout, plus RST handling. The host only owns the
 * TCP port namespace (`Host.bindTcp` / `Host.onTcpSegment`); all connection
 * state lives here.
 *
 * Scope of hito 5.1: control traffic only. There are no send/receive buffers
 * and no sequence-space accounting for payload yet (hito 5.2), no sliding
 * window (5.3) and no retransmission timers (5.4), so the only timer this
 * module arms is TIME_WAIT. Payload bytes that arrive are ignored.
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
  private sndNxtValue: number | undefined = undefined;
  private rcvNxtValue: number | undefined = undefined;
  private timeWaitTimer: TimerHandle | undefined = undefined;

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
    this.sndNxtValue = nextSequence(this.issValue);
    this.transition("SYN_SENT");
    this.send({ syn: true }, this.issValue, 0);
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
        const seq = this.sndNxtValue ?? 0;
        this.sndNxtValue = nextSequence(seq);
        this.transition("FIN_WAIT_1");
        this.send({ fin: true, ack: true }, seq, this.rcvNxtValue ?? 0);
        return;
      }
      case "CLOSE_WAIT": {
        const seq = this.sndNxtValue ?? 0;
        this.sndNxtValue = nextSequence(seq);
        this.transition("LAST_ACK");
        this.send({ fin: true, ack: true }, seq, this.rcvNxtValue ?? 0);
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
        // Half-closed: the application has not called close() yet.
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
    this.sndNxtValue = nextSequence(this.issValue);
    this.transition("SYN_RECEIVED");
    this.send({ syn: true, ack: true }, this.issValue, this.rcvNxtValue);
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
      this.send({ ack: true }, this.sndNxtValue, this.rcvNxtValue);
      return;
    }
    // Both ends opened at once: answer the peer's SYN with our SYN+ACK.
    this.transition("SYN_RECEIVED");
    this.send({ syn: true, ack: true }, this.issValue ?? 0, this.rcvNxtValue);
  }

  /** SYN_RECEIVED: the ACK of our SYN+ACK (or of our SYN) opens both ends. */
  private receiveInSynReceived(segment: TcpSegment): void {
    if (!segment.flags.ack || segment.ack !== this.sndNxtValue) {
      return;
    }
    this.transition("ESTABLISHED");
  }

  /** ESTABLISHED: only a FIN changes the state in hito 5.1 (no buffers yet). */
  private receiveInEstablished(segment: TcpSegment): void {
    if (!segment.flags.fin) {
      return;
    }
    this.rcvNxtValue = nextSequence(segment.seq);
    this.transition("CLOSE_WAIT");
    this.send({ ack: true }, this.sndNxtValue ?? 0, this.rcvNxtValue);
  }

  /** FIN_WAIT_1: the ACK of our FIN moves to FIN_WAIT_2, a FIN to TIME_WAIT. */
  private receiveInFinWait1(segment: TcpSegment): void {
    const finAcked = segment.flags.ack && segment.ack === this.sndNxtValue;
    if (segment.flags.fin) {
      this.rcvNxtValue = nextSequence(segment.seq);
      this.send({ ack: true }, this.sndNxtValue ?? 0, this.rcvNxtValue);
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
    if (!segment.flags.fin) {
      return;
    }
    this.rcvNxtValue = nextSequence(segment.seq);
    this.send({ ack: true }, this.sndNxtValue ?? 0, this.rcvNxtValue);
    this.enterTimeWait();
  }

  /** CLOSING: the last ACK sends us into TIME_WAIT. */
  private receiveInClosing(segment: TcpSegment): void {
    if (!segment.flags.ack || segment.ack !== this.sndNxtValue) {
      return;
    }
    this.enterTimeWait();
  }

  /** LAST_ACK: the ACK of our FIN retires the TCB. */
  private receiveInLastAck(segment: TcpSegment): void {
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
    this.send({ ack: true }, this.sndNxtValue ?? 0, nextSequence(segment.seq));
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

  /** Send one control segment of this connection. */
  private send(flags: Partial<TcpFlags>, seq: number, ack: number): void {
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
        payload: NO_PAYLOAD,
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
    this.sndNxtValue = undefined;
    this.rcvNxtValue = undefined;
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
