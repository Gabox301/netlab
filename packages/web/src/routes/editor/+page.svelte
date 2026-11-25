<script lang="ts">
import type { ScenarioPingAction } from "../../lib/topology";
import {
  ALIGN_MODES,
  type AlignMode,
  addInterface,
  addLink,
  addNode,
  addRoute,
  alignNodes,
  applyLinkPreset,
  buildTemplate,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  canConnect,
  canRedoHistory,
  canUndoHistory,
  createHistory,
  DEVICE_GLYPH,
  DEVICE_KINDS,
  type DeviceKind,
  describeAction,
  duplicateNodes,
  exampleTopology,
  historyPush,
  historyRedo,
  historyUndo,
  interfaceAnchor,
  interfaceLink,
  kindLabel,
  LINK_PRESET_IDS,
  LINK_PRESETS,
  type LinkPresetId,
  NODE_HEIGHT,
  NODE_WIDTH,
  parseSavedTopology,
  removeInterface,
  removeLink,
  removeNode,
  removeRoute,
  renameInterface,
  renameNode,
  serializeTopology,
  TEMPLATE_IDS,
  TEMPLATES,
  type TemplateId,
  type Topology,
  type TopologyEndpoint,
  type TopologyHistory,
  type TopologyInterface,
  type TopologyLink,
  type TopologyNode,
  type TopologyRoute,
  topologyFromJson,
  topologyToScenarioJson,
} from "../../lib/topology";
import {
  type CanvasView,
  panPx,
  resetView,
  viewBoxOf,
  zoomAt,
  zoomAtPoint,
} from "../../lib/view";

type Selection =
  | { kind: "node"; name: string }
  | { kind: "link"; id: string }
  | null;

type Tool = "select" | "cable";

type NoticeKind = "ok" | "error" | "info";

interface Notice {
  kind: NoticeKind;
  text: string;
}

interface PaletteDrag {
  kind: DeviceKind;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  pointerId: number;
}

interface NodeDrag {
  name: string;
  dx: number;
  dy: number;
  pointerId: number;
}

/** Mount-time restore: the draft wins over the example, and says so. */
interface InitialLoad {
  topology: Topology;
  restored: boolean;
}

const MIN_X = 8;
const MIN_Y = 8;
const MAX_X = CANVAS_WIDTH - NODE_WIDTH - MIN_X;
const MAX_Y = CANVAS_HEIGHT - NODE_HEIGHT - MIN_Y;

/** Short button labels for the align panel (one per `ALIGN_MODES` entry). */
const ALIGN_LABEL: Record<AlignMode, string> = {
  left: "Izq",
  centerX: "Centro",
  right: "Der",
  top: "Arriba",
  centerY: "Medio",
  bottom: "Abajo",
};

/** Prepositional phrases so titles and notices read naturally per axis. */
const ALIGN_WHERE: Record<AlignMode, string> = {
  left: "a la izquierda",
  centerX: "al centro horizontal",
  right: "a la derecha",
  top: "arriba",
  centerY: "al centro vertical",
  bottom: "abajo",
};

/** F-130 storage keys: one rolling draft plus named saves. */
const AUTOSAVE_KEY = "netlab.editor.autosave.v1";
const SLOTS_KEY = "netlab.editor.slots.v1";

const initial = loadInitialTopology();
let topology = $state<Topology>(initial.topology);
let history = $state<TopologyHistory>(createHistory());
/** True while a drag/key-hold/text session shares one undo step. */
let coalescing = false;
let selection = $state<Selection>(null);
/** Extra nodes picked with Shift+click, beyond the primary selection. */
let extraSelected = $state<Array<string>>([]);
let tool = $state<Tool>("select");
let pending = $state<TopologyEndpoint | null>(null);
let cableCursor = $state<{ x: number; y: number } | null>(null);
let paletteDrag = $state<PaletteDrag | null>(null);
let nodeDrag = $state<NodeDrag | null>(null);
/**
 * Transient viewport over the 1440x900 world. Like `tool`, it never enters the
 * history: undo/redo/load leave it alone.
 */
let view = $state<CanvasView>(resetView());
let canvasPan = $state<{
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
} | null>(null);
let notice = $state<Notice>({
  kind: "info",
  text: initial.restored
    ? "Borrador restaurado desde este navegador."
    : "Ejemplo cargado: h1 → r1 → h2/h3 con ping. Exportá el JSON y corré netlab run.",
});
let filename = $state("mi-topologia");
let pingDraft = $state({
  host: "h1",
  destIp: "10.0.1.2",
  count: "2",
  size: "32",
  interval: "1ms",
});

let svgEl: SVGSVGElement | null = null;
let fileInput: HTMLInputElement | null = null;

/** Names waiting to be duplicated again; never the topology nodes themselves. */
let clipboard = $state<Array<string> | null>(null);
/** Named saves: name → serialized `SavedTopology` text (F-130 slots). */
let slots = $state<Record<string, string>>(loadSlots());
let slotName = $state("");

/**
 * Autosave (F-130): `serializeTopology` walks the whole model, so this re-runs
 * on any nested mutation. It records no undo step and calls no notice.
 */
$effect(() => {
  writeLocal(AUTOSAVE_KEY, serializeTopology(topology));
});

