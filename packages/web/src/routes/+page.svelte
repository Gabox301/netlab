<script lang="ts">
import { onMount } from "svelte";
import { buildHexLines, buildPackets, type PacketRow } from "../lib/decode";
import type {
  InterfaceSnapshot,
  SimResult,
  WorkerRequest,
  WorkerResponse,
} from "../lib/sim-protocol";

type TabId = "inspector" | "terminal" | "tablas";

const TAB_ORDER: TabId[] = ["inspector", "terminal", "tablas"];
const TAB_LABEL: Record<TabId, string> = {
  inspector: "Inspector",
  terminal: "Terminal h1",
  tablas: "Tablas",
};
const LINK_MIDPOINTS: Record<string, { x: number; y: number }> = {
  "l-h1-r1": { x: 113, y: 110 },
  "l-r1-h2": { x: 187, y: 110 },
};
const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

let result = $state<SimResult | null>(null);
let error = $state<string | null>(null);
let loading = $state(true);
let autoPlayOnResult = true;
let selectedTraceIndex = $state(-1);
let scrubUs = $state(0);
let paused = $state(true);
let tab = $state<TabId>("inspector");
let showArp = $state(true);
let showIcmp = $state(true);
let hoverLayer = $state<string | null>(null);
let collapsed = $state<Record<string, boolean>>({});

