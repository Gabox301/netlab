<script lang="ts">
import { onMount } from "svelte";
import { resolve } from "$app/paths";
import { workbenchStatus } from "../lib/a11y";
import {
  buildHexLines,
  buildPackets,
  type FrameProtocol,
  type HexToken,
  type LayerField,
  type LayerId,
  type PacketDir,
  type PacketRow,
} from "../lib/decode";
import {
  compileFilter,
  FLOW_BOTTOM,
  FLOW_HEIGHT,
  FLOW_TOP,
  FLOW_WIDTH,
  type FlowArrow,
  flowArrows,
  flowLanes,
} from "../lib/filter";
import { buildFlights, type Flight } from "../lib/flights";
import {
  HELP_MESSAGES,
  hasInlineGuide,
  VALIDATION_FLOW,
  WORKBENCH_HELP_SHORTCUTS,
  WORKBENCH_LEGEND,
} from "../lib/help";
import type {
  ExecResponse,
  InterfaceSnapshot,
  SimResult,
  WireTrace,
  WorkerRequest,
  WorkerResponse,
} from "../lib/sim-protocol";
import {
  nextTutorialStep,
  parseTutorialState,
  previousTutorialStep,
  readTutorialValue,
  saveTutorialStatus,
  shouldShowTutorial,
  TUTORIAL_ANCHOR_ATTR,
  TUTORIAL_MESSAGES,
  TUTORIAL_STEPS,
  type TutorialAnchor,
  tutorialNextLabel,
  tutorialProgressLabel,
  tutorialStepAt,
} from "../lib/tutorial";

type TabId = "inspector" | "terminal" | "tablas";

const TAB_ORDER: TabId[] = ["inspector", "terminal", "tablas"];
const TAB_LABEL: Record<TabId, string> = {
  inspector: "Inspector",
  terminal: "Terminal h1",
  tablas: "Tablas",
};
const DIR_LABEL: Record<PacketDir, string> = {
  tx: "tx →",
  rx: "← rx",
  drop: "drop ✕",
};
const LINK_MIDPOINTS: Record<string, { x: number; y: number }> = {
  "l-h1-r1": { x: 113, y: 110 },
  "l-r1-h2": { x: 187, y: 110 },
};
const LINK_ENDPOINTS: Record<
  string,
  { ax: number; ay: number; bx: number; by: number }
> = {
  "l-h1-r1": { ax: 76, ay: 96, bx: 150, by: 124 },
  "l-r1-h2": { ax: 150, ay: 124, bx: 224, by: 96 },
};
/** Piso visual para que un vuelo de 10 µs se vea; el tiempo virtual no cambia. */
const FLIGHT_FLOOR_US = 800;
/** Cuánto tarda el horizonte completo a 1× con el reloj continuo. */
const PLAY_HORIZON_MS = 12_000;
/** Ventana del flow graph: los vuelos más recientes respecto del scrubber. */
const FLOW_WINDOW_US = 2_500;
const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";
/** Host the terminal tab drives; this slice keeps it fixed. */
const TERM_HOST = "h1";
/** Command the run transcript comes from, echoed as prior history. */
const INITIAL_COMMAND = "traceroute 10.0.1.2";
/** Numbered traceroute hops, highlighted like a live trace. */
const HOP_LINE = /^\d+ {2}/;

/** One row of the terminal history: typed command, output or error. */
interface TermEntry {
  kind: "cmd" | "out" | "err";
  text: string;
}

let result = $state<SimResult | null>(null);
let error = $state<string | null>(null);
let loading = $state(true);
let autoPlayOnResult = true;
let selectedTraceIndex = $state(-1);
let scrubUs = $state(0);
let paused = $state(true);
const SPEEDS: ReadonlyArray<number> = [0.5, 1, 2, 4];
let speedIdx = $state(1);

/* Fase 8 T3: overlay de bienvenida anclado al golden path del workbench. */
let tutorialOpen = $state(false);
let tutorialStep = $state(0);
let tutorialCard = $state<HTMLDivElement | null>(null);
let tutorialHelp = $state<HTMLButtonElement | null>(null);
let tutorialReturnFocus: HTMLElement | null = null;
let tutorialSpot = $state<{
  top: number;
  left: number;
  width: number;
  height: number;
} | null>(null);
let tutorialCardPos = $state<{ top: number; left: number } | null>(null);

function clockRate(): number {
  return (horizonUs / PLAY_HORIZON_MS) * (SPEEDS[speedIdx] ?? 1);
}

function startClock(fromUs: number): void {
  stopTimer();
  paused = false;
  playStartVirtual = fromUs;
  playStartWall = performance.now();
  raf = requestAnimationFrame(tick);
}

function tick(now: number): void {
  if (paused) {
    return;
  }
  const elapsed = now - playStartWall;
  scrubUs = Math.min(playStartVirtual + elapsed * clockRate(), horizonUs);
  syncSelectionToClock();
  if (scrubUs >= horizonUs) {
    stopTimer();
    paused = true;
    return;
  }
  raf = requestAnimationFrame(tick);
}

function syncSelectionToClock(): void {
  let chosen: PacketRow | null = null;
  for (const packet of packets) {
    if (packet.t <= scrubUs) {
      chosen = packet;
    }
  }
  if ((chosen?.traceIndex ?? -1) !== selectedTraceIndex) {
    setSelectedTrace(chosen?.traceIndex ?? -1);
  }
}
let tab = $state<TabId>("inspector");
let showArp = $state(true);
let showIcmp = $state(true);
let showUdp = $state(true);
let showDns = $state(true);
let showDhcp = $state(true);
let showOtro = $state(true);
/** F-93 expression typed in the filter box; chips still AND with it. */
let filterText = $state("");
let hoverLayer = $state<LayerId | null>(null);
let selectedField = $state<{ layer: LayerId; row: number } | null>(null);
let collapsed = $state<Record<string, boolean>>({});
/** Traces produced by terminal commands, appended to the run's list. */
let sessionTraces = $state<WireTrace[]>([]);
/** Right edge of the timeline; grows when a command passes the run horizon. */
let horizonUs = $state(10_000);
let termLines = $state<TermEntry[]>([]);
let termInput = $state("");
let termBusy = $state(false);
let termScroll = $state<HTMLDivElement | null>(null);
let termField = $state<HTMLInputElement | null>(null);
/** Submitted commands, oldest first; `termCursor` -1 means "draft". */
let termHistory: string[] = [];
let termCursor = -1;

let worker: Worker | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let raf: number | null = null;
let playStartWall = 0;
let playStartVirtual = 0;

/** Run traces plus everything the terminal produced, in arrival order. */
const allTraces = $derived([...(result?.traces ?? []), ...sessionTraces]);
const traceTotal = $derived(allTraces.length);
const packets = $derived(buildPackets(allTraces));
const filter = $derived(compileFilter(filterText));
const visiblePackets = $derived(
  packets.filter(
    (packet) =>
      protocolVisible(packet.decoded.protocol) &&
      (!filter.ok || filter.pred(packet)),
  ),
);
const selectedPacket = $derived(
  packets.find((packet) => packet.traceIndex === selectedTraceIndex) ?? null,
);
const selectedNumber = $derived(
  packets.findIndex((packet) => packet.traceIndex === selectedTraceIndex) + 1,
);
const deviceByMac = $derived(
  new Map((result?.interfaces ?? []).map((iface) => [iface.mac, iface.device])),
);
const deviceRows = $derived.by(() => {
  const groups = new Map<string, InterfaceSnapshot[]>();
  for (const iface of result?.interfaces ?? []) {
    const list = groups.get(iface.device) ?? [];
    list.push(iface);
    groups.set(iface.device, list);
  }
  return [...groups.entries()].map(([device, ifaces]) => ({
    device,
    ifaces,
  }));
});
const activeTrace = $derived(
  selectedTraceIndex >= 0 ? (allTraces[selectedTraceIndex] ?? null) : null,
);
const activeLink = $derived(
  activeTrace?.kind === "frame_tx" ? activeTrace.link : null,
);
const fromDevice = $derived(
  selectedPacket
    ? (deviceByMac.get(selectedPacket.decoded.srcMac) ?? null)
    : null,
);
const toDevice = $derived(
  selectedPacket
    ? (deviceByMac.get(selectedPacket.decoded.dstMac) ?? null)
    : null,
);
const flights = $derived(buildFlights(allTraces));
const visibleFlights = $derived(
  flights.filter((flight) => protocolVisible(flight.protocol)),
);
const inFlights = $derived(
  visibleFlights.filter((flight) => {
    const end = Math.max(flight.endUs, flight.startUs + FLIGHT_FLOOR_US);
    return scrubUs >= flight.startUs && scrubUs <= end;
  }),
);
/** Carriles del flow graph, en el orden de `deviceRows` (h1, r1, h2). */
const flowLaneRows = $derived(flowLanes(deviceRows.map((row) => row.device)));
/** Vuelos de la ventana actual mapeados a flechas del diagrama de secuencia. */
const flowArrowRows = $derived(
  flowArrows(visibleFlights, flowLaneRows, {
    fromUs: Math.max(0, scrubUs - FLOW_WINDOW_US),
    toUs: scrubUs,
  }),
);