const selectedNode = $derived(selectedNodeOf());
const selectedLink = $derived(selectedLinkOf());
/** Nodes the align panel would move: primary node plus Shift-picked extras. */
const alignTargets = $derived.by(() => {
  const names = new Set(extraSelected);
  if (selection?.kind === "node") {
    names.add(selection.name);
  }
  return topology.nodes.filter((node) => names.has(node.name));
});
const canUndo = $derived(canUndoHistory(history));
const canRedo = $derived(canRedoHistory(history));
const canCopy = $derived(selectedNode !== null);
const canPaste = $derived(clipboard !== null);
const hostNodes = $derived(
  topology.nodes.filter((node) => node.kind === "host"),
);
const linkRows = $derived.by(() => {
  const rows: Array<{
    link: TopologyLink;
    ax: number;
    ay: number;
    bx: number;
    by: number;
  }> = [];
  for (const link of topology.links) {
    const a = anchorFor(link.a);
    const b = anchorFor(link.b);
    if (a !== null && b !== null) {
      rows.push({ link, ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }
  return rows;
});
const pendingAnchor = $derived(pending === null ? null : anchorFor(pending));
/** Slot rows: name plus the readable timestamp stored inside its text. */
const slotRows = $derived.by(() =>
  Object.entries(slots).map(([name, text]) => ({
    name,
    when: slotSavedAt(text),
  })),
);

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Storage reads never throw: private mode, disabled storage or the static
 * prerender (no DOM) all read as "nothing stored".
 */
function readLocal(key: string): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes fail silently too: a refused write must never block editing. */
function writeLocal(key: string, value: string): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or private mode: drop the write and keep editing.
  }
}

/** Restore the autosave draft; a corrupt or old one falls back to the example. */
function loadInitialTopology(): InitialLoad {
  const stored = readLocal(AUTOSAVE_KEY);
  if (stored !== null) {
    try {
      return { topology: parseSavedTopology(stored), restored: true };
    } catch {
      // Same fallback as a missing draft; the autosave effect overwrites it.
    }
  }
  return { topology: exampleTopology(), restored: false };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function setNotice(kind: NoticeKind, text: string): void {
  notice = { kind, text };
}

function snapshotTopology(): Topology {
  return structuredClone($state.snapshot(topology));
}

/** Record the pre-mutation state; call before mutating `topology`. */
function checkpoint(): void {
  history = historyPush(history, snapshotTopology());
}

/**
 * Coalesced gestures (drag, arrow-key hold, text typing) share one undo
 * step: the first call records the snapshot, the rest are no-ops until
 * `endCoalesced` (pointer-up, key-up, focus leaving the inspector).
 */
function beginCoalesced(): void {
  if (!coalescing) {
    checkpoint();
    coalescing = true;
  }
}

function endCoalesced(): void {
  coalescing = false;
}

function applyHistoryStep(snapshot: Topology, text: string): void {
  topology = snapshot;
  pending = null;
  cableCursor = null;
  nodeDrag = null;
  paletteDrag = null;
  extraSelected = [];
  coalescing = false;
  setNotice("info", text);
}

function onUndo(): void {
  const undone = historyUndo(history, snapshotTopology());
  if (undone === null) {
    setNotice("info", "Nada que deshacer.");
    return;
  }
  history = undone.history;
  applyHistoryStep(undone.snapshot, "Deshecho.");
}

function onRedo(): void {
  const redone = historyRedo(history, snapshotTopology());
  if (redone === null) {
    setNotice("info", "Nada que rehacer.");
    return;
  }
  history = redone.history;
  applyHistoryStep(redone.snapshot, "Rehecho.");
}

function onCopySelected(): void {
  const node = selectedNode;
  if (node === null) {
    setNotice("info", "Elegí un dispositivo en el lienzo para copiarlo.");
    return;
  }
  // Copying never mutates the topology, so it records no undo step.
  clipboard = [node.name];
  setNotice("ok", `${node.name} copiado: Ctrl+V lo pega duplicado.`);
}

function onPasteClipboard(): void {
  const names = clipboard;
  if (names === null) {
    setNotice("info", "Nada copiado todavía: elegí un dispositivo y Ctrl+C.");
    return;
  }
  try {
    const pasted = duplicateNodes(topology, names);
    checkpoint();
    topology = pasted.topology;
    // Duplicates land at src + 32; pull back anything the canvas edge clips.
    for (const name of pasted.names) {
      const node = topology.nodes.find((candidate) => candidate.name === name);
      if (node === undefined) {
        continue;
      }
      node.x = clamp(node.x, MIN_X, MAX_X);
      node.y = clamp(node.y, MIN_Y, MAX_Y);
    }
    // Cascade: the next paste starts from the fresh duplicates.
    clipboard = pasted.names;
    const first = pasted.names[0];
    if (first !== undefined) {
      selection = { kind: "node", name: first };
      extraSelected = [];
    }
    const devices = plural(
      pasted.names.length,
      "dispositivo pegado",
      "dispositivos pegados",
    );
    const cables =
      pasted.linkIds.length === 0
        ? ""
        : ` con ${plural(pasted.linkIds.length, "cable interno", "cables internos")}`;
    setNotice("ok", `${devices}${cables}.`);
  } catch (error) {
    // A source deleted by undo/import makes duplicateNodes throw.
    setNotice("error", messageOf(error));
  }
}

function endpointLabel(endpoint: TopologyEndpoint): string {
  return `${endpoint.node}:${endpoint.iface}`;
}

function anchorFor(
  endpoint: TopologyEndpoint,
): { x: number; y: number } | null {
  const node = topology.nodes.find(
    (candidate) => candidate.name === endpoint.node,
  );
  if (node === undefined) {
    return null;
  }
  return interfaceAnchor(node, endpoint.iface);
}

function selectedNodeOf(): TopologyNode | null {
  const current = selection;
  if (current === null || current.kind !== "node") {
    return null;
  }
  return topology.nodes.find((node) => node.name === current.name) ?? null;
}

function selectedLinkOf(): TopologyLink | null {
  const current = selection;
  if (current === null || current.kind !== "link") {
    return null;
  }
  return topology.links.find((link) => link.id === current.id) ?? null;
}

function nodeSubtitle(node: TopologyNode): string {
  if (node.kind === "host" || node.kind === "server") {
    const iface = node.interfaces[0];
    if (iface === undefined || iface.ip === "") {
      return "sin IP";
    }
    return iface.prefixLength === ""
      ? iface.ip
      : `${iface.ip}/${iface.prefixLength}`;
  }
  return kindLabel(node.kind);
}

function toSvgPoint(
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (svgEl === null) {
    return null;
  }
  const matrix = svgEl.getScreenCTM();
  if (matrix === null) {
    return null;
  }
  const point = new DOMPoint(clientX, clientY).matrixTransform(
    matrix.inverse(),
  );
  return { x: point.x, y: point.y };
}

function freeSpot(): { x: number; y: number } {
  for (let index = 0; index < 30; index += 1) {
    const x = 120 + (index % 4) * 230;
    const y = 120 + Math.floor(index / 4) * 150;
    const taken = topology.nodes.some(
      (node) => Math.abs(node.x - x) < 100 && Math.abs(node.y - y) < 80,
    );
    if (!taken) {
      return { x, y };
    }
  }
  return {
    x: 120 + ((topology.nodes.length * 32) % 600),
    y: 120 + ((topology.nodes.length * 24) % 400),
  };
}

function loadTopology(next: Topology, text: string): void {
  checkpoint();
  coalescing = false;
  topology = next;
  selection = null;
  extraSelected = [];
  pending = null;
  cableCursor = null;
  tool = "select";
  const firstHost = next.nodes.find((node) => node.kind === "host");
  pingDraft.host = firstHost?.name ?? "";
  setNotice("ok", text);
}

function loadExample(): void {
  loadTopology(
    exampleTopology(),
    "Ejemplo cargado: h1 → r1 → h2/h3 con ping h1 → h3. Exportá y corré netlab run.",
  );
}

function loadTemplate(id: TemplateId): void {
  try {
    const built = buildTemplate(id);
    loadTopology(
      built,
      `Plantilla ${TEMPLATES[id].label} cargada: ${TEMPLATES[id].description}`,
    );
  } catch (error) {
    setNotice("error", messageOf(error));
  }
}

/** Read the named saves; anything malformed degrades to "no saves". */
function loadSlots(): Record<string, string> {
  const stored = readLocal(SLOTS_KEY);
  if (stored === null) {
    return {};
  }
  try {
    const raw: unknown = JSON.parse(stored);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {};
    }
    const valid: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        valid[name] = value;
      }
    }
    return valid;
  } catch {
    return {};
  }
}

/** Replace the slot map and mirror it to storage. */
function persistSlots(next: Record<string, string>): void {
  slots = next;
  writeLocal(SLOTS_KEY, JSON.stringify(next));
}

/** "2025-06-01T12:34:56.000Z" → "2025-06-01 12:34"; "—" when unreadable. */
function slotSavedAt(text: string): string {
  try {
    const { savedAt } = JSON.parse(text) as { savedAt?: unknown };
    if (typeof savedAt !== "string" || Number.isNaN(Date.parse(savedAt))) {
      return "—";
    }
    return savedAt.slice(0, 16).replace("T", " ");
  } catch {
    return "—";
  }
}

function onSaveSlot(): void {
  const name = slotName.trim();
  if (name === "") {
    setNotice("error", "Poné un nombre para guardar la topología.");
    return;
  }
  const existed = slots[name] !== undefined;
  persistSlots({ ...slots, [name]: serializeTopology(topology) });
  slotName = "";
  setNotice(
    "ok",
    existed
      ? `Guardado "${name}" reemplazado en este navegador.`
      : `Guardado "${name}" en este navegador.`,
  );
}

function onLoadSlot(name: string): void {
  const text = slots[name];
  if (text === undefined) {
    setNotice("error", `El guardado "${name}" ya no existe.`);
    return;
  }
  try {
    loadTopology(parseSavedTopology(text), `Guardado "${name}" cargado.`);
  } catch (error) {
    setNotice("error", `No se cargó "${name}": ${messageOf(error)}`);
  }
}

function onDeleteSlot(name: string): void {
  const next = { ...slots };
  delete next[name];
  persistSlots(next);
  setNotice("info", `Guardado "${name}" eliminado.`);
}

function onSlotNameInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  slotName = input.value;
}

function onSlotNameKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  onSaveSlot();
}

function placeNode(kind: DeviceKind, x: number, y: number): void {
  const placed = addNode(
    topology,
    kind,
    clamp(x, MIN_X, MAX_X),
    clamp(y, MIN_Y, MAX_Y),
  );
  checkpoint();
  topology = placed.topology;
  selection = { kind: "node", name: placed.name };
  extraSelected = [];
  setNotice("ok", `${kindLabel(kind)} ${placed.name} agregado al lienzo.`);
}

function onPalettePointerDown(event: PointerEvent, kind: DeviceKind): void {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  paletteDrag = {
    kind,
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    pointerId: event.pointerId,
  };
}

function onPaletteClick(event: MouseEvent, kind: DeviceKind): void {
  if (event.detail !== 0) {
    return;
  }
  const spot = freeSpot();
  placeNode(kind, spot.x, spot.y);
}

function onWindowPointerMove(event: PointerEvent): void {
  const pan = canvasPan;
  if (pan !== null) {
    if (event.pointerId !== pan.pointerId) {
      return;
    }
    const rect = svgEl?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const dx = event.clientX - pan.lastX;
    const dy = event.clientY - pan.lastY;
    if (
      !pan.moved &&
      Math.hypot(event.clientX - pan.startX, event.clientY - pan.startY) > 4
    ) {
      pan.moved = true;
    }
    view = panPx(view, rect.width, rect.height, dx, dy);
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
    return;
  }
  if (paletteDrag !== null) {
    if (event.pointerId !== paletteDrag.pointerId) {
      return;
    }
    paletteDrag.x = event.clientX;
    paletteDrag.y = event.clientY;
    if (
      Math.hypot(
        event.clientX - paletteDrag.startX,
        event.clientY - paletteDrag.startY,
      ) > 4
    ) {
      paletteDrag.moved = true;
    }
    return;
  }
  const drag = nodeDrag;
  if (drag === null || event.pointerId !== drag.pointerId) {
    return;
  }
  const point = toSvgPoint(event.clientX, event.clientY);
  if (point === null) {
    return;
  }
  const node = topology.nodes.find((candidate) => candidate.name === drag.name);
  if (node === undefined) {
    return;
  }
  beginCoalesced();
  node.x = Math.round(clamp(point.x - drag.dx, MIN_X, MAX_X));
  node.y = Math.round(clamp(point.y - drag.dy, MIN_Y, MAX_Y));
}