let worker: Worker | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const packets = $derived(result ? buildPackets(result.traces) : []);
const visiblePackets = $derived(
  packets.filter((packet) =>
    packet.decoded.protocol === "ARP" ? showArp : showIcmp,
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
  result && selectedTraceIndex >= 0
    ? (result.traces[selectedTraceIndex] ?? null)
    : null,
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
const dotPosition = $derived(
  activeLink ? (LINK_MIDPOINTS[activeLink] ?? null) : null,
);
const hexLines = $derived(
  selectedPacket
    ? buildHexLines(selectedPacket.decoded.hex, selectedPacket.decoded.layers)
    : [],
);
const horizon = $derived(result?.horizonUs ?? 10_000);

onMount(() => {
  startWorker();
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
  if (message.kind === "error") {
    handleWorkerError(message.message);
    return;
  }
  const run = message.result;
  const next = buildPackets(run.traces);
  result = run;
  loading = false;
  error = null;
  const firstIcmp = next.findIndex(
    (packet) => packet.decoded.protocol === "ICMP",
  );
  const initial = next[Math.max(firstIcmp, 0)] ?? null;
  selectedTraceIndex = initial?.traceIndex ?? -1;
  scrubUs = initial?.t ?? 0;
  if (autoPlayOnResult && next.length > 0) {
    playFromList(next, 0);
  } else {
    stopTimer();
    paused = true;
  }
}

function handleWorkerError(message: string): void {
  error = message;
  loading = false;
  stopTimer();
  paused = true;
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function selectPacket(packet: PacketRow): void {
  selectedTraceIndex = packet.traceIndex;
  scrubUs = packet.t;
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
  stopTimer();
  paused = false;
  selectPacket(target);
  timer = setInterval(advance, 900);
}

function advance(): void {
  const list = packets;
  if (list.length === 0) {
    stopTimer();
    paused = true;
    return;
  }
  const index = list.findIndex(
    (packet) => packet.traceIndex === selectedTraceIndex,
  );
  const next = list[index + 1];
  if (next === undefined) {
    stopTimer();
    paused = true;
    return;
  }
  selectPacket(next);
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
  const list = packets;
  if (list.length === 0) {
    return;
  }
  const index = list.findIndex(
    (packet) => packet.traceIndex === selectedTraceIndex,
  );
  playFromList(list, Math.max(index, 0));
}

function step(): void {
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
  const next = list[index < 0 ? 0 : (index + 1) % list.length];
  if (next !== undefined) {
    selectPacket(next);
  }
}

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
  selectedTraceIndex = chosen?.traceIndex ?? -1;
}

function toggleLayer(id: string): void {
  collapsed[id] = !collapsed[id];
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
  return packet.decoded.isError ? "b-err" : "b-echo";
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

<div class="shell">
  <header class="top">
    <div class="logo">Net<b>Lab</b></div>
    <div class="scen mono">
      {result?.scenario ?? "dos-subredes"}.json · seed {result?.seed ?? 11}
    </div>
    <div class="sp"></div>
    <div class="simtime mono" role="timer" aria-label="Tiempo virtual">
      t = {scrubUs} µs
    </div>
    <button
      class="primary"
      type="button"
      onclick={() => requestRun(true)}
      disabled={loading}
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
    <button type="button" onclick={step} disabled={result === null}>
      ⏭ Step
    </button>
  </header>

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

          {#if dotPosition}
            <circle
              class="pkt"
              cx={dotPosition.x}
              cy={dotPosition.y}
              r="5"
            ></circle>
          {/if}
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
    </section>

    <section class="col packets-col" aria-label="Paquetes">
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
        </span>
      </h2>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {:else if loading && result === null}
        <p class="empty">Ejecutando dos-subredes en el worker…</p>
      {/if}

      <div class="table-wrap">
        <table class="pkts" aria-label="Lista cronológica de frames">
          <thead>
            <tr>
              <th>t (µs)</th>
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
                <td>{packet.decoded.summary}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="timeline">
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
                  <dl>
                    {#each layer.rows as [label, value]}
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    {/each}
                  </dl>
                {/if}
              </div>
            {/each}

            <pre class="hex" aria-label="Volcado hexadecimal del frame">{#each hexLines as line, index (index)}<span class="hexline">{#each line as token}<b class={token.layer} class:lit={hoverLayer === token.layer}>{token.text}</b>{" "}{/each}</span>{/each}</pre>
            <p class="hint">
              Pasá el mouse por una capa para marcar sus bytes.
            </p>
          {:else}
            <p class="empty">
              Sin frame seleccionado. Corré la simulación o mové el scrubber.
            </p>
          {/if}
        {:else if tab === "terminal"}
          {#if result}
            <pre class="terminal" aria-label="Terminal del host h1"><span
                class="prompt">h1$ traceroute 10.0.1.2</span
              >{#each result.transcript as line, index (index)}<span
                  class="term-line"
                  class:hop={/^\d+ {2}/.test(line)}>{line}</span
                >{/each}<span class="prompt">h1$ </span><span class="cursor"
                >▌</span
              ></pre>
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

  <footer class="status">
    <span>
      eventos <b>{result?.events ?? "—"}</b> · trazas
      <b>{result?.traceCount ?? "—"}</b>
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
    --dim: #80808c;
    --acc: #ff4d3d;
    --ok: #4dff9a;
    --warn: #ffd23d;
    --bad: #ff4d3d;
    --sel: #2e1512;
    --code: #050506;
    --l2: #3dc8ff;
    --l3: #ff4d3d;
    --l4: #ffd23d;
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

  .simtime {
    color: var(--ok);
    font-size: 12.5px;
    min-width: 118px;
    text-align: right;
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

  .pkt {
    fill: var(--ok);
    stroke: var(--bg);
    stroke-width: 1.5;
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

  .b-echo {
    color: var(--ok);
  }

  .b-arp {
    color: var(--warn);
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

  .layer dl {
    margin: 0;
    padding: 8px 12px;
    display: grid;
    grid-template-columns: 104px 1fr;
    gap: 3px 10px;
    font-family: var(--mono);
    font-size: 12px;
  }

  .layer dt {
    color: var(--mut);
  }

  .layer dd {
    margin: 0;
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

  .hex b.pad {
    color: var(--dim);
  }

  .hex b.lit {
    background: color-mix(in srgb, currentColor 22%, transparent);
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

  .terminal {
    font: 12px/1.7 var(--mono);
    background: var(--code);
    border: 1px solid var(--line);
    padding: 10px 12px;
    overflow: auto;
    margin: 0;
    white-space: pre-wrap;
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

  .cursor {
    color: var(--mut);
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
</style>