function flightEndUs(flight: Flight): number {
  return Math.max(flight.endUs, flight.startUs + FLIGHT_FLOOR_US);
}

function flightProgress(flight: Flight): number {
  const end = flightEndUs(flight);
  if (end <= flight.startUs) {
    return 1;
  }
  const progress = (scrubUs - flight.startUs) / (end - flight.startUs);
  return Math.min(Math.max(progress, 0), 1);
}

function flightPos(flight: Flight): { x: number; y: number } {
  const seg = LINK_ENDPOINTS[flight.linkId];
  if (!seg) {
    return LINK_MIDPOINTS[flight.linkId] ?? { x: 0, y: 0 };
  }
  const progress = flightProgress(flight);
  const ax = flight.from === "a" ? seg.ax : seg.bx;
  const ay = flight.from === "a" ? seg.ay : seg.by;
  const bx = flight.from === "a" ? seg.bx : seg.ax;
  const by = flight.from === "a" ? seg.by : seg.ay;
  return { x: ax + (bx - ax) * progress, y: ay + (by - ay) * progress };
}

function flightClass(flight: Pick<Flight, "outcome" | "protocol">): string {
  if (flight.outcome === "dropped") {
    return "flt-dropped";
  }
  switch (flight.protocol) {
    case "ARP":
      return "flt-arp";
    case "ICMP":
      return "flt-icmp";
    case "UDP":
      return "flt-udp";
    case "DNS":
      return "flt-dns";
    case "DHCP":
      return "flt-dhcp";
    default:
      return "flt-otro";
  }
}

/** Triangles at the destination end of a flow arrow, pointing along x. */
function arrowHead(arrow: FlowArrow): string {
  const dir = arrow.x2 >= arrow.x1 ? 1 : -1;
  const back = arrow.x2 - dir * 6;
  return `${arrow.x2},${arrow.y} ${back},${arrow.y - 3} ${back},${arrow.y + 3}`;
}

/** Chip filter: every protocol has its own toggle (T7 adds expressions). */
function protocolVisible(protocol: FrameProtocol): boolean {
  switch (protocol) {
    case "ARP":
      return showArp;
    case "ICMP":
      return showIcmp;
    case "UDP":
      return showUdp;
    case "DNS":
      return showDns;
    case "DHCP":
      return showDhcp;
    default:
      return showOtro;
  }
}
const hexLines = $derived(
  selectedPacket
    ? buildHexLines(selectedPacket.decoded.hex, selectedPacket.decoded.layers)
    : [],
);
/** Field behind the current selection; null when nothing (or a stale row) is picked. */
const selectedLayerField = $derived.by((): LayerField | null => {
  const packet = selectedPacket;
  const picked = selectedField;
  if (packet === null || picked === null) {
    return null;
  }
  const layer = packet.decoded.layers.find(
    (candidate) => candidate.id === picked.layer,
  );
  return layer?.rows[picked.row] ?? null;
});
const horizon = $derived(horizonUs);

onMount(() => {
  startWorker();
  // Primera visita: el overlay se abre solo y deja "visto" guardado para
  // que un refresh no lo repita. Ayuda siempre puede reabrirlo.
  if (shouldShowTutorial(readTutorialValue())) {
    tutorialOpen = true;
    saveTutorialStatus("seen");
  }
  return () => {
    stopTimer();
    worker?.terminate();
    worker = null;
  };
});

function startWorker(): void {
  try {
    worker = new Worker(new URL("../lib/sim.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      handleMessage(event.data);
    };
    worker.onerror = (event) => {
      handleWorkerError(event.message || "error en el worker");
    };
    requestRun(false);
  } catch (cause) {
    handleWorkerError(cause instanceof Error ? cause.message : String(cause));
  }
}

function requestRun(play: boolean): void {
  if (worker === null) {
    handleWorkerError("worker no disponible");
    return;
  }
  autoPlayOnResult = play;
  loading = true;
  error = null;
  stopTimer();
  paused = true;
  const request: WorkerRequest = { type: "run" };
  worker.postMessage(request);
}

function handleMessage(message: WorkerResponse): void {
  if (message.kind === "exec") {
    handleExecResult(message);
    return;
  }
  if (message.kind === "validate") {
    // The practice page owns validation answers; this tab never asks for one.
    return;
  }
  if (message.kind === "error") {
    handleWorkerError(message.message);
    return;
  }
  const run = message.result;
  const next = buildPackets(run.traces);
  result = run;
  // A new run is a new interactive session: the worker rebuilt its lab, so
  // the traces and the transcript on screen start over with it.
  sessionTraces = [];
  horizonUs = run.horizonUs;
  loading = false;
  error = null;
  resetTerminal(run.transcript);
  const firstIcmp = next.findIndex(
    (packet) => packet.decoded.protocol === "ICMP",
  );
  const initial = next[Math.max(firstIcmp, 0)] ?? null;
  setSelectedTrace(initial?.traceIndex ?? -1);
  scrubUs = initial?.t ?? 0;
  if (autoPlayOnResult && next.length > 0) {
    playFromList(next, 0);
  } else {
    stopTimer();
    paused = true;
  }
}

/** One shell answer: history, new frames and the advanced virtual clock. */
function handleExecResult(message: ExecResponse): void {
  termBusy = false;
  const entries: TermEntry[] = message.lines.map((text) => ({
    kind: "out",
    text,
  }));
  if (message.error !== null) {
    entries.push({ kind: "err", text: message.error });
  }
  appendTerm(entries);
  if (message.traces.length > 0) {
    // Same wire format as the run, so the packet list and the inspector reuse
    // their existing decoding; only the arrival index changes.
    sessionTraces = [...sessionTraces, ...message.traces];
  }
  // Commands can pass the capture horizon (ping waits ~1 s, traceroute up to
  // 30 s): widen the scrubber and move the clock forward, never rewind it.
  if (message.simTimeUs > horizonUs) {
    horizonUs = message.simTimeUs;
  }
  if (message.simTimeUs > scrubUs) {
    scrubUs = message.simTimeUs;
  }
}

function handleWorkerError(message: string): void {
  error = message;
  loading = false;
  termBusy = false;
  stopTimer();
  paused = true;
}

/** Seed the history with the transcript the run already produced. */
function resetTerminal(transcript: string[]): void {
  termLines = [
    { kind: "cmd", text: INITIAL_COMMAND },
    ...transcript.map((text) => ({ kind: "out" as const, text })),
  ];
  termHistory = [];
  termCursor = -1;
  termInput = "";
  termBusy = false;
}

function appendTerm(entries: TermEntry[]): void {
  if (entries.length === 0) {
    return;
  }
  termLines = [...termLines, ...entries];
}

/**
 * Enter on the terminal input: local echo, `clear`, then the `exec` request.
 * The prompt is part of the row markup, so the echoed text is the command.
 */
function submitTerm(event: SubmitEvent): void {
  event.preventDefault();
  if (termBusy) {
    return;
  }
  const cmd = termInput.trim();
  if (cmd === "") {
    return;
  }
  termInput = "";
  termCursor = -1;
  if (cmd === "clear") {
    // UI-only command: it wipes the local history and never reaches the
    // shell, so it cannot advance the virtual clock.
    termLines = [];
    return;
  }
  if (worker === null) {
    appendTerm([{ kind: "err", text: "worker no disponible" }]);
    return;
  }
  termHistory = [...termHistory, cmd];
  appendTerm([{ kind: "cmd", text: cmd }]);
  termBusy = true;
  const request: WorkerRequest = { type: "exec", host: TERM_HOST, cmd };
  worker.postMessage(request);
}

/** Walk the submitted commands; leaving the newest restores the draft. */
function recallTerm(direction: "older" | "newer"): void {
  const last = termHistory.length - 1;
  if (last < 0) {
    return;
  }
  if (direction === "older") {
    termCursor = termCursor < 0 ? last : Math.max(termCursor - 1, 0);
    termInput = termHistory[termCursor] ?? "";
    return;
  }
  if (termCursor < 0) {
    return;
  }
  const next = termCursor + 1;
  if (next > last) {
    termCursor = -1;
    termInput = "";
    return;
  }
  termCursor = next;
  termInput = termHistory[next] ?? "";
}

function onTermKey(event: KeyboardEvent): void {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
    return;
  }
  if (termBusy) {
    return;
  }
  event.preventDefault();
  recallTerm(event.key === "ArrowUp" ? "older" : "newer");
}