function onWindowPointerUp(event: PointerEvent): void {
  if (canvasPan !== null && event.pointerId === canvasPan.pointerId) {
    if (!canvasPan.moved) {
      // A plain click (no pan) on the canvas clears the selection.
      pending = null;
      cableCursor = null;
      selection = null;
      extraSelected = [];
    }
    canvasPan = null;
    return;
  }
  if (paletteDrag !== null && event.pointerId === paletteDrag.pointerId) {
    const drag = paletteDrag;
    paletteDrag = null;
    const overCanvas =
      svgEl !== null &&
      event.target instanceof Node &&
      svgEl.contains(event.target);
    const point = toSvgPoint(event.clientX, event.clientY);
    if (overCanvas && point !== null) {
      placeNode(drag.kind, point.x - NODE_WIDTH / 2, point.y - NODE_HEIGHT / 2);
      return;
    }
    if (!drag.moved) {
      const spot = freeSpot();
      placeNode(drag.kind, spot.x, spot.y);
    }
    return;
  }
  if (nodeDrag !== null && event.pointerId === nodeDrag.pointerId) {
    nodeDrag = null;
    endCoalesced();
  }
}

function onCanvasPointerMove(event: PointerEvent): void {
  if (pending === null) {
    return;
  }
  const point = toSvgPoint(event.clientX, event.clientY);
  if (point !== null) {
    cableCursor = point;
  }
}

function onCanvasPointerDown(event: PointerEvent): void {
  if (tool !== "select") {
    pending = null;
    cableCursor = null;
    selection = null;
    extraSelected = [];
    return;
  }
  // Selecting: the click may turn into a pan, so deselect on pointerup.
  canvasPan = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    moved: false,
  };
}

/**
 * Shift+click: grow/shrink the align set instead of replacing the selection.
 * Shift+clicking the only selected node drops it, so the gesture toggles.
 */
function toggleExtra(name: string): void {
  if (
    selection?.kind === "node" &&
    selection.name === name &&
    extraSelected.length === 0
  ) {
    selection = null;
    return;
  }
  extraSelected = extraSelected.includes(name)
    ? extraSelected.filter((candidate) => candidate !== name)
    : [...extraSelected, name];
}

function onNodePointerDown(event: PointerEvent, node: TopologyNode): void {
  event.stopPropagation();
  if (event.button !== 0) {
    return;
  }
  if (event.shiftKey) {
    toggleExtra(node.name);
    return;
  }
  selection = { kind: "node", name: node.name };
  extraSelected = [];
  if (tool === "cable") {
    return;
  }
  const point = toSvgPoint(event.clientX, event.clientY);
  if (point === null) {
    return;
  }
  event.preventDefault();
  nodeDrag = {
    name: node.name,
    dx: point.x - node.x,
    dy: point.y - node.y,
    pointerId: event.pointerId,
  };
}

function onNodeKeyDown(event: KeyboardEvent, node: TopologyNode): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selection = { kind: "node", name: node.name };
    extraSelected = [];
    return;
  }
  const step = event.shiftKey ? 32 : 8;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const delta = moves[event.key];
  if (delta === undefined) {
    return;
  }
  event.preventDefault();
  const current = topology.nodes.find(
    (candidate) => candidate.name === node.name,
  );
  if (current === undefined) {
    return;
  }
  beginCoalesced();
  current.x = clamp(current.x + delta[0], MIN_X, MAX_X);
  current.y = clamp(current.y + delta[1], MIN_Y, MAX_Y);
  selection = { kind: "node", name: node.name };
  extraSelected = [];
}

function onPortPointerDown(
  event: PointerEvent,
  node: TopologyNode,
  ifaceName: string,
): void {
  event.preventDefault();
  event.stopPropagation();
  if (tool !== "cable") {
    selection = { kind: "node", name: node.name };
    extraSelected = [];
    return;
  }
  const point = toSvgPoint(event.clientX, event.clientY);
  if (point !== null) {
    cableCursor = point;
  }
  activatePort(node, ifaceName);
}

function onPortKeyDown(
  event: KeyboardEvent,
  node: TopologyNode,
  ifaceName: string,
): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  if (tool !== "cable") {
    selection = { kind: "node", name: node.name };
    extraSelected = [];
    return;
  }
  cableCursor = interfaceAnchor(node, ifaceName);
  activatePort(node, ifaceName);
}

function activatePort(node: TopologyNode, ifaceName: string): void {
  const endpoint: TopologyEndpoint = { node: node.name, iface: ifaceName };
  if (pending === null) {
    pending = endpoint;
    setNotice(
      "info",
      `Cable desde ${endpointLabel(endpoint)}: elegí la otra punta (Esc cancela).`,
    );
    return;
  }
  if (pending.node === endpoint.node && pending.iface === endpoint.iface) {
    pending = null;
    cableCursor = null;
    setNotice("info", "Cable cancelado.");
    return;
  }
  const check = canConnect(topology, pending, endpoint);
  if (!check.ok) {
    setNotice("error", check.reason);
    return;
  }
  try {
    const from = pending;
    const linked = addLink(topology, from, endpoint);
    checkpoint();
    topology = linked.topology;
    pending = null;
    cableCursor = null;
    selection = { kind: "link", id: linked.id };
    extraSelected = [];
    setNotice(
      "ok",
      `Cable ${linked.id}: ${endpointLabel(from)} ↔ ${endpointLabel(endpoint)}.`,
    );
    return;
  } catch (error) {
    setNotice("error", messageOf(error));
  }
}

function onSelectLink(event: PointerEvent, id: string): void {
  event.preventDefault();
  event.stopPropagation();
  pending = null;
  cableCursor = null;
  selection = { kind: "link", id };
  extraSelected = [];
}

function onLinkKeyDown(event: KeyboardEvent, id: string): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  pending = null;
  cableCursor = null;
  selection = { kind: "link", id };
  extraSelected = [];
}

function toggleCable(): void {
  tool = tool === "cable" ? "select" : "cable";
  pending = null;
  cableCursor = null;
  setNotice(
    "info",
    tool === "cable"
      ? "Modo cable: tocá dos interfaces para unirlas."
      : "Modo selección: arrastrá nodos para moverlos.",
  );
}

function setSelectTool(): void {
  tool = "select";
  pending = null;
  cableCursor = null;
}

/** Zoom around the middle of the canvas (keyboard and toolbar zoom). */
function zoomCenter(factor: number): void {
  view = zoomAt(view, 0.5, 0.5, factor);
}

function resetZoom(): void {
  view = resetView();
}

/** Wheel zoom needs a non-passive listener, so hook it up by hand. */
$effect(() => {
  const el = svgEl;
  if (el === null) {
    return;
  }
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    view = zoomAtPoint(
      view,
      rect.width,
      rect.height,
      event.clientX - rect.left,
      event.clientY - rect.top,
      Math.exp(-dy * 0.002),
    );
  };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
});

function onWindowKeyDown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && (event.key === "z" || event.key === "Z")) {
    // Inside a field the native text undo wins; elsewhere undo the canvas.
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) {
      onRedo();
    } else {
      onUndo();
    }
    return;
  }
  if (mod && (event.key === "y" || event.key === "Y")) {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    event.preventDefault();
    onRedo();
    return;
  }
  if (mod && (event.key === "c" || event.key === "C")) {
    // Inside a field Ctrl+C belongs to the native text clipboard.
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    event.preventDefault();
    onCopySelected();
    return;
  }
  if (mod && (event.key === "v" || event.key === "V")) {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    event.preventDefault();
    onPasteClipboard();
    return;
  }
  if (!mod) {
    // Zoom keys stay native inside the form fields, like the mod shortcuts.
    const target = event.target;
    const inField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    if (!inField && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      zoomCenter(1.25);
      return;
    }
    if (!inField && event.key === "-") {
      event.preventDefault();
      zoomCenter(1 / 1.25);
      return;
    }
    if (!inField && event.key === "0") {
      event.preventDefault();
      resetZoom();
      return;
    }
  }
  if (event.key !== "Escape") {
    return;
  }
  endCoalesced();
  if (pending !== null) {
    pending = null;
    cableCursor = null;
    setNotice("info", "Cable cancelado.");
    return;
  }
  if (paletteDrag !== null) {
    paletteDrag = null;
    return;
  }
  if (nodeDrag !== null) {
    nodeDrag = null;
    return;
  }
  if (canvasPan !== null) {
    canvasPan = null;
    return;
  }
  if (tool === "cable") {
    tool = "select";
    setNotice("info", "Modo cable desactivado.");
  }
}

function onRenameNode(node: TopologyNode, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  try {
    const next = renameNode(topology, node.name, input.value);
    checkpoint();
    topology = next;
    selection = { kind: "node", name: input.value.trim() };
    extraSelected = extraSelected.map((name) =>
      name === node.name ? input.value.trim() : name,
    );
    setNotice("ok", `Dispositivo renombrado a ${input.value.trim()}.`);
  } catch (error) {
    input.value = node.name;
    setNotice("error", messageOf(error));
  }
}

function onRenameInterface(
  node: TopologyNode,
  iface: TopologyInterface,
  event: Event,
): void {
  const input = event.currentTarget as HTMLInputElement;
  try {
    const next = renameInterface(topology, node.name, iface.name, input.value);
    checkpoint();
    topology = next;
    setNotice("ok", `${node.name}: interfaz ${input.value.trim()} lista.`);
  } catch (error) {
    input.value = iface.name;
    setNotice("error", messageOf(error));
  }
}