$effect(() => {
  const node = termScroll;
  const lines = termLines;
  if (node === null) {
    return;
  }
  // Reading `lines` re-runs the effect on every new history array.
  node.scrollTop = lines.length > 0 ? node.scrollHeight : 0;
});

$effect(() => {
  // Disabling the input to wait for an answer blurs it: re-pin the focus so
  // the next command can be typed without clicking again.
  if (!termBusy) {
    termField?.focus();
  }
});

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (raf !== null) {
    cancelAnimationFrame(raf);
    raf = null;
  }
}

function selectPacket(packet: PacketRow): void {
  setSelectedTrace(packet.traceIndex);
  scrubUs = packet.t;
}

function setSelectedTrace(traceIndex: number): void {
  if (traceIndex !== selectedTraceIndex) {
    // Offsets belong to one frame: a new frame invalidates the selection.
    selectedField = null;
  }
  selectedTraceIndex = traceIndex;
}

function selectRow(packet: PacketRow): void {
  stopTimer();
  paused = true;
  selectPacket(packet);
}

function playFromList(list: PacketRow[], index: number): void {
  const target = list[index];
  if (target === undefined) {
    return;
  }
  setSelectedTrace(target.traceIndex);
  scrubUs = target.t;
  startClock(target.t);
}

function advance(): void {
  step(1);
}

function togglePause(): void {
  if (result === null) {
    return;
  }
  if (!paused) {
    stopTimer();
    paused = true;
    return;
  }
  if (packets.length === 0) {
    return;
  }
  if (scrubUs >= horizonUs) {
    const first = packets[0];
    if (first !== undefined) {
      setSelectedTrace(first.traceIndex);
    }
    startClock(0);
    return;
  }
  startClock(scrubUs);
}

function step(dir: 1 | -1): void {
  if (result === null) {
    return;
  }
  stopTimer();
  paused = true;
  const list = packets;
  if (list.length === 0) {
    return;
  }
  const index = list.findIndex(
    (packet) => packet.traceIndex === selectedTraceIndex,
  );
  const at = index < 0 ? (dir > 0 ? 0 : list.length - 1) : index + dir;
  const next = list[Math.min(Math.max(at, 0), list.length - 1)];
  if (next !== undefined) {
    selectPacket(next);
  }
}

function restart(): void {
  const first = packets[0];
  if (result === null || first === undefined) {
    return;
  }
  stopTimer();
  paused = true;
  selectPacket(first);
}

function onSpeedChange(event: Event): void {
  speedIdx = Number((event.currentTarget as HTMLSelectElement).value);
  if (paused || result === null) {
    return;
  }
  startClock(scrubUs);
}

function onReplayKey(event: KeyboardEvent): void {
  if (tutorialOpen) {
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement
  ) {
    return;
  }
  if (event.key === " ") {
    event.preventDefault();
    togglePause();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    step(1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    step(-1);
  }
}

/* Tutorial de bienvenida (Fase 8 T3) -------------------------------------- */

function openTutorial(trigger: HTMLElement | null = null): void {
  tutorialReturnFocus = trigger ?? tutorialHelp;
  tutorialStep = 0;
  tutorialOpen = true;
}

function closeTutorial(completed: boolean): void {
  // Completar es terminal: reabrir y omitir no degrada el estado guardado.
  const previous = parseTutorialState(readTutorialValue())?.status;
  saveTutorialStatus(
    completed || previous === "completed" ? "completed" : "seen",
  );
  tutorialOpen = false;
  tutorialSpot = null;
  tutorialCardPos = null;
  const back = tutorialReturnFocus ?? tutorialHelp;
  tutorialReturnFocus = null;
  back?.focus();
}

function advanceTutorial(): void {
  if (tutorialStep >= TUTORIAL_STEPS.length - 1) {
    closeTutorial(true);
    return;
  }
  tutorialStep = nextTutorialStep(tutorialStep);
}

/** Vuelve un paso; en el primero, el foco no queda en un botón deshabilitado. */
function retreatTutorial(): void {
  tutorialStep = previousTutorialStep(tutorialStep);
  if (tutorialStep === 0) {
    tutorialCard?.focus();
  }
}

/** Tab queda atrapado en el diálogo y Escape lo cierra como Omitir. */
function onTutorialKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeTutorial(false);
    return;
  }
  if (event.key !== "Tab" || tutorialCard === null) {
    return;
  }
  const focusable = [
    ...tutorialCard.querySelectorAll<HTMLElement>("button:not(:disabled)"),
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) {
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === tutorialCard)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Posiciona el spotlight y la tarjeta sobre el anclaje del paso. La tarjeta
 * va debajo del objetivo si entra y arriba si no; el viewport siempre manda.
 */
function placeTutorial(anchor: TutorialAnchor): void {
  const card = tutorialCard;
  if (card === null) {
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 12;
  const width = card.offsetWidth || 340;
  const height = card.offsetHeight || 220;
  const target = document.querySelector<HTMLElement>(
    `[${TUTORIAL_ANCHOR_ATTR}="${anchor}"]`,
  );
  if (target === null) {
    tutorialSpot = null;
    tutorialCardPos = {
      top: Math.max(margin, (vh - height) / 2),
      left: Math.max(margin, (vw - width) / 2),
    };
    return;
  }
  const rect = target.getBoundingClientRect();
  const spotTop = Math.max(0, rect.top - 6);
  const spotLeft = Math.max(0, rect.left - 6);
  tutorialSpot = {
    top: spotTop,
    left: spotLeft,
    width: Math.max(0, Math.min(vw - spotLeft, rect.width + 12)),
    height: Math.max(0, Math.min(vh - spotTop, rect.height + 12)),
  };
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - width / 2, margin),
    Math.max(margin, vw - width - margin),
  );
  const below = rect.bottom + margin;
  const top =
    below + height <= vh - margin
      ? below
      : Math.max(
          margin,
          Math.min(rect.top - height - margin, vh - height - margin),
        );
  tutorialCardPos = { top, left };
}

/** Al abrir, el foco entra al diálogo (role="dialog" aria-modal). */
$effect(() => {
  if (tutorialOpen && tutorialCard !== null) {
    tutorialCard.focus();
  }
});

/** Reposiciona al cambiar de paso y cuando la página scrollea o cambia. */
$effect(() => {
  if (!tutorialOpen || tutorialCard === null) {
    return;
  }
  const anchor = tutorialStepAt(tutorialStep).anchor;
  const place = () => placeTutorial(anchor);
  place();
  window.addEventListener("resize", place);
  document.addEventListener("scroll", place, true);
  return () => {
    window.removeEventListener("resize", place);
    document.removeEventListener("scroll", place, true);
  };
});

function scrubTo(value: number): void {
  stopTimer();
  paused = true;
  scrubUs = value;
  let chosen: PacketRow | null = null;
  for (const packet of packets) {
    if (packet.t <= value) {
      chosen = packet;
    }
  }
  setSelectedTrace(chosen?.traceIndex ?? -1);
}

function toggleLayer(id: string): void {
  collapsed[id] = !collapsed[id];
}

function isFieldSelected(layer: LayerId, row: number): boolean {
  return selectedField?.layer === layer && selectedField.row === row;
}

/** Click a field row: first click selects its bytes, second click clears. */
function selectField(layer: LayerId, row: number): void {
  selectedField = isFieldSelected(layer, row) ? null : { layer, row };
}

/**
 * Class of one hex byte: the picked field wins over the hovered layer,
 * `lit` keeps the existing hover behaviour for whole layers.
 */
function byteClass(token: HexToken): string {
  const picked = selectedLayerField;
  if (
    picked !== null &&
    token.byte >= picked.start &&
    token.byte < picked.end
  ) {
    return "sel";
  }
  return hoverLayer === token.layer ? "lit" : "";
}

/** Inspect-first lookup: the byte → field direction of the highlight. */
function fieldAtByte(byte: number): { layer: LayerId; row: number } | null {
  const packet = selectedPacket;
  if (packet === null) {
    return null;
  }
  for (const layer of packet.decoded.layers) {
    const row = layer.rows.findIndex(
      (candidate) => byte >= candidate.start && byte < candidate.end,
    );
    if (row >= 0) {
      return { layer: layer.id, row };
    }
  }
  return null;
}

/** Click a hex byte: select the field that owns it, or clear on pad bytes. */
function pickByte(byte: number): void {
  const found = fieldAtByte(byte);
  if (found === null) {
    selectedField = null;
    return;
  }
  if (isFieldSelected(found.layer, found.row)) {
    selectedField = null;
    return;
  }
  collapsed[found.layer] = false;
  selectedField = found;
}

function onByteKey(event: KeyboardEvent, byte: number): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  pickByte(byte);
}

function onTabKey(event: KeyboardEvent, id: TabId): void {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
    return;
  }
  event.preventDefault();
  const index = TAB_ORDER.indexOf(id);
  const delta = event.key === "ArrowRight" ? 1 : TAB_ORDER.length - 1;
  const next = TAB_ORDER[(index + delta) % TAB_ORDER.length];
  if (next === undefined) {
    return;
  }
  tab = next;
  document.getElementById(`tab-${next}`)?.focus();
}

function onRowKey(event: KeyboardEvent, packet: PacketRow): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectRow(packet);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  const list = visiblePackets;
  const index = list.findIndex(
    (candidate) => candidate.traceIndex === packet.traceIndex,
  );
  const next = list[index + (event.key === "ArrowDown" ? 1 : -1)];
  if (next === undefined) {
    return;
  }
  selectRow(next);
  document
    .querySelector<HTMLElement>(`tr[data-trace="${next.traceIndex}"]`)
    ?.focus();
}

function fromLabel(packet: PacketRow): string {
  return (
    deviceByMac.get(packet.decoded.srcMac) ??
    packet.decoded.srcIp ??
    packet.decoded.srcMac
  );
}

function toLabel(packet: PacketRow): string {
  const device = deviceByMac.get(packet.decoded.dstMac);
  if (device !== undefined) {
    return device;
  }
  if (packet.decoded.dstMac === BROADCAST_MAC) {
    return "ff:ff:…";
  }
  return packet.decoded.dstIp ?? packet.decoded.dstMac;
}

function badgeClass(packet: PacketRow): string {
  if (packet.decoded.protocol === "ARP") {
    return "b-arp";
  }
  if (packet.decoded.isError) {
    return "b-err";
  }
  switch (packet.decoded.protocol) {
    case "UDP":
      return "b-udp";
    case "DNS":
      return "b-dns";
    case "DHCP":
      return "b-dhcp";
    default:
      return "b-echo";
  }
}

function ipLabel(iface: InterfaceSnapshot): string {
  if (iface.ip === null) {
    return "sin IP";
  }
  return iface.prefixLength === null
    ? iface.ip
    : `${iface.ip}/${iface.prefixLength}`;
}

function ifaceLine(iface: InterfaceSnapshot): string {
  const gateway = iface.gateway === null ? "" : ` · gw ${iface.gateway}`;
  return `${iface.iface} ${ipLabel(iface)}${gateway}`;
}

function isNodeActive(id: string): boolean {
  return fromDevice === id || toDevice === id;
}
</script>

<svelte:head>
  <title>NetLab — Workbench · Rojo señal</title>
  <meta
    name="description"
    content="Workbench NetLab: topología de dos subredes, tramas reales y replay determinista."
  />
</svelte:head>

<svelte:window onkeydown={onReplayKey} />