function onIfaceField(
  iface: TopologyInterface,
  field: "mac" | "ip" | "mask" | "prefixLength" | "gateway" | "mtu",
  event: Event,
): void {
  const input = event.currentTarget as HTMLInputElement;
  beginCoalesced();
  iface[field] = input.value;
}

function onVlanModeChange(iface: TopologyInterface, event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  const mode = select.value;
  checkpoint();
  if (mode === "default") {
    iface.vlan = null;
    return;
  }
  if (mode !== "access" && mode !== "trunk") {
    return;
  }
  if (iface.vlan === null) {
    iface.vlan = { mode, vlan: "1", allowed: "", native: "" };
    return;
  }
  iface.vlan.mode = mode;
}

function onVlanField(
  iface: TopologyInterface,
  field: "vlan" | "allowed" | "native",
  event: Event,
): void {
  const input = event.currentTarget as HTMLInputElement;
  const vlan = iface.vlan;
  if (vlan === null) {
    return;
  }
  beginCoalesced();
  vlan[field] = input.value;
}

function onAddInterface(node: TopologyNode): void {
  try {
    const added = addInterface(topology, node.name);
    checkpoint();
    topology = added.topology;
    setNotice("ok", `${node.name}: interfaz ${added.name} agregada.`);
  } catch (error) {
    setNotice("error", messageOf(error));
  }
}

function onRemoveInterface(node: TopologyNode, iface: TopologyInterface): void {
  const attached = topology.links.filter(
    (link) =>
      (link.a.node === node.name && link.a.iface === iface.name) ||
      (link.b.node === node.name && link.b.iface === iface.name),
  ).length;
  checkpoint();
  topology = removeInterface(topology, node.name, iface.name);
  setNotice(
    "ok",
    `${node.name}: interfaz ${iface.name} eliminada${attached > 0 ? ` (${attached} cable(s) también)` : ""}.`,
  );
}

function onAddRoute(node: TopologyNode, destination = "10.0.0.0/24"): void {
  checkpoint();
  topology = addRoute(topology, node.name, destination);
  setNotice("ok", `${node.name}: ruta ${destination} agregada.`);
}

function onRemoveRoute(node: TopologyNode, index: number): void {
  checkpoint();
  topology = removeRoute(topology, node.name, index);
  setNotice("ok", `${node.name}: ruta eliminada.`);
}

function onRouteField(
  route: TopologyRoute,
  field: "destination" | "gateway" | "metric",
  event: Event,
): void {
  const input = event.currentTarget as HTMLInputElement;
  beginCoalesced();
  route[field] = input.value;
}

function onRouteIfaceChange(route: TopologyRoute, event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  checkpoint();
  route.iface = select.value;
}

function onRemoveNode(node: TopologyNode): void {
  checkpoint();
  topology = removeNode(topology, node.name);
  selection = null;
  extraSelected = extraSelected.filter((name) => name !== node.name);
  setNotice("ok", `${node.name} eliminado del lienzo.`);
}

function onAlign(mode: AlignMode): void {
  const names = [...new Set(alignTargets.map((node) => node.name))];
  if (names.length < 2) {
    setNotice("info", "Elegí al menos dos dispositivos para alinear.");
    return;
  }
  checkpoint();
  topology = alignNodes(topology, names, mode);
  setNotice("ok", `Alineados ${names.length} ${ALIGN_WHERE[mode]}.`);
}

function onRemoveSelectedLink(link: TopologyLink): void {
  checkpoint();
  topology = removeLink(topology, link.id);
  selection = null;
  extraSelected = [];
  setNotice("ok", `Cable ${link.id} eliminado.`);
}

function onLatencyChange(link: TopologyLink, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 0) {
    input.value = String(link.params.latencyUs);
    setNotice("error", "La latencia debe ser un entero ≥ 0 (µs).");
    return;
  }
  checkpoint();
  link.params.latencyUs = value;
}

function onApplyPreset(link: TopologyLink, preset: LinkPresetId): void {
  try {
    const next = applyLinkPreset(topology, link.id, preset);
    checkpoint();
    topology = next;
    selection = { kind: "link", id: link.id };
    extraSelected = [];
    setNotice(
      "ok",
      `Cable ${link.id}: preset ${LINK_PRESETS[preset].label} aplicado.`,
    );
  } catch (error) {
    setNotice("error", messageOf(error));
  }
}

function onJitterChange(link: TopologyLink, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const text = input.value.trim();
  if (text === "") {
    link.params.jitterUs = undefined;
    return;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    input.value =
      link.params.jitterUs === undefined ? "" : String(link.params.jitterUs);
    setNotice("error", "El jitter debe ser ≥ 0 (µs), o vacío.");
    return;
  }
  checkpoint();
  link.params.jitterUs = value;
}

function onRateChange(
  link: TopologyLink,
  field: "lossRate" | "reorderRate" | "duplicateRate" | "corruptRate",
  event: Event,
): void {
  const input = event.currentTarget as HTMLInputElement;
  const text = input.value.trim();
  if (text === "") {
    link.params[field] = undefined;
    return;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    input.value =
      link.params[field] === undefined ? "" : String(link.params[field]);
    setNotice("error", `${field} debe estar entre 0 y 1, o vacío.`);
    return;
  }
  checkpoint();
  link.params[field] = value;
}

function onBandwidthChange(link: TopologyLink, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const text = input.value.trim();
  if (text === "") {
    link.params.bandwidthBps = undefined;
    return;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    input.value =
      link.params.bandwidthBps === undefined
        ? ""
        : String(link.params.bandwidthBps);
    setNotice("error", "El ancho de banda debe ser > 0 (bps), o vacío.");
    return;
  }
  checkpoint();
  link.params.bandwidthBps = value;
}

function onMtuChange(link: TopologyLink, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const text = input.value.trim();
  if (text === "") {
    link.params.mtuBytes = undefined;
    return;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    input.value =
      link.params.mtuBytes === undefined ? "" : String(link.params.mtuBytes);
    setNotice("error", "La MTU debe ser un entero > 0 (bytes), o vacío.");
    return;
  }
  checkpoint();
  link.params.mtuBytes = value;
}

function onQueueLimitChange(link: TopologyLink, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const text = input.value.trim();
  if (text === "") {
    link.params.queueLimit = undefined;
    return;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    input.value =
      link.params.queueLimit === undefined
        ? ""
        : String(link.params.queueLimit);
    setNotice("error", "El límite de cola debe ser un entero > 0, o vacío.");
    return;
  }
  checkpoint();
  link.params.queueLimit = value;
}

function onAddBurst(link: TopologyLink): void {
  checkpoint();
  link.params.burst = { pGoodToBad: 0.02, pBadToGood: 0.4 };
  link.params.lossRate = undefined;
  setNotice("info", `Cable ${link.id}: ráfagas activas (reemplazan pérdida).`);
}

function onClearBurst(link: TopologyLink): void {
  checkpoint();
  link.params.burst = undefined;
}

function onBurstField(
  link: TopologyLink,
  field: "pGoodToBad" | "pBadToGood",
  event: Event,
): void {
  const burst = link.params.burst;
  if (burst === undefined) {
    return;
  }
  const input = event.currentTarget as HTMLInputElement;
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    input.value = String(burst[field]);
    setNotice("error", `${field} debe estar entre 0 y 1.`);
    return;
  }
  checkpoint();
  burst[field] = value;
}

function onSeedChange(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  const value = Number.parseInt(input.value, 10);
  if (!Number.isInteger(value) || value < 0) {
    input.value = String(topology.seed);
    setNotice("error", "seed debe ser un entero ≥ 0.");
    return;
  }
  checkpoint();
  topology.seed = value;
}

function onUntilInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  beginCoalesced();
  topology.until = input.value;
}

function onFilenameInput(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  filename = input.value;
}

function onRemoveAction(index: number): void {
  checkpoint();
  topology.actions = topology.actions.filter(
    (_, actionIndex) => actionIndex !== index,
  );
  setNotice("ok", "Acción eliminada.");
}

function addPing(): void {
  if (!hostNodes.some((node) => node.name === pingDraft.host)) {
    setNotice("error", "Elegí un host para el ping.");
    return;
  }
  const destIp = pingDraft.destIp.trim();
  if (destIp === "") {
    setNotice("error", "El ping necesita una IP destino.");
    return;
  }
  const count = Number.parseInt(pingDraft.count, 10);
  const size = Number.parseInt(pingDraft.size, 10);
  if (!Number.isInteger(count) || count < 1) {
    setNotice("error", "count debe ser un entero ≥ 1.");
    return;
  }
  if (!Number.isInteger(size) || size < 0) {
    setNotice("error", "size debe ser un entero ≥ 0.");
    return;
  }
  const interval = pingDraft.interval.trim();
  const action: ScenarioPingAction = {
    at: 0,
    host: pingDraft.host,
    destIp,
    ping: { count, size, ...(interval === "" ? {} : { interval }) },
  };
  checkpoint();
  topology.actions = [...topology.actions, action];
  setNotice("ok", `Ping ${pingDraft.host} → ${destIp} agregado.`);
}

function openImport(): void {
  fileInput?.click();
}

async function onImportFile(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) {
    return;
  }
  try {
    const text = await file.text();
    const imported = topologyFromJson(text);
    loadTopology(
      imported.topology,
      `Importado ${file.name}: ${plural(imported.topology.nodes.length, "nodo", "nodos")}, ${plural(imported.topology.links.length, "cable", "cables")}, ${plural(imported.topology.actions.length, "acción", "acciones")}.`,
    );
  } catch (error) {
    setNotice("error", `Import falló: ${messageOf(error)}`);
  } finally {
    input.value = "";
  }
}

function safeFilename(): string {
  const base = filename
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base === "" ? "netlab-topologia" : base;
}

function exportJson(): void {
  try {
    const { json, scenario } = topologyToScenarioJson(topology);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename()}.json`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNotice(
      "ok",
      `Exportado ${anchor.download} · v${scenario.version} · ${plural(scenario.nodes.length, "nodo", "nodos")}, ${plural(scenario.links.length, "cable", "cables")}, ${plural(scenario.actions.length, "acción", "acciones")} (validado con parseScenarioJson).`,
    );
  } catch (error) {
    setNotice("error", `No se exportó: ${messageOf(error)}`);
  }
}
</script>

<svelte:head>
  <title>NetLab — Editor de topología · Rojo señal</title>
  <meta
    name="description"
    content="Editor NetLab: dibujá la red, conectá interfaces y exportá un scenario v1 que netlab run ejecuta sin editar."
  />
</svelte:head>

<svelte:window
  onpointermove={onWindowPointerMove}
  onpointerup={onWindowPointerUp}
  onpointercancel={onWindowPointerUp}
  onkeydown={onWindowKeyDown}
/>

<div class="shell">
  <header class="top">
    <div class="logo">Net<b>Lab</b><span class="tag">editor</span></div>
    <div class="scen mono">
      {plural(topology.nodes.length, "nodo", "nodos")} · {plural(
        topology.links.length,
        "cable",
        "cables",
      )}
    </div>
    <div class="sp"></div>
    <span class="pill">autosave local</span>
    <a class="linkbtn" href="/">Workbench</a>
    <button type="button" onclick={loadExample}>Ejemplo</button>
    <button type="button" onclick={openImport}>Importar JSON</button>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      hidden
      onchange={(event) => void onImportFile(event)}
    />
    <button class="primary" type="button" onclick={exportJson}>
      Exportar JSON
    </button>
  </header>

  <main class="stage">
    <svg
      bind:this={svgEl}
      class="canvas"
      class:connecting={tool === "cable"}
      viewBox={viewBoxOf(view)}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label="Lienzo de topología: arrastrá dispositivos y conectá interfaces"
      onpointerdown={onCanvasPointerDown}
      onpointermove={onCanvasPointerMove}
    >
      <defs>
        <pattern
          id="netlab-grid"
          width="48"
          height="48"
          patternUnits="userSpaceOnUse"
        >
          <path class="gridline" d="M48 0H0V48" fill="none"></path>
        </pattern>
      </defs>
      <rect
        class="bg"
        x="0"
        y="0"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        fill="url(#netlab-grid)"
      ></rect>

      {#each linkRows as row (row.link.id)}
        <line
          class="link"
          class:sel={selection?.kind === "link" &&
            selection.id === row.link.id}
          x1={row.ax}
          y1={row.ay}
          x2={row.bx}
          y2={row.by}
        ></line>
        <line
          class="link-hit"
          x1={row.ax}
          y1={row.ay}
          x2={row.bx}
          y2={row.by}
          role="button"
          tabindex="0"
          aria-label={`Cable ${row.link.id}: ${row.link.a.node}:${row.link.a.iface} a ${row.link.b.node}:${row.link.b.iface}`}
          onpointerdown={(event) => onSelectLink(event, row.link.id)}
          onkeydown={(event) => onLinkKeyDown(event, row.link.id)}
        ></line>
      {/each}

      {#if pendingAnchor !== null && cableCursor !== null}
        <line
          class="preview"
          x1={pendingAnchor.x}
          y1={pendingAnchor.y}
          x2={cableCursor.x}
          y2={cableCursor.y}
        ></line>
      {/if}

      {#each topology.nodes as node (node.name)}
        <g
          class="node-g"
          class:sel={extraSelected.includes(node.name) ||
            (selection?.kind === "node" && selection.name === node.name)}
          class:dragging={nodeDrag?.name === node.name}
          role="button"
          tabindex="0"
          aria-label={`Dispositivo ${node.name} (${kindLabel(node.kind)})`}
          onpointerdown={(event) => onNodePointerDown(event, node)}
          onkeydown={(event) => onNodeKeyDown(event, node)}
          onkeyup={endCoalesced}
        >
          <rect
            class="node"
            x={node.x}
            y={node.y}
            width={NODE_WIDTH}
            height={NODE_HEIGHT}
            rx="12"
          ></rect>
          <text
            class="nl"
            x={node.x + NODE_WIDTH / 2}
            y={node.y + 27}
            text-anchor="middle">{node.name}</text
          >
          <text
            class={`ns k-${node.kind}`}
            x={node.x + NODE_WIDTH / 2}
            y={node.y + 45}
            text-anchor="middle">{nodeSubtitle(node)}</text
          >
        </g>
      {/each}

      {#each topology.nodes as node (node.name)}
        {#each node.interfaces as iface (iface.name)}
          {@const anchor = interfaceAnchor(node, iface.name)}
          {#if anchor !== null}
            <g
              class="port-g"
              class:armed={pending?.node === node.name &&
                pending?.iface === iface.name}
              class:used={interfaceLink(topology, {
                node: node.name,
                iface: iface.name,
              }) !== null}
              role="button"
              tabindex="0"
              aria-label={`Interfaz ${node.name}:${iface.name}`}
              onpointerdown={(event) =>
                onPortPointerDown(event, node, iface.name)}
              onkeydown={(event) => onPortKeyDown(event, node, iface.name)}
            >
              <title>{node.name}:{iface.name} · {iface.mac}</title>
              <circle
                class="port"
                cx={anchor.x}
                cy={anchor.y}
                r="6"
              ></circle>
              <circle
                class="port-core"
                cx={anchor.x}
                cy={anchor.y}
                r="2"
              ></circle>
              <text
                class="plbl"
                class:show={tool === "cable" ||
                  (selection?.kind === "node" &&
                    selection.name === node.name)}
                x={anchor.x}
                y={anchor.y + 19}
                text-anchor="middle">{iface.name}</text
              >
            </g>
          {/if}
        {/each}
      {/each}
    </svg>

    <nav class="palette" aria-label="Herramientas">
      <button
        type="button"
        class="tool"
        class:on={tool === "select"}
        aria-pressed={tool === "select"}
        title="Seleccionar y mover"
        onclick={setSelectTool}
      >
        <span class="glyph" aria-hidden="true">↖</span><small>select</small>
      </button>
      {#each DEVICE_KINDS as kind (kind)}
        <button
          type="button"
          class="tool"
          title={`Arrastrar ${kind} al lienzo (o clic para agregarlo)`}
          aria-label={`Agregar ${kind}`}
          onpointerdown={(event) => onPalettePointerDown(event, kind)}
          onclick={(event) => onPaletteClick(event, kind)}
        >
          <span class="glyph" aria-hidden="true">{DEVICE_GLYPH[kind]}</span>
          <small>{kind}</small>
        </button>
      {/each}
      <button
        type="button"
        class="tool"
        class:on={tool === "cable"}
        aria-pressed={tool === "cable"}
        title="Conectar interfaces con un cable"
        onclick={toggleCable}
      >
        <span class="glyph" aria-hidden="true">∿</span><small>cable</small>
      </button>
      <button
        type="button"
        class="tool"
        title="Deshacer (Ctrl+Z)"
        aria-label="Deshacer"
        disabled={!canUndo}
        onclick={onUndo}
      >
        <span class="glyph" aria-hidden="true">↩</span><small>undo</small>
      </button>
      <button
        type="button"
        class="tool"
        title="Rehacer (Ctrl+Mayús+Z)"
        aria-label="Rehacer"
        disabled={!canRedo}
        onclick={onRedo}
      >
        <span class="glyph" aria-hidden="true">↪</span><small>redo</small>
      </button>
      <button
        type="button"
        class="tool"
        title="Copiar dispositivo (Ctrl+C)"
        aria-label="Copiar dispositivo"
        disabled={!canCopy}
        onclick={onCopySelected}
      >
        <span class="glyph" aria-hidden="true">⧉</span><small>copy</small>
      </button>
      <button
        type="button"
        class="tool"
        title="Pegar (Ctrl+V)"
        aria-label="Pegar"
        disabled={!canPaste}
        onclick={onPasteClipboard}
      >
        <span class="glyph" aria-hidden="true">❐</span><small>paste</small>
      </button>
      <button
        type="button"
        class="tool"
        title="Acercar (rueda o +)"
        aria-label="Acercar"
        onclick={() => zoomCenter(1.25)}
      >
        <span class="glyph" aria-hidden="true">+</span><small>in</small>
      </button>
      <button
        type="button"
        class="tool"
        title="Alejar (rueda o -)"
        aria-label="Alejar"
        onclick={() => zoomCenter(1 / 1.25)}
      >
        <span class="glyph" aria-hidden="true">−</span><small>out</small>
      </button>
      <button
        type="button"
        class="tool"
        title="Vista 100% (0)"
        aria-label="Restablecer vista"
        onclick={resetZoom}
      >
        <span class="glyph" aria-hidden="true">⤾</span><small>1:1</small>
      </button>
    </nav>

    <aside class="inspector" aria-label="Propiedades" onfocusout={endCoalesced}>
      {#if alignTargets.length >= 2}
        <div class="sec">
          <h3>Alinear · {alignTargets.length}</h3>
          <span class="row">
            {#each ALIGN_MODES as mode (mode)}
              <button
                type="button"
                class="mini"
                title={`Alinear ${ALIGN_WHERE[mode]}`}
                onclick={() => onAlign(mode)}
              >
                {ALIGN_LABEL[mode]}
              </button>
            {/each}
          </span>
        </div>
      {/if}
      {#if selectedNode}
        {@const node = selectedNode}
        <div class="ins-head">
          <h2>{kindLabel(node.kind)} · {node.name}</h2>
          <button
            type="button"
            class="icon"
            aria-label="Deseleccionar"
            onclick={() => (selection = null)}>✕</button
          >
        </div>
        <div class="ins-body">
          <label class="fld">
            <span>nombre</span>
            <input
              value={node.name}
              spellcheck="false"
              onchange={(event) => onRenameNode(node, event)}
            />
          </label>

          <div class="sec">
            <h3>Interfaces · {node.interfaces.length}</h3>
            <button
              type="button"
              class="mini"
              onclick={() => onAddInterface(node)}>+ interfaz</button
            >
          </div>

          {#each node.interfaces as iface (iface.name)}
            <fieldset class="iface">
              <legend>{iface.name || "(sin nombre)"}</legend>
              <div class="grid2">
                <label class="fld">
                  <span>nombre</span>
                  <input
                    value={iface.name}
                    spellcheck="false"
                    onchange={(event) =>
                      onRenameInterface(node, iface, event)}
                  />
                </label>
                <label class="fld">
                  <span>MAC</span>
                  <input
                    class="mono"
                    value={iface.mac}
                    spellcheck="false"
                    oninput={(event) => onIfaceField(iface, "mac", event)}
                  />
                </label>
              </div>

              {#if node.kind === "host" || node.kind === "server"}
                <div class="grid2">
                  <label class="fld">
                    <span>IP</span>
                    <input
                      class="mono"
                      value={iface.ip}
                      placeholder="10.0.0.2"
                      oninput={(event) => onIfaceField(iface, "ip", event)}
                    />
                  </label>
                  <label class="fld">
                    <span>máscara</span>
                    <input
                      class="mono"
                      value={iface.mask}
                      placeholder="255.255.255.0"
                      oninput={(event) => onIfaceField(iface, "mask", event)}
                    />
                  </label>
                  <label class="fld">
                    <span>gateway</span>
                    <input
                      class="mono"
                      value={iface.gateway}
                      placeholder="10.0.0.1"
                      oninput={(event) =>
                        onIfaceField(iface, "gateway", event)}
                    />
                  </label>
                  <label class="fld">
                    <span>prefijo (opcional)</span>
                    <input
                      class="mono"
                      value={iface.prefixLength}
                      placeholder="24"
                      oninput={(event) =>
                        onIfaceField(iface, "prefixLength", event)}
                    />
                  </label>
                </div>
              {:else if node.kind === "router"}
                <div class="grid2">
                  <label class="fld">
                    <span>IP / CIDR</span>
                    <input
                      class="mono"
                      value={iface.ip}
                      placeholder="10.0.0.1"
                      oninput={(event) => onIfaceField(iface, "ip", event)}
                    />
                  </label>
                  <label class="fld">
                    <span>prefijo</span>
                    <input
                      class="mono"
                      value={iface.prefixLength}
                      placeholder="24"
                      oninput={(event) =>
                        onIfaceField(iface, "prefixLength", event)}
                    />
                  </label>
                  <label class="fld">
                    <span>MTU</span>
                    <input
                      class="mono"
                      value={iface.mtu}
                      placeholder="1500"
                      oninput={(event) => onIfaceField(iface, "mtu", event)}
                    />
                  </label>
                </div>
              {:else if node.kind === "switch"}
                <div class="grid2">
                  <label class="fld">
                    <span>VLAN</span>
                    <select
                      value={iface.vlan?.mode ?? "default"}
                      onchange={(event) => onVlanModeChange(iface, event)}
                    >
                      <option value="default">default (access 1)</option>
                      <option value="access">access</option>
                      <option value="trunk">trunk</option>
                    </select>
                  </label>
                  {#if iface.vlan?.mode === "access"}
                    <label class="fld">
                      <span>VLAN id</span>
                      <input
                        class="mono"
                        value={iface.vlan.vlan}
                        oninput={(event) =>
                          onVlanField(iface, "vlan", event)}
                      />
                    </label>
                  {/if}
                </div>
                {#if iface.vlan?.mode === "trunk"}
                  <div class="grid2">
                    <label class="fld">
                      <span>allowed</span>
                      <input
                        class="mono"
                        value={iface.vlan.allowed}
                        placeholder="10,20"
                        oninput={(event) =>
                          onVlanField(iface, "allowed", event)}
                      />
                    </label>
                    <label class="fld">
                      <span>native</span>
                      <input
                        class="mono"
                        value={iface.vlan.native}
                        oninput={(event) =>
                          onVlanField(iface, "native", event)}
                      />
                    </label>
                  </div>
                {/if}
              {/if}

              <button
                type="button"
                class="mini danger-ghost"
                onclick={() => onRemoveInterface(node, iface)}
              >
                Quitar interfaz
              </button>
            </fieldset>
          {/each}

          {#if node.kind === "router"}
            <div class="sec">
              <h3>Rutas estáticas · {node.routes.length}</h3>
              <span class="row">
                <button
                  type="button"
                  class="mini"
                  onclick={() => onAddRoute(node)}>+ ruta</button
                >
                <button
                  type="button"
                  class="mini"
                  onclick={() => onAddRoute(node, "0.0.0.0/0")}
                >
                  + default
                </button>
              </span>
            </div>
            {#each node.routes as route, index (index)}
              <div class="route">
                <div class="grid2">
                  <label class="fld">
                    <span>destino</span>
                    <input
                      class="mono"
                      value={route.destination}
                      oninput={(event) =>
                        onRouteField(route, "destination", event)}
                    />
                  </label>
                  <label class="fld">
                    <span>gateway</span>
                    <input
                      class="mono"
                      value={route.gateway}
                      placeholder="opcional"
                      oninput={(event) =>
                        onRouteField(route, "gateway", event)}
                    />
                  </label>
                  <label class="fld">
                    <span>iface</span>
                    <select
                      value={route.iface}
                      onchange={(event) => onRouteIfaceChange(route, event)}
                    >
                      {#each node.interfaces as option (option.name)}
                        <option value={option.name}>{option.name}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="fld">
                    <span>métrica</span>
                    <input
                      class="mono"
                      value={route.metric}
                      placeholder="0"
                      oninput={(event) =>
                        onRouteField(route, "metric", event)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  class="mini danger-ghost"
                  onclick={() => onRemoveRoute(node, index)}
                >
                  Quitar ruta
                </button>
              </div>
            {/each}
          {/if}

          <button
            type="button"
            class="danger"
            onclick={() => onRemoveNode(node)}
          >
            Eliminar dispositivo
          </button>
        </div>
      {:else if selectedLink}
        {@const link = selectedLink}
        <div class="ins-head">
          <h2>Cable · {link.id}</h2>
          <button
            type="button"
            class="icon"
            aria-label="Deseleccionar"
            onclick={() => (selection = null)}>✕</button
          >
        </div>
        <div class="ins-body">
          <p class="mono pair">
            {link.a.node}:{link.a.iface} ↔ {link.b.node}:{link.b.iface}
          </p>
          <div class="sec">
            <h3>Preset</h3>
            <span class="row">
              {#each LINK_PRESET_IDS as presetId (presetId)}
                <button
                  type="button"
                  class="mini"
                  title={LINK_PRESETS[presetId].hint}
                  onclick={() => onApplyPreset(link, presetId)}
                >
                  {LINK_PRESETS[presetId].label}
                </button>
              {/each}
            </span>
          </div>
          <div class="grid2">
            <label class="fld">
              <span>latencia (µs)</span>
              <input
                class="mono"
                type="number"
                min="0"
                step="1"
                value={link.params.latencyUs}
                onchange={(event) => onLatencyChange(link, event)}
              />
            </label>
            <label class="fld">
              <span>jitter (µs)</span>
              <input
                class="mono"
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={link.params.jitterUs ?? ""}
                onchange={(event) => onJitterChange(link, event)}
              />
            </label>
            <label class="fld">
              <span>pérdida (0–1)</span>
              <input
                class="mono"
                type="number"
                min="0"
                max="1"
                step="0.01"
                placeholder="0"
                disabled={link.params.burst !== undefined}
                title={link.params.burst !== undefined ? "Las ráfagas reemplazan la pérdida" : ""}
                value={link.params.lossRate ?? ""}
                onchange={(event) => onRateChange(link, "lossRate", event)}
              />
            </label>
            <label class="fld">
              <span>reorden (0–1)</span>
              <input
                class="mono"
                type="number"
                min="0"
                max="1"
                step="0.01"
                placeholder="0"
                value={link.params.reorderRate ?? ""}
                onchange={(event) => onRateChange(link, "reorderRate", event)}
              />
            </label>
            <label class="fld">
              <span>duplicado (0–1)</span>
              <input
                class="mono"
                type="number"
                min="0"
                max="1"
                step="0.01"
                placeholder="0"
                value={link.params.duplicateRate ?? ""}
                onchange={(event) => onRateChange(link, "duplicateRate", event)}
              />
            </label>
            <label class="fld">
              <span>corrupción (0–1)</span>
              <input
                class="mono"
                type="number"
                min="0"
                max="1"
                step="0.01"
                placeholder="0"
                value={link.params.corruptRate ?? ""}
                onchange={(event) => onRateChange(link, "corruptRate", event)}
              />
            </label>
            <label class="fld">
              <span>ancho de banda (bps)</span>
              <input
                class="mono"
                type="number"
                min="1"
                step="1000"
                placeholder="ilimitado"
                value={link.params.bandwidthBps ?? ""}
                onchange={(event) => onBandwidthChange(link, event)}
              />
            </label>
            <label class="fld">
              <span>MTU (bytes)</span>
              <input
                class="mono"
                type="number"
                min="1"
                step="1"
                placeholder="sin límite"
                value={link.params.mtuBytes ?? ""}
                onchange={(event) => onMtuChange(link, event)}
              />
            </label>
            <label class="fld">
              <span>límite de cola</span>
              <input
                class="mono"
                type="number"
                min="1"
                step="1"
                placeholder="ilimitada"
                value={link.params.queueLimit ?? ""}
                onchange={(event) => onQueueLimitChange(link, event)}
              />
            </label>
          </div>
          {#if link.params.burst}
            <div class="sec">
              <h3>Ráfagas · reemplazan la pérdida</h3>
              <div class="grid2">
                <label class="fld">
                  <span>pGoodToBad (0–1)</span>
                  <input
                    class="mono"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={link.params.burst.pGoodToBad}
                    onchange={(event) => onBurstField(link, "pGoodToBad", event)}
                  />
                </label>
                <label class="fld">
                  <span>pBadToGood (0–1)</span>
                  <input
                    class="mono"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={link.params.burst.pBadToGood}
                    onchange={(event) => onBurstField(link, "pBadToGood", event)}
                  />
                </label>
              </div>
              <button
                type="button"
                class="mini danger-ghost"
                onclick={() => onClearBurst(link)}
              >
                Quitar ráfagas
              </button>
            </div>
          {:else}
            <span class="row">
              <button
                type="button"
                class="mini"
                onclick={() => onAddBurst(link)}
              >
                + ráfagas
              </button>
            </span>
          {/if}
          <p class="hint">
            El export valida rangos (tasas 0–1, enteros positivos) y emite
            <span class="mono">params</span> completos. Nombres core:
            <span class="mono">burst</span>, <span class="mono">mtuBytes</span>.
          </p>
          <button
            type="button"
            class="danger"
            onclick={() => onRemoveSelectedLink(link)}
          >
            Eliminar cable
          </button>
        </div>
      {:else}
        <div class="ins-head">
          <h2>Escenario</h2>
        </div>
        <div class="ins-body">
          <p class="hint">
            Nada seleccionado. El export llama a
            <span class="mono">parseScenarioJson</span> antes de descargar.
          </p>
          <div class="sec">
            <h3>Plantillas</h3>
            <span class="row">
              {#each TEMPLATE_IDS as templateId (templateId)}
                <button
                  type="button"
                  class="mini"
                  title={TEMPLATES[templateId].description}
                  onclick={() => loadTemplate(templateId)}
                >
                  {TEMPLATES[templateId].label}
                </button>
              {/each}
            </span>
          </div>

          <div class="sec">
            <h3>Guardados · {slotRows.length}</h3>
          </div>
          <div class="row slot-new">
            <label class="fld">
              <span>nombre</span>
              <input
                class="mono"
                value={slotName}
                placeholder="nombre del guardado"
                oninput={onSlotNameInput}
                onkeydown={onSlotNameKeyDown}
              />
            </label>
            <button type="button" class="mini" onclick={onSaveSlot}>
              Guardar
            </button>
          </div>
          {#each slotRows as slot (slot.name)}
            <div class="slot">
              <span class="mono slot-label" title={slot.name}>{slot.name}</span>
              <span class="slot-when">{slot.when}</span>
              <button
                type="button"
                class="mini"
                onclick={() => onLoadSlot(slot.name)}
              >
                Cargar
              </button>
              <button
                type="button"
                class="mini danger-ghost"
                aria-label={`Borrar guardado ${slot.name}`}
                title="Borrar guardado"
                onclick={() => onDeleteSlot(slot.name)}
              >
                ✕
              </button>
            </div>
          {/each}
          <p class="hint">
            Los guardados viven en este navegador (localStorage). El borrador se
            autoguarda solo: recargar no pierde trabajo, pero otro equipo no lo ve.
          </p>

          <div class="grid2">
            <label class="fld">
              <span>seed</span>
              <input
                class="mono"
                type="number"
                min="0"
                step="1"
                value={topology.seed}
                onchange={onSeedChange}
              />
            </label>
            <label class="fld">
              <span>until</span>
              <input
                class="mono"
                value={topology.until}
                placeholder="5s"
                oninput={onUntilInput}
              />
            </label>
          </div>
          <label class="fld">
            <span>archivo</span>
            <input
              class="mono"
              value={filename}
              placeholder="mi-topologia"
              oninput={onFilenameInput}
            />
          </label>

          <div class="sec">
            <h3>Acciones · {topology.actions.length}</h3>
          </div>
          {#if topology.actions.length > 0}
            <ul class="actions">
              {#each topology.actions as action, index (index)}
                <li>
                  <span class="mono">{describeAction(action)}</span>
                  <button
                    type="button"
                    class="mini"
                    aria-label={`Quitar acción ${index + 1}`}
                    onclick={() => onRemoveAction(index)}>✕</button
                  >
                </li>
              {/each}
            </ul>
          {:else}
            <p class="hint">
              Lista vacía: el escenario sigue siendo v1 válido.
            </p>
          {/if}

          {#if hostNodes.length > 0}
            <fieldset class="iface">
              <legend>Agregar ping</legend>
              <div class="grid2">
                <label class="fld">
                  <span>host</span>
                  <select bind:value={pingDraft.host}>
                    {#each hostNodes as host (host.name)}
                      <option value={host.name}>{host.name}</option>
                    {/each}
                  </select>
                </label>
                <label class="fld">
                  <span>destino</span>
                  <input
                    class="mono"
                    bind:value={pingDraft.destIp}
                    placeholder="10.0.0.2"
                  />
                </label>
              </div>
              <div class="grid3">
                <label class="fld">
                  <span>count</span>
                  <input class="mono" bind:value={pingDraft.count} />
                </label>
                <label class="fld">
                  <span>size</span>
                  <input class="mono" bind:value={pingDraft.size} />
                </label>
                <label class="fld">
                  <span>interval</span>
                  <input class="mono" bind:value={pingDraft.interval} />
                </label>
              </div>
              <button type="button" class="mini" onclick={addPing}>
                + ping
              </button>
            </fieldset>
          {:else}
            <p class="hint">
              Agregá un host para poder crear acciones de ping.
            </p>
          {/if}

          <button type="button" class="primary wide" onclick={exportJson}>
            Exportar scenario v1
          </button>
        </div>
      {/if}
    </aside>

    {#if paletteDrag !== null && paletteDrag.moved}
      <div
        class="ghost"
        style={`left:${paletteDrag.x}px; top:${paletteDrag.y}px`}
        aria-hidden="true"
      >
        <span>{DEVICE_GLYPH[paletteDrag.kind]}</span>
        {paletteDrag.kind}
      </div>
    {/if}

    {#if topology.nodes.length === 0}
      <div class="empty-card">
        <h2>Lienzo vacío</h2>
        <p>
          Arrastrá un dispositivo desde la barra izquierda o cargá el ejemplo
          para ver el flujo dibujar → exportar → netlab run. O elegí una plantilla
          en el panel Escenario.
        </p>
        <div class="row center">
          <button type="button" onclick={loadExample}>Cargar ejemplo</button>
          <button type="button" onclick={openImport}>Importar JSON v1</button>
        </div>
      </div>
    {/if}
  </main>

  <footer class="status" aria-live="polite">
    <span
      class:ok={notice.kind === "ok"}
      class:bad={notice.kind === "error"}
      title={notice.text}>{notice.text}</span
    >
    <span class="sp"></span>
    <span>
      {plural(topology.nodes.length, "nodo", "nodos")} · {plural(
        topology.links.length,
        "cable",
        "cables",
      )} · {plural(topology.actions.length, "acción", "acciones")}
    </span>
    <span>seed {topology.seed} · hasta {topology.until || "5s"}</span>
    <span>{tool === "cable" ? "modo cable" : "modo selección"}</span>
  </footer>
</div>

<style>
  :global(:root) {
    --bg: #0b0b0d;
    --panel: #131316;
    --panel2: #1b1b20;
    --card: rgba(19, 19, 22, 0.96);
    --line: #34343c;
    --ink: #ffffff;
    --mut: #b4b4be;
    --dim: #80808c;
    --acc: #ff4d3d;
    --ok: #4dff9a;
    --warn: #ffd23d;
    --bad: #ff4d3d;
    --sel: #2e1512;
    --l2: #3dc8ff;
    --l3: #ff4d3d;
    --l4: #ffd23d;
    --disp: Impact, "Arial Narrow", "Arial Narrow Bold", sans-serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
      Arial, sans-serif;
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
    font: 14px var(--sans);
    overflow: hidden;
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

  :global(:focus-visible) {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  .shell {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    min-height: 52px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }

  .logo {
    font: 700 19px var(--disp);
    letter-spacing: 0.4px;
    white-space: nowrap;
  }

  .logo b {
    color: var(--acc);
  }

  .tag {
    margin-left: 8px;
    font: 11px var(--mono);
    color: var(--mut);
    text-transform: uppercase;
    letter-spacing: 1px;
    border: 1px solid var(--line);
    padding: 1px 6px;
    vertical-align: middle;
  }

  .scen {
    color: var(--mut);
    font-size: 12.5px;
    white-space: nowrap;
  }

  .sp {
    flex: 1;
  }

  .pill {
    font: 12px var(--mono);
    border: 1px solid var(--line);
    border-radius: 99px;
    padding: 5px 12px;
    color: var(--mut);
    white-space: nowrap;
  }

  .linkbtn {
    color: var(--ink);
    text-decoration: none;
    border: 1px solid var(--line);
    background: var(--panel2);
    padding: 7px 13px;
    white-space: nowrap;
  }

  .linkbtn:hover {
    border-color: var(--acc);
  }

  .primary {
    background: var(--acc);
    border-color: var(--acc);
    color: #ffffff;
    font-weight: 600;
  }

  .wide {
    width: 100%;
  }

  .mono {
    font-family: var(--mono);
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--bg);
  }

  .canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }

  .canvas.connecting {
    cursor: crosshair;
  }

  .gridline {
    stroke: #1b1b20;
    stroke-width: 1;
  }

  .link {
    stroke: var(--dim);
    stroke-width: 2.5;
    pointer-events: none;
  }

  .link.sel {
    stroke: var(--ok);
    stroke-width: 3.5;
  }

  .link-hit {
    stroke: transparent;
    stroke-width: 16;
    cursor: pointer;
  }

  .preview {
    stroke: var(--acc);
    stroke-width: 2;
    stroke-dasharray: 6 5;
    pointer-events: none;
  }

  .node {
    fill: var(--panel2);
    stroke: var(--line);
    stroke-width: 1.5;
  }

  .node-g {
    cursor: grab;
  }

  .node-g:hover .node,
  .node-g.sel .node {
    stroke: var(--acc);
  }

  .node-g.sel .node {
    stroke-width: 2.5;
  }

  .node-g.dragging {
    cursor: grabbing;
  }

  .nl {
    fill: var(--ink);
    font: 600 13px var(--sans);
    pointer-events: none;
  }

  .ns {
    font: 11px var(--mono);
    pointer-events: none;
  }

  .k-host {
    fill: var(--mut);
  }

  .k-switch {
    fill: var(--l2);
  }

  .k-router {
    fill: var(--acc);
  }

  .k-hub {
    fill: var(--warn);
  }

  .port-g {
    cursor: pointer;
  }

  .port {
    fill: var(--panel2);
    stroke: var(--dim);
    stroke-width: 1.5;
    transition:
      stroke 0.15s,
      fill 0.15s;
  }

  .port-core {
    fill: var(--dim);
    pointer-events: none;
  }

  .port-g:hover .port {
    stroke: var(--acc);
    fill: var(--sel);
  }

  .port-g.used .port {
    stroke: var(--ok);
  }

  .port-g.used .port-core {
    fill: var(--ok);
  }

  .port-g.armed .port {
    stroke: var(--acc);
    fill: var(--acc);
  }

  .port-g.armed .port-core {
    fill: var(--bg);
  }

  .plbl {
    fill: var(--mut);
    font: 9px var(--mono);
    opacity: 0;
    transition: opacity 0.15s;
    pointer-events: none;
  }

  .plbl.show {
    opacity: 1;
  }

  .palette {
    position: absolute;
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    max-height: calc(100% - 32px);
    overflow-y: auto;
    background: var(--card);
    border: 1px solid var(--line);
    z-index: 4;
  }

  .tool {
    width: 52px;
    height: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 4px;
    touch-action: none;
    user-select: none;
  }

  .tool .glyph {
    font-size: 18px;
    line-height: 1;
  }

  .tool small {
    font: 9px var(--mono);
    color: var(--mut);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .tool.on {
    border-color: var(--acc);
    background: var(--sel);
  }

  .tool:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .tool.on small {
    color: var(--acc);
  }

  .inspector {
    position: absolute;
    right: 16px;
    top: 16px;
    max-height: calc(100% - 32px);
    width: 360px;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--line);
    z-index: 4;
    overflow: hidden;
  }

  /* Align panel sits above the inspector body, so give it its own frame. */
  .inspector > .sec {
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }

  .ins-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }

  .ins-head h2 {
    margin: 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--mut);
  }

  .ins-body {
    padding: 12px;
    overflow: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .icon {
    padding: 2px 8px;
  }

  .mini {
    padding: 2px 8px;
    font-size: 11.5px;
  }

  .danger {
    border-color: var(--bad);
    color: var(--bad);
  }

  .danger:hover:not(:disabled) {
    background: var(--sel);
  }

  .danger-ghost {
    border-color: var(--line);
    color: var(--dim);
  }

  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--mut);
    margin: 0;
    font-weight: 600;
  }

  .sec {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .row.center {
    justify-content: center;
  }

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .grid3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
  }

  .fld {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--mut);
  }

  .fld input,
  .fld select {
    font: 12px var(--mono);
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    padding: 5px 7px;
    width: 100%;
    min-width: 0;
  }

  .fld input:focus,
  .fld select:focus {
    border-color: var(--acc);
    outline: none;
  }

  .fld input::placeholder {
    color: var(--dim);
  }

  .iface {
    border: 1px solid var(--line);
    margin: 0;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .iface legend {
    font: 11px var(--mono);
    color: var(--acc);
    padding: 0 4px;
  }

  .route {
    border: 1px solid var(--line);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pair {
    margin: 0;
    font-size: 12px;
    color: var(--ok);
    overflow-wrap: anywhere;
  }

  .actions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .actions li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border: 1px solid var(--line);
    padding: 5px 8px;
    font-size: 11.5px;
  }

  .actions li span {
    overflow-wrap: anywhere;
  }

  /* Named saves (F-130): one compact row per slot. */
  .slot-new {
    align-items: flex-end;
  }

  .slot-new .fld {
    flex: 1;
    min-width: 0;
  }

  .slot {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    padding: 4px 6px;
    font-size: 11.5px;
  }

  .slot-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .slot-when {
    color: var(--dim);
    font-size: 10.5px;
    white-space: nowrap;
  }

  .hint {
    color: var(--dim);
    font-size: 11.5px;
    margin: 0;
    line-height: 1.5;
  }

  .status {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
    min-height: 32px;
    padding: 4px 16px;
    border-top: 1px solid var(--line);
    background: var(--panel);
    font: 11.5px var(--mono);
    color: var(--mut);
  }

  .status > span:first-child {
    max-width: 62ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status .ok {
    color: var(--ok);
  }

  .status .bad {
    color: var(--bad);
  }

  .ghost {
    position: fixed;
    z-index: 50;
    transform: translate(-50%, -50%);
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--card);
    border: 1px solid var(--acc);
    color: var(--acc);
    font: 12px var(--mono);
  }

  .empty-card {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(440px, 80vw);
    background: var(--card);
    border: 1px solid var(--line);
    padding: 20px;
    text-align: center;
    z-index: 3;
  }

  .empty-card h2 {
    margin: 0 0 8px;
    font: 700 18px var(--disp);
    letter-spacing: 0.4px;
  }

  .empty-card p {
    color: var(--mut);
    font-size: 13px;
    line-height: 1.55;
    margin: 0 0 14px;
  }

  @media (prefers-reduced-motion: reduce) {
    .port,
    .plbl {
      transition: none;
    }
  }

  @media (max-width: 1100px) {
    .inspector {
      width: 320px;
    }

    .scen,
    .pill {
      display: none;
    }
  }

  @media (max-width: 860px) {
    .inspector {
      left: 12px;
      right: 12px;
      top: auto;
      bottom: 12px;
      width: auto;
      max-height: 46vh;
    }

    .palette {
      left: 12px;
      right: 12px;
      top: 12px;
      transform: none;
      flex-direction: row;
      overflow-x: auto;
    }

    .tool {
      flex: 0 0 auto;
    }

    .linkbtn {
      display: none;
    }
  }
</style>