<div class="shell">
  <a class="skip" href="#filter-expr">Saltar a la lista de paquetes</a>
  <div class="sr-only" role="status" aria-live="polite"
    >{workbenchStatus({
      loading,
      errored: error !== null,
      total: packets.length,
      selectedT: selectedPacket?.t ?? null,
    })}</div>
  <header class="top">
    <div class="logo">Net<b>Lab</b></div>
    <div class="scen mono">
      {result?.scenario ?? "dos-subredes"}.json · seed {result?.seed ?? 11}
    </div>
    <a class="navlink" href={resolve("/editor")}>Editor →</a>
    <a class="navlink" href={resolve("/practica")}>Práctica →</a>
    <button
      class="navlink"
      type="button"
      bind:this={tutorialHelp}
      onclick={(event) => openTutorial(event.currentTarget)}
      title={TUTORIAL_MESSAGES.helpTitle}
    >
      <span aria-hidden="true">?</span> {TUTORIAL_MESSAGES.help}
    </button>
    <div class="sp"></div>
    <div class="simtime mono" role="timer" aria-label="Tiempo virtual">
      t = {scrubUs} µs
    </div>
    <button
      class="primary"
      type="button"
      onclick={() => requestRun(true)}
      disabled={loading}
      data-tutorial="run"
    >
      ▶ Run
    </button>
    <button
      type="button"
      aria-pressed={paused}
      onclick={togglePause}
      disabled={result === null}
    >
      ⏸ Pause
    </button>
    <button type="button" onclick={() => step(-1)} disabled={result === null} title="Paquete anterior (←)">
      ⏮ Prev
    </button>
    <button type="button" onclick={() => step(1)} disabled={result === null} title="Paquete siguiente (→)">
      ⏭ Next
    </button>
    <button type="button" onclick={restart} disabled={result === null} title="Volver al primer paquete">
      ⟲ Start
    </button>
    <label class="speed" title="Velocidad de reproducción">
      <span>vel</span>
      <select
        value={String(speedIdx)}
        onchange={onSpeedChange}
        aria-label="Velocidad de reproducción"
      >
        {#each SPEEDS as speed, i (speed)}
          <option value={String(i)}>{speed}×</option>
        {/each}
      </select>
    </label>
  </header>

  {#if hasInlineGuide("workbench")}
    <details class="guide">
      <summary>
        <span>{HELP_MESSAGES.guideTitle}</span>
        <span class="guide-note">{HELP_MESSAGES.guideSummary}</span>
      </summary>
      <div class="guide-grid">
        <div class="guide-block">
          <h2>{HELP_MESSAGES.flowTitle}</h2>
          <ol class="guide-flow">
            {#each VALIDATION_FLOW as item (item.id)}
              <li>
                <b>{item.title}</b>
                <span>{item.line}</span>
              </li>
            {/each}
          </ol>
        </div>
        <div class="guide-block">
          <h2>{HELP_MESSAGES.keysTitle}</h2>
          {#each WORKBENCH_HELP_SHORTCUTS as group (group.title)}
            <ul class="guide-keys">
              {#each group.shortcuts as shortcut (shortcut.keys)}
                <li><kbd>{shortcut.keys}</kbd><span>{shortcut.what}</span></li>
              {/each}
            </ul>
          {/each}
        </div>
        <div class="guide-block">
          <h2>{HELP_MESSAGES.legendTitle}</h2>
          <ul class="guide-legend">
            {#each WORKBENCH_LEGEND as item (item.id)}
              <li>
                <span class="swatch {item.id}" aria-hidden="true"></span>
                <b class="mono">{item.label}</b>
                <span>{item.what}</span>
              </li>
            {/each}
          </ul>
        </div>
      </div>
    </details>
  {/if}

  <main class="workbench">
    <section class="col topo-col" aria-label="Topología">
      <h2>Topología</h2>
      <div class="pad">
        <svg
          class="topo"
          viewBox="0 0 300 260"
          role="img"
          aria-label="Dos subredes unidas por el router r1: h1 en 10.0.0.0/24 y h2 en 10.0.1.0/24"
        >
          <rect class="band" x="8" y="18" width="136" height="232"></rect>
          <rect
            class="band band-l2"
            x="156"
            y="18"
            width="136"
            height="128"
          ></rect>
          <text class="bandlbl" x="16" y="38">10.0.0.0/24</text>
          <text class="bandlbl" x="164" y="38">10.0.1.0/24</text>

          <line
            class="link"
            class:on={activeLink === "l-h1-r1"}
            x1="76"
            y1="96"
            x2="150"
            y2="124"
          ></line>
          <line
            class="link"
            class:on={activeLink === "l-r1-h2"}
            x1="150"
            y1="124"
            x2="224"
            y2="96"
          ></line>

          <g class="node-g" class:on={isNodeActive("h1")}>
            <rect class="node" x="44" y="44" width="64" height="52"></rect>
            <text class="nl" x="76" y="66" text-anchor="middle">h1</text>
            <text class="ns" x="76" y="82" text-anchor="middle">10.0.0.2</text>
          </g>
          <g class="node-g" class:on={isNodeActive("r1")}>
            <rect class="node" x="118" y="124" width="64" height="52"></rect>
            <text class="nl" x="150" y="146" text-anchor="middle">r1</text>
            <text class="ns" x="150" y="162" text-anchor="middle">router</text>
          </g>
          <g class="node-g" class:on={isNodeActive("h2")}>
            <rect class="node" x="192" y="44" width="64" height="52"></rect>
            <text class="nl" x="224" y="66" text-anchor="middle">h2</text>
            <text class="ns" x="224" y="82" text-anchor="middle">10.0.1.2</text>
          </g>

          {#each inFlights as flight (flight.linkId + ":" + flight.from + ":" + flight.startUs + ":" + flight.endUs)}
            {@const pos = flightPos(flight)}
            <circle
              class="flt {flightClass(flight)}"
              cx={pos.x}
              cy={pos.y}
              r="5"
            >
              <title>{flight.protocol} {flight.linkId}</title>
            </circle>
          {/each}
        </svg>
      </div>

      <h2>Dispositivos</h2>
      <div class="pad">
        {#if deviceRows.length > 0}
          <table class="devices" aria-label="Dispositivos del escenario">
            <tbody>
              {#each deviceRows as row (row.device)}
                <tr>
                  <td>{row.device}</td>
                  <td>{row.ifaces.map(ifaceLine).join(" · ")}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="hint">Esperando el run del worker…</p>
        {/if}
      </div>

      <h2>Flow graph</h2>
      <div class="pad">
        {#if flowLaneRows.length > 0}
          <svg
            class="flow"
            viewBox={`0 0 ${FLOW_WIDTH} ${FLOW_HEIGHT}`}
            role="img"
            aria-label="Diagrama de secuencia de los vuelos por enlace"
          >
            {#each flowLaneRows as lane (lane.device)}
              <line
                class="flow-lane"
                x1={lane.x}
                y1={FLOW_TOP}
                x2={lane.x}
                y2={FLOW_BOTTOM}
              ></line>
              <text class="flow-label" x={lane.x} y="14" text-anchor="middle">
                {lane.device}
              </text>
            {/each}
            {#each flowArrowRows as arrow (arrow.key)}
              <g class="flow-arrow">
                <title>{arrow.fromDevice} → {arrow.toDevice} · {arrow.protocol} · t={arrow.startUs} µs</title>
                <line
                  class={flightClass(arrow)}
                  x1={arrow.x1}
                  y1={arrow.y}
                  x2={arrow.x2}
                  y2={arrow.y}
                ></line>
                <circle
                  class="flt {flightClass(arrow)}"
                  cx={arrow.x1}
                  cy={arrow.y}
                  r="2"
                ></circle>
                <polygon
                  class="flt {flightClass(arrow)}"
                  points={arrowHead(arrow)}
                ></polygon>
              </g>
            {/each}
          </svg>
          <p class="hint">
            Vuelos de los últimos {FLOW_WINDOW_US / 1000} ms con los chips
            activos · el borde inferior es t = {scrubUs} µs.
          </p>
        {:else}
          <p class="hint">Esperando el run del worker…</p>
        {/if}
      </div>
    </section>

    <section class="col packets-col" aria-label="Paquetes" data-tutorial="packets">
      <h2>
        <span>Paquetes{result ? ` · ${packets.length}` : ""}</span>
        <span class="chips" role="group" aria-label="Filtrar protocolo">
          <button
            type="button"
            aria-pressed={showArp}
            onclick={() => (showArp = !showArp)}
          >
            ARP
          </button>
          <button
            type="button"
            aria-pressed={showIcmp}
            onclick={() => (showIcmp = !showIcmp)}
          >
            ICMP
          </button>
          <button
            type="button"
            aria-pressed={showUdp}
            onclick={() => (showUdp = !showUdp)}
          >
            UDP
          </button>
          <button
            type="button"
            aria-pressed={showDns}
            onclick={() => (showDns = !showDns)}
          >
            DNS
          </button>
          <button
            type="button"
            aria-pressed={showDhcp}
            onclick={() => (showDhcp = !showDhcp)}
          >
            DHCP
          </button>
          <button
            type="button"
            aria-pressed={showOtro}
            onclick={() => (showOtro = !showOtro)}
          >
            OTRO
          </button>
        </span>
      </h2>

      <div class="filter-bar">
        <label class="filter-lbl" for="filter-expr">filtro</label>
        <input
          id="filter-expr"
          class="filter-input"
          type="text"
          bind:value={filterText}
          placeholder="ip.src == 10.0.0.2 && udp.dport == 53"
          aria-invalid={filter.ok ? "false" : "true"}
          aria-describedby={filter.ok ? undefined : "filter-error"}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label="Filtro por expresión"
        />
        {#if filter.ok}
          <p class="filter-hint">
            {filterText.trim() === ""
              ? "chips activos · sin expresión"
              : `${visiblePackets.length} de ${packets.length} frames`}
          </p>
        {:else}
          <p id="filter-error" class="filter-error" role="alert">
            {filter.error.message} · posición {filter.error.position}
          </p>
        {/if}
      </div>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {:else if loading && result === null}
        <p class="empty">Ejecutando dos-subredes en el worker…</p>
      {:else if result !== null && visiblePackets.length === 0}
        <p class="empty">
          Ningún frame coincide con la expresión y los chips activos. Limpiá el
          filtro o quitá chips de protocolo para volver a la lista completa.
        </p>
      {/if}

      <div class="table-wrap">
        <table class="pkts" aria-label="Lista cronológica de frames">
          <thead>
            <tr>
              <th>t (µs)</th>
              <th>dir</th>
              <th>origen</th>
              <th>destino</th>
              <th>proto</th>
              <th>len</th>
              <th>resumen</th>
            </tr>
          </thead>
          <tbody>
            {#each visiblePackets as packet (packet.traceIndex)}
              <tr
                data-trace={packet.traceIndex}
                tabindex="0"
                aria-selected={packet.traceIndex === selectedTraceIndex}
                onclick={() => selectRow(packet)}
                onkeydown={(event) => onRowKey(event, packet)}
              >
                <td>{packet.t}</td>
                <td>
                  <span
                    class="dir"
                    class:tx={packet.dir === "tx"}
                    class:rx={packet.dir === "rx"}
                    class:drop={packet.dir === "drop"}
                  >{DIR_LABEL[packet.dir]}</span>
                </td>
                <td>{fromLabel(packet)}</td>
                <td>{toLabel(packet)}</td>
                <td>
                  <span class="badge {badgeClass(packet)}">
                    {packet.decoded.protocol === "ICMP" && packet.decoded.isError
                      ? "ICMP ✕"
                      : packet.decoded.protocol}
                  </span>
                </td>
                <td>{packet.length}</td>
                <td>
                  {packet.decoded.summary}{#if packet.dropReason}
                    <span class="drop-why">· {packet.dropReason}</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="timeline" data-tutorial="timeline">
        <label for="scrub">
          <span>Línea de tiempo · replay determinista, seed {result?.seed ?? 11}</span>
          <span class="mono">{scrubUs} µs</span>
        </label>
        <input
          id="scrub"
          type="range"
          min="0"
          max={horizon}
          step="10"
          value={scrubUs}
          oninput={(event) => scrubTo(Number(event.currentTarget.value))}
          aria-label="Retroceder al instante"
        />
        <div class="marks" aria-hidden="true">
          {#each packets as packet (packet.traceIndex)}
            <i
              class:cur={packet.traceIndex === selectedTraceIndex}
              style={`left:${(packet.t / horizon) * 100}%`}
            ></i>
          {/each}
        </div>
      </div>
    </section>

    <section class="col detail-col" aria-label="Detalle">
      <div class="tabs" role="tablist" aria-label="Panel de detalle">
        {#each TAB_ORDER as id (id)}
          <button
            id={`tab-${id}`}
            role="tab"
            type="button"
            aria-selected={tab === id}
            tabindex={tab === id ? 0 : -1}
            onclick={() => (tab = id)}
            onkeydown={(event) => onTabKey(event, id)}
          >
            {TAB_LABEL[id]}
          </button>
        {/each}
      </div>

      <div class="pane" role="tabpanel">
        {#if tab === "inspector"}
          {#if selectedPacket}
            {@const decoded = selectedPacket.decoded}
            {#each decoded.layers as layer (layer.id)}
              <div
                class="layer"
                role="group"
                aria-label={layer.title}
                style={`--c: var(--${layer.id})`}
                onmouseenter={() => (hoverLayer = layer.id)}
                onmouseleave={() => (hoverLayer = null)}
              >
                <button
                  type="button"
                  aria-expanded={!collapsed[layer.id]}
                  onclick={() => toggleLayer(layer.id)}
                >
                  <span>{layer.title}</span>
                  <span aria-hidden="true">
                    {collapsed[layer.id] ? "▸" : "▾"}
                  </span>
                </button>
                {#if !collapsed[layer.id]}
                  <div class="fields">
                    {#each layer.rows as row, rowIndex (rowIndex)}
                      <button
                        type="button"
                        class="field"
                        class:sel={isFieldSelected(layer.id, rowIndex)}
                        title="Resaltar bytes"
                        aria-pressed={isFieldSelected(layer.id, rowIndex)}
                        onclick={() => selectField(layer.id, rowIndex)}
                      >
                        <span class="f-label">{row.label}</span>
                        <span class="f-value">{row.value}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}

            <pre class="hex" aria-label="Volcado hexadecimal del frame">{#each hexLines as line, index (index)}<span class="hexline">{#each line as token (token.byte)}<b
                      class={token.layer}
                      class:lit={byteClass(token) === "lit"}
                      class:sel={byteClass(token) === "sel"}
                      role="button"
                      tabindex="0"
                      aria-pressed={byteClass(token) === "sel"}
                      title={`byte ${token.byte}`}
                      onclick={() => pickByte(token.byte)}
                      onkeydown={(event) => onByteKey(event, token.byte)}
                      >{token.text}</b
                    >{" "}{/each}</span>{/each}</pre>
            <p class="hint">
              Pasá el mouse por una capa para marcar sus bytes. Clic en un
              campo (o en un byte) para resaltarlo en ambos sentidos.
            </p>
          {:else}
            <p class="empty">
              Sin frame seleccionado. Corré la simulación o mové el scrubber.
            </p>
          {/if}
        {:else if tab === "terminal"}
          {#if result}
            <div class="terminal-pane">
              <div
                class="terminal"
                role="log"
                aria-label="Historial de la terminal del host h1"
                bind:this={termScroll}
              >
                {#each termLines as entry, index (index)}
                  {#if entry.kind === "cmd"}
                    <span class="prompt">h1$ {entry.text}</span>
                  {:else}
                    <span
                      class="term-line"
                      class:err={entry.kind === "err"}
                      class:hop={entry.kind === "out" && HOP_LINE.test(entry.text)}
                      >{entry.text}</span
                    >
                  {/if}
                {/each}
              </div>
              <form class="term-row" onsubmit={submitTerm}>
                <label class="term-prompt" for="term-input">h1$</label>
                <input
                  id="term-input"
                  class="term-input"
                  type="text"
                  bind:this={termField}
                  bind:value={termInput}
                  onkeydown={onTermKey}
                  disabled={termBusy}
                  placeholder={termBusy ? "esperando respuesta…" : "comando…"}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  aria-label="Comando para h1"
                />
              </form>
            </div>
          {:else}
            <p class="empty">Corré la simulación para ver el transcript.</p>
          {/if}
        {:else if result}
          <h3>Tabla MAC · interfaces</h3>
          <table class="kv" aria-label="Interfaces y MAC del escenario">
            <thead>
              <tr>
                <th>dispositivo</th>
                <th>iface</th>
                <th>MAC</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {#each result.interfaces as iface (iface.device + iface.iface)}
                <tr>
                  <td>{iface.device}</td>
                  <td>{iface.iface}</td>
                  <td>{iface.mac}</td>
                  <td>{ipLabel(iface)}</td>
                </tr>
              {/each}
            </tbody>
          </table>

          <h3>Vecinos ARP</h3>
          {#if result.neighbors.length > 0}
            <table class="kv" aria-label="Vecinos ARP resueltos">
              <thead>
                <tr>
                  <th>dispositivo</th>
                  <th>IP</th>
                  <th>MAC</th>
                  <th>iface</th>
                </tr>
              </thead>
              <tbody>
                {#each result.neighbors as neighbor (neighbor.device + neighbor.ip)}
                  <tr>
                    <td>{neighbor.device}</td>
                    <td>{neighbor.ip}</td>
                    <td>{neighbor.mac}</td>
                    <td>{neighbor.iface}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <p class="hint">Sin entradas resueltas.</p>
          {/if}

          <h3>Rutas · r1</h3>
          <table class="kv" aria-label="Tabla de rutas de r1">
            <thead>
              <tr>
                <th>destino</th>
                <th>iface</th>
                <th>gateway</th>
                <th>tipo</th>
              </tr>
            </thead>
            <tbody>
              {#each result.routes as route (route.destination + route.iface)}
                <tr>
                  <td>{route.destination}</td>
                  <td>{route.iface}</td>
                  <td>{route.gateway ?? "—"}</td>
                  <td>{route.kind}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="empty">
            Corré la simulación para ver la tabla MAC, los vecinos ARP y las
            rutas.
          </p>
        {/if}
      </div>
    </section>
  </main>

  {#if tutorialOpen}
    {@const step = tutorialStepAt(tutorialStep)}
    <div class="tut-layer">
      {#if tutorialSpot}
        <div
          class="tut-spot"
          style={`top:${tutorialSpot.top}px;left:${tutorialSpot.left}px;width:${tutorialSpot.width}px;height:${tutorialSpot.height}px`}
          aria-hidden="true"
        ></div>
      {/if}
      <div
        class="tut-card"
        style={tutorialCardPos === null
          ? undefined
          : `top:${tutorialCardPos.top}px;left:${tutorialCardPos.left}px`}
        role="dialog"
        aria-modal="true"
        aria-label={TUTORIAL_MESSAGES.dialogLabel}
        tabindex="-1"
        bind:this={tutorialCard}
        onkeydown={onTutorialKey}
      >
        <p class="tut-progress mono">{tutorialProgressLabel(tutorialStep)}</p>
        <h2 class="tut-title">{step.title}</h2>
        <p class="tut-line">{step.line}</p>
        <p class="tut-action">
          <span class="tut-dot" aria-hidden="true"></span>
          {step.action}
        </p>
        <div class="tut-actions">
          <button
            type="button"
            disabled={tutorialStep === 0}
            onclick={retreatTutorial}
          >
            {TUTORIAL_MESSAGES.back}
          </button>
          <button class="tut-next" type="button" onclick={advanceTutorial}>
            {tutorialNextLabel(tutorialStep)}
          </button>
          <button
            class="tut-skip"
            type="button"
            onclick={() => closeTutorial(false)}
          >
            {TUTORIAL_MESSAGES.skip}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <footer class="status">
    <span>
      eventos <b>{result?.events ?? "—"}</b> · trazas
      <b>{result ? traceTotal : "—"}</b>
    </span>
    <span>
      seed <b>{result?.seed ?? 11}</b> · replay idéntico
    </span>
    <span>
      seleccionado
      <b>{selectedNumber > 0 ? `#${selectedNumber}` : "—"}</b>
    </span>
    <span>hasta <b>{horizon / 1000} ms</b></span>
    <span>
      worker
      <b>{loading ? "calculando…" : result ? "listo" : "esperando"}</b>
    </span>
  </footer>
</div>

<style>
  :global(:root) {
    --bg: #0b0b0d;
    --panel: #131316;
    --panel2: #1b1b20;
    --line: #34343c;
    --ink: #ffffff;
    --mut: #b4b4be;
    --dim: #9d9da6;
    --acc: #ff4d3d;
    --ok: #4dff9a;
    --warn: #ffd23d;
    --bad: #ff4d3d;
    --sel: #2e1512;
    --code: #050506;
    --l2: #3dc8ff;
    --l3: #ff4d3d;
    --l4: #ffd23d;
    --l7: #c58cff;
    --disp: Impact, "Arial Narrow", "Arial Narrow Bold", sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }

  :global(*) {
    box-sizing: border-box;
  }

  :global(html),
  :global(body) {
    height: 100%;
    margin: 0;
  }

  :global(body) {
    background: var(--bg);
    color: var(--ink);
    font:
      14px -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      Roboto,
      Helvetica,
      Arial,
      sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  :global(button) {
    font: inherit;
    color: var(--ink);
    background: var(--panel2);
    border: 1px solid var(--line);
    border-radius: 0;
    padding: 7px 13px;
    cursor: pointer;
  }

  :global(button:hover:not(:disabled)) {
    border-color: var(--acc);
  }

  :global(button:disabled) {
    opacity: 0.45;
    cursor: not-allowed;
  }

  :global(:focus-visible) {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  .shell {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    min-height: 52px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }

  .logo {
    font: 700 19px var(--disp);
    letter-spacing: 0.4px;
  }

  .logo b {
    color: var(--acc);
  }

  .scen {
    color: var(--mut);
    font-size: 12.5px;
  }

  .sp {
    flex: 1;
  }

  .navlink {
    color: var(--ink);
    text-decoration: none;
    border: 1px solid var(--line);
    background: var(--panel2);
    padding: 7px 13px;
    font-size: 13px;
    white-space: nowrap;
  }

  .navlink:hover {
    border-color: var(--acc);
  }

  /* A2: guía inline del workbench (flujo, atajos de replay y leyenda). */
  .guide {
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    padding: 0 16px 6px;
  }

  .guide summary {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
    padding: 6px 0;
    cursor: pointer;
    color: var(--ink);
    font-size: 12.5px;
  }

  .guide summary:hover {
    color: var(--acc);
  }

  .guide-note {
    color: var(--mut);
    font-size: 11.5px;
  }

  .guide-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px 24px;
    padding: 2px 0 8px;
  }

  .guide-block h2 {
    margin: 0 0 4px;
    color: var(--dim);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .guide-flow,
  .guide-keys,
  .guide-legend {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 3px;
    font-size: 12px;
  }

  .guide-flow li,
  .guide-keys li,
  .guide-legend li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }

  .guide-flow b {
    color: var(--ok);
    font-weight: 600;
  }

  .guide-flow span,
  .guide-keys span,
  .guide-legend span:last-child {
    color: var(--mut);
  }

  .guide-keys li {
    display: grid;
    grid-template-columns: 5rem minmax(0, 1fr);
    gap: 6px;
    align-items: baseline;
  }

  .guide-keys kbd {
    color: var(--ok);
    font: 600 11px var(--mono);
  }

  .guide-legend b {
    flex: none;
    min-width: 6.5rem;
    font-weight: 600;
  }

  .swatch {
    flex: none;
    width: 18px;
    height: 3px;
    margin-top: 5px;
    background: var(--mut);
  }

  .swatch.rx {
    background: var(--ok);
  }

  .swatch.drop,
  .swatch.dropped {
    background: var(--bad);
  }

  .swatch.dropped {
    background: repeating-linear-gradient(
      to right,
      var(--bad) 0 3px,
      transparent 3px 5px
    );
  }

  .simtime {
    color: var(--ok);
    font-size: 12.5px;
    min-width: 118px;
    text-align: right;
  }

  .speed {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--mut);
  }

  .speed select {
    font: 12px var(--mono);
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 6px;
  }

  .primary {
    background: var(--acc);
    border-color: var(--acc);
    color: #ffffff;
    font-weight: 600;
  }

  .mono {
    font-family: var(--mono);
  }

  .workbench {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr) 400px;
  }

  .col {
    border-right: 1px solid var(--line);
    overflow: auto;
    min-width: 0;
  }

  .col:last-child {
    border-right: 0;
  }

  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--mut);
    margin: 0;
    padding: 12px 14px 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--mut);
    margin: 0 0 6px;
    font-weight: 600;
  }

  .pad {
    padding: 6px 14px 14px;
  }

  .topo {
    width: 100%;
    height: auto;
    display: block;
    background: var(--panel);
    border: 1px solid var(--line);
  }

  .band {
    fill: var(--acc);
    opacity: 0.07;
  }

  .band-l2 {
    fill: var(--l2);
    opacity: 0.09;
  }

  .bandlbl {
    fill: var(--dim);
    font: 10px var(--mono);
  }

  .link {
    stroke: var(--dim);
    stroke-width: 2;
    transition: stroke 0.15s;
  }

  .link.on {
    stroke: var(--acc);
    stroke-width: 3;
  }

  .node {
    fill: var(--panel2);
    stroke: var(--line);
    stroke-width: 1.5;
    transition: stroke 0.15s;
  }

  .node-g.on .node {
    stroke: var(--acc);
    stroke-width: 2.5;
  }

  .nl {
    fill: var(--ink);
    font: 600 12px -apple-system, "Segoe UI", sans-serif;
  }

  .ns {
    fill: var(--mut);
    font: 11px var(--mono);
  }

  .flt {
    stroke: var(--bg);
    stroke-width: 1.5;
  }

  .flt-arp {
    fill: var(--warn);
  }

  .flt-icmp {
    fill: var(--ok);
  }

  .flt-udp {
    fill: var(--l4);
  }

  .flt-dns {
    fill: var(--l7);
  }

  .flt-dhcp {
    fill: var(--mut);
  }

  .flt-otro {
    fill: var(--mut);
  }

  .flt-dropped {
    fill: var(--bad);
  }

  .flow {
    width: 100%;
    height: auto;
    display: block;
    background: var(--panel);
    border: 1px solid var(--line);
    margin-bottom: 6px;
  }

  .flow-lane {
    stroke: var(--line);
    stroke-width: 1;
    stroke-dasharray: 2 3;
  }

  .flow-label {
    fill: var(--mut);
    font: 11px var(--mono);
  }

  .flow-arrow line {
    stroke-width: 1.5;
  }

  .flow-arrow line.flt-arp {
    stroke: var(--warn);
  }

  .flow-arrow line.flt-icmp {
    stroke: var(--ok);
  }

  .flow-arrow line.flt-udp {
    stroke: var(--l4);
  }

  .flow-arrow line.flt-dns {
    stroke: var(--l7);
  }

  .flow-arrow line.flt-dhcp,
  .flow-arrow line.flt-otro {
    stroke: var(--mut);
  }

  .flow-arrow line.flt-dropped {
    stroke: var(--bad);
    stroke-dasharray: 3 2;
  }

  .devices {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .devices td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  .devices td:first-child {
    color: var(--acc);
    font-weight: 600;
    width: 44px;
    font-family: var(--mono);
  }

  .devices td:last-child {
    font-family: var(--mono);
    color: var(--mut);
  }

  .chips {
    display: flex;
    gap: 6px;
  }

  .chips button {
    padding: 2px 9px;
    font-size: 11.5px;
    letter-spacing: 0;
    text-transform: none;
  }

  .chips button[aria-pressed="true"] {
    border-color: var(--acc);
    color: var(--acc);
  }

  .filter-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 14px 10px;
  }

  .filter-lbl {
    color: var(--mut);
    font: 11px var(--mono);
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .filter-input {
    flex: 1;
    min-width: 170px;
    background: var(--code);
    border: 1px solid var(--line);
    color: var(--ink);
    font: 12px var(--mono);
    padding: 6px 9px;
  }

  .filter-input::placeholder {
    color: var(--dim);
  }

  .filter-input:focus {
    border-color: var(--acc);
    outline: none;
  }

  .filter-input[aria-invalid="true"] {
    border-color: var(--bad);
  }

  .filter-error,
  .filter-hint {
    flex-basis: 100%;
    margin: 0;
    font: 12px var(--mono);
  }

  .filter-error {
    color: var(--bad);
  }

  .filter-hint {
    color: var(--dim);
  }

  .table-wrap {
    overflow: auto;
  }

  .pkts {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 12px;
  }

  .pkts th {
    position: sticky;
    top: 0;
    background: var(--panel);
    color: var(--mut);
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    font: 600 12px -apple-system, "Segoe UI", sans-serif;
  }

  .pkts td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }

  .pkts tbody tr {
    cursor: pointer;
    border-left: 3px solid transparent;
  }

  .pkts tbody tr:hover {
    background: var(--panel);
  }

  .pkts tbody tr[aria-selected="true"] {
    background: var(--sel);
    border-left-color: var(--acc);
  }

  .badge {
    display: inline-block;
    padding: 1px 6px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid currentColor;
  }

  .dir {
    font-size: 11px;
    color: var(--mut);
  }

  .dir.tx {
    color: var(--mut);
  }

  .dir.rx {
    color: var(--ok);
  }

  .dir.drop {
    color: var(--bad);
  }

  .drop-why {
    color: var(--bad);
  }

  .b-echo {
    color: var(--ok);
  }

  .b-arp {
    color: var(--warn);
  }

  .b-udp {
    color: var(--l4);
  }

  .b-dns {
    color: var(--l7);
  }

  .b-dhcp {
    color: var(--mut);
  }

  .b-err {
    color: var(--bad);
  }

  .timeline {
    padding: 12px 14px;
    border-top: 1px solid var(--line);
  }

  .timeline label {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: var(--mut);
    font-size: 12px;
    margin-bottom: 6px;
  }

  .timeline input {
    width: 100%;
    accent-color: var(--acc);
  }

  .marks {
    position: relative;
    height: 14px;
    margin-top: 2px;
  }

  .marks i {
    position: absolute;
    width: 2px;
    height: 8px;
    background: var(--dim);
    transform: translateX(-1px);
  }

  .marks i.cur {
    background: var(--acc);
    height: 14px;
  }

  .tabs {
    display: flex;
    gap: 4px;
    padding: 10px 14px 0;
    border-bottom: 1px solid var(--line);
  }

  .tabs button {
    border-radius: 0;
    border-bottom: 0;
    background: transparent;
  }

  .tabs button[aria-selected="true"] {
    background: var(--panel2);
    color: var(--acc);
    border-color: var(--line);
  }

  .pane {
    padding: 12px 14px;
  }

  .layer {
    border: 1px solid var(--line);
    border-left: 4px solid var(--c);
    margin-bottom: 8px;
    overflow: hidden;
  }

  .layer > button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 8px;
    background: var(--panel2);
    border: 0;
    padding: 8px 10px;
    font-family: var(--mono);
    font-size: 12.5px;
    text-align: left;
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 8px;
  }

  .field {
    display: grid;
    grid-template-columns: 104px 1fr;
    gap: 10px;
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    padding: 2px 4px;
    font-family: var(--mono);
    font-size: 12px;
    text-align: left;
  }

  .field:hover {
    border-color: var(--line);
  }

  .field.sel {
    background: var(--sel);
    border-color: var(--acc);
  }

  .f-label {
    color: var(--mut);
  }

  .field.sel .f-label {
    color: var(--acc);
  }

  .f-value {
    overflow-wrap: anywhere;
  }

  .hex {
    font: 12px/1.7 var(--mono);
    background: var(--code);
    border: 1px solid var(--line);
    padding: 10px 12px;
    overflow: auto;
    margin: 0 0 10px;
  }

  .hex b {
    font-weight: 400;
    padding: 0 1px;
  }

  .hex b.l2 {
    color: var(--l2);
  }

  .hex b.l3 {
    color: var(--l3);
  }

  .hex b.l4 {
    color: var(--l4);
  }

  .hex b.l7 {
    color: var(--l7);
  }

  .hex b.pad {
    color: var(--dim);
  }

  .hex b.lit {
    background: color-mix(in srgb, currentColor 22%, transparent);
  }

  .hex b.sel {
    background: color-mix(in srgb, currentColor 45%, transparent);
    outline: 1px solid currentColor;
  }

  .hexline {
    display: block;
  }

  .hint {
    color: var(--dim);
    font-size: 12px;
    margin: 0;
  }

  .empty {
    color: var(--mut);
    padding: 12px 14px;
    margin: 0;
  }

  .error {
    color: var(--bad);
    padding: 12px 14px;
    margin: 0;
    border-bottom: 1px solid var(--line);
  }

  .terminal-pane {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .terminal {
    font: 12px/1.7 var(--mono);
    background: var(--code);
    border: 1px solid var(--line);
    padding: 10px 12px;
    overflow: auto;
    margin: 0;
    white-space: pre-wrap;
    min-height: 160px;
    max-height: 58vh;
  }

  .prompt {
    display: block;
    color: var(--ink);
  }

  .term-line {
    display: block;
    color: var(--mut);
  }

  .term-line.hop {
    color: var(--ok);
  }

  .term-line.err {
    color: var(--bad);
  }

  .term-row {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--line);
    background: var(--code);
    padding: 6px 10px;
  }

  .term-row:focus-within {
    border-color: var(--acc);
  }

  .term-prompt {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
  }

  .term-input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: 12px var(--mono);
    padding: 2px 0;
  }

  .term-input::placeholder {
    color: var(--dim);
  }

  .kv {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-bottom: 12px;
  }

  .kv th {
    text-align: left;
    color: var(--mut);
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .kv td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    font-family: var(--mono);
  }

  .kv td:first-child {
    color: var(--acc);
    font-weight: 600;
  }

  .status {
    display: flex;
    gap: 18px;
    align-items: center;
    flex-wrap: wrap;
    min-height: 30px;
    padding: 4px 16px;
    border-top: 1px solid var(--line);
    background: var(--panel);
    font: 12px var(--mono);
    color: var(--mut);
  }

  .status b {
    color: var(--ink);
  }

  @media (max-width: 1100px) {
    .workbench {
      grid-template-columns: 260px minmax(0, 1fr);
    }

    .detail-col {
      grid-column: 1 / -1;
      border-top: 1px solid var(--line);
      border-right: 0;
    }
  }

  @media (max-width: 720px) {
    .workbench {
      display: block;
    }

    .col {
      border-right: 0;
      border-bottom: 1px solid var(--line);
      overflow: visible;
    }

    .simtime {
      text-align: left;
    }
  }
  /* Fase 8 T2: skip-link, región de estado y movimiento reducido. */
  .skip {
    position: absolute;
    left: 0.5rem;
    top: -3rem;
    z-index: 50;
    background: #16161a;
    color: #f2f2f5;
    padding: 0.5rem 0.75rem;
    border: 1px solid #4da3ff;
    border-radius: 0.375rem;
    transition: top 0.15s;
  }
  .skip:focus-visible {
    top: 0.5rem;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  /* Fase 8 T3: overlay del tutorial de bienvenida. */
  .tut-layer {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .tut-spot {
    position: fixed;
    border: 2px solid var(--acc);
    box-shadow: 0 0 0 9999px rgba(5, 5, 6, 0.78);
    pointer-events: none;
  }
  .tut-card {
    position: fixed;
    top: 0.75rem;
    left: 0.75rem;
    width: min(22rem, calc(100vw - 1.5rem));
    padding: 1rem 1.1rem;
    background: var(--panel);
    border: 1px solid var(--acc);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  }
  .tut-card:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }
  .tut-progress {
    margin: 0 0 0.35rem;
    color: var(--ok);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .tut-title {
    margin: 0 0 0.35rem;
    font: 700 1.1rem var(--disp);
    letter-spacing: 0.3px;
  }
  .tut-line {
    margin: 0 0 0.55rem;
    color: var(--mut);
  }
  .tut-action {
    display: flex;
    gap: 0.5rem;
    margin: 0 0 0.9rem;
    color: var(--ink);
  }
  .tut-dot {
    flex: none;
    width: 0.45rem;
    height: 0.45rem;
    margin-top: 0.4rem;
    border-radius: 50%;
    background: var(--acc);
  }
  .tut-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .tut-next {
    background: var(--ok);
    border-color: var(--ok);
    color: #050506;
    font-weight: 600;
  }
  .tut-skip {
    margin-left: auto;
  }
  @media (prefers-reduced-motion: no-preference) {
    .tut-card {
      animation: tut-in 0.14s ease-out;
    }
    @keyframes tut-in {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
