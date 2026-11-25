<script lang="ts">
import { Mulberry32 } from "@netlab/core";
import {
  generateSubnetProblem,
  isSubnetTopic,
  SUBNET_TOPICS,
  type SubnetCheck,
  type SubnetProblem,
  type SubnetTopic,
} from "@netlab/exercises";
import { onMount } from "svelte";
import {
  emptyPracticeStore,
  emptyProgress,
  loadPracticeProgress,
  PRACTICE_EXERCISES,
  PRACTICE_ROUTES,
  type PracticeProgress,
  type PracticeProgressStore,
  type PracticeRoute,
  practiceExercise,
  practiceLocation,
  progressOf,
  recordAttempt,
  savePracticeProgress,
  scoreOf,
} from "../../lib/practice";
import type {
  ExecResponse,
  ValidateResponse,
  WorkerRequest,
  WorkerResponse,
} from "../../lib/sim-protocol";

/** Spanish label per drill theme, in the shell's order. */
const TOPIC_LABEL: Record<SubnetTopic, string> = {
  cidr: "CIDR",
  vlsm: "VLSM",
  summary: "Resumen de rutas",
  usable: "Rango útil",
};

/** Ethernet address as the shell's `send` wants it. */
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
/** Whole bytes only: the shell rejects an odd number of hex digits. */
const HEX_PAYLOAD = /^(?:[0-9a-f]{2})+$/i;
/** Default frame: broadcast IPv4 with a short payload (gets padded). */
const SEND_DEFAULTS = {
  iface: "eth0",
  dstmac: "ff:ff:ff:ff:ff:ff",
  ethertype: "0x0800",
  hex: "deadbeef",
};

type TermKind = "cmd" | "out" | "err";

interface TermLine {
  kind: TermKind;
  text: string;
}

/** Score and hints captured when `validar` was pressed. */
interface PendingAttempt {
  score: number;
  hintsRevealed: number;
  startedAt: number;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/* -------------------------------------------------------------------------- */
/* Progress state (F-113, F-114)                                              */
/* -------------------------------------------------------------------------- */

let store = $state<PracticeProgressStore>(emptyPracticeStore());
let selectedId = $state<string | null>(null);
/** Most hints revealed in the current visit; starts at the stored maximum. */
let revealed = $state(0);
let solution = $state<unknown | null>(null);
let solutionName = $state("");
let solutionError = $state<string | null>(null);
let validating = $state(false);
let verdict = $state<ValidateResponse | null>(null);
let pendingAttempt: PendingAttempt | null = null;
let attemptStart = 0;
let fileInput = $state<HTMLInputElement | null>(null);

const selected = $derived(
  selectedId === null ? null : (practiceExercise(selectedId) ?? null),
);
const location = $derived(
  selectedId === null ? undefined : practiceLocation(selectedId),
);
const progress = $derived(
  selectedId === null ? emptyProgress() : progressOf(store, selectedId),
);
const currentScore = $derived(
  selected === null ? 100 : scoreOf(selected.hints, revealed),
);
const solved = $derived(
  PRACTICE_EXERCISES.filter(
    (exercise) => progressOf(store, exercise.id).passedAt !== null,
  ).length,
);

function openExercise(id: string): void {
  const exercise = practiceExercise(id);
  if (exercise === undefined) {
    return;
  }
  selectedId = id;
  revealed = progressOf(store, id).hintsRevealed;
  resetAttempt();
  attemptStart = performance.now();
}

function closeExercise(): void {
  selectedId = null;
  resetAttempt();
}

function resetAttempt(): void {
  solution = null;
  solutionName = "";
  solutionError = null;
  verdict = null;
  validating = false;
  pendingAttempt = null;
}

function revealHint(): void {
  if (selected === null || revealed >= selected.hints.length) {
    return;
  }
  revealed += 1;
}

function formatMs(ms: number): string {
  if (ms < 1_000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

function passedLabel(iso: string | null): string {
  return iso === null
    ? "sin resolver"
    : new Date(iso).toLocaleString("es-AR", {
        dateStyle: "short",
        timeStyle: "short",
      });
}

function routeSolved(route: PracticeRoute): number {
  return route.levels.reduce(
    (total, level) =>
      total +
      level.exercises.filter((id) => progressOf(store, id).passedAt !== null)
        .length,
    0,
  );
}

function routeSize(route: PracticeRoute): number {
  return route.levels.reduce(
    (total, level) => total + level.exercises.length,
    0,
  );
}

function bestLabel(entry: PracticeProgress): string {
  if (entry.passedAt !== null) {
    return `✓ ${entry.bestScore ?? 0} pts`;
  }
  return entry.attempts > 0
    ? `mejor ${entry.bestScore ?? 0} pts`
    : "sin intentos";
}

/* -------------------------------------------------------------------------- */
/* Worker: validation (F-112) and the F-101 frame sender                      */
/* -------------------------------------------------------------------------- */

let worker: Worker | null = null;
let workerReady = $state(false);
let workerError = $state<string | null>(null);

onMount(() => {
  store = loadPracticeProgress();
  startWorker();
  newSubnetDrill("cidr");
  return () => {
    worker?.terminate();
    worker = null;
  };
});

function startWorker(): void {
  try {
    worker = new Worker(new URL("../../lib/sim.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      handleMessage(event.data);
    };
    worker.onerror = (event) => {
      workerReady = false;
      workerError = event.message || "error en el worker";
    };
    workerReady = true;
  } catch (cause) {
    workerReady = false;
    workerError = messageOf(cause);
  }
}

function handleMessage(message: WorkerResponse): void {
  if (message.kind === "exec") {
    handleExec(message);
    return;
  }
  if (message.kind === "validate") {
    handleValidate(message);
    return;
  }
  if (message.kind === "error") {
    validating = false;
    sending = false;
    workerError = message.message;
    return;
  }
  // kind === "result": this page never requests a full run.
}

async function onSolutionFile(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) {
    return;
  }
  solutionName = file.name;
  solutionError = null;
  solution = null;
  verdict = null;
  try {
    solution = JSON.parse(await file.text()) as unknown;
  } catch (cause) {
    solutionError = `${file.name} no es JSON: ${messageOf(cause)}`;
  } finally {
    // Allow re-selecting the same file after fixing it outside the browser.
    input.value = "";
  }
}

function validateSolution(): void {
  const exercise = selected;
  if (exercise === null || solution === null || worker === null) {
    return;
  }
  validating = true;
  verdict = null;
  solutionError = null;
  pendingAttempt = {
    score: currentScore,
    hintsRevealed: revealed,
    startedAt: attemptStart,
  };
  const request: WorkerRequest = {
    type: "validate",
    exercise,
    solution,
  };
  worker.postMessage(request);
}

function handleValidate(message: ValidateResponse): void {
  validating = false;
  verdict = message;
  if (message.error !== null) {
    pendingAttempt = null;
    return;
  }
  const exercise = selected;
  const attempt = pendingAttempt;
  pendingAttempt = null;
  if (exercise === null || attempt === null) {
    return;
  }
  store = recordAttempt(store, exercise.id, {
    pass: message.pass,
    score: attempt.score,
    hintsRevealed: attempt.hintsRevealed,
    elapsedMs: Math.round(performance.now() - attempt.startedAt),
  });
  savePracticeProgress(store);
  attemptStart = performance.now();
}

/* -------------------------------------------------------------------------- */
/* F-101: hand-built Ethernet frame                                           */
/* -------------------------------------------------------------------------- */

let sendDraft = $state({ ...SEND_DEFAULTS });
let sending = $state(false);
let sendLines = $state<Array<TermLine>>([]);

function parseEtherType(text: string): number | null {
  const trimmed = text.trim();
  const value = /^0x[0-9a-f]+$/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : /^[0-9]+$/.test(trimmed)
      ? Number.parseInt(trimmed, 10)
      : Number.NaN;
  return Number.isInteger(value) && value >= 0 && value <= 0xffff
    ? value
    : null;
}

/** Why the form cannot compile to `send`, or null when it can. */
const sendError = $derived.by((): string | null => {
  const draft = sendDraft;
  if (draft.iface.trim() === "") {
    return "La interfaz no puede quedar vacía.";
  }
  if (!MAC.test(draft.dstmac.trim())) {
    return "La MAC destino son seis grupos de dos hex: aa:bb:cc:dd:ee:ff.";
  }
  if (parseEtherType(draft.ethertype) === null) {
    return "El ethertype va de 0 a 0xffff (0x0800 = IPv4).";
  }
  if (!HEX_PAYLOAD.test(draft.hex.trim())) {
    return "El payload es hex de bytes completos, por ejemplo deadbeef.";
  }
  return null;
});

/** The exact `send ...` line the worker will execute on h1. */
const sendCommand = $derived.by((): string | null => {
  if (sendError !== null) {
    return null;
  }
  const etherType = parseEtherType(sendDraft.ethertype);
  if (etherType === null) {
    return null;
  }
  return (
    `send ${sendDraft.iface.trim()} ${sendDraft.dstmac.trim().toLowerCase()} ` +
    `0x${etherType.toString(16).padStart(4, "0")} ` +
    sendDraft.hex.trim().toLowerCase()
  );
});

function sendFrame(): void {
  const command = sendCommand;
  if (command === null || worker === null || sending) {
    return;
  }
  sending = true;
  workerError = null;
  sendLines = [...sendLines, { kind: "cmd", text: command }];
  worker.postMessage({ type: "exec", host: "h1", cmd: command });
}

function handleExec(message: ExecResponse): void {
  sending = false;
  const entries: Array<TermLine> = message.lines.map((text) => ({
    kind: "out",
    text,
  }));
  if (message.error !== null) {
    entries.push({ kind: "err", text: message.error });
  }
  sendLines = [...sendLines, ...entries];
}

/* -------------------------------------------------------------------------- */
/* F-117: subnetting trainer                                                  */
/* -------------------------------------------------------------------------- */

let subnetTopic = $state<SubnetTopic>("cidr");
let subnetProblem = $state<SubnetProblem | null>(null);
let subnetAnswer = $state("");
let subnetCheck = $state<SubnetCheck | null>(null);

function newSubnetDrill(topic: SubnetTopic): void {
  subnetTopic = topic;
  // UI-only randomness: the generator itself stays pure and seeded, so a
  // captured seed would replay the same drill.
  const seed = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
  const random = new Mulberry32(seed);
  subnetProblem = generateSubnetProblem(topic, () => random.next());
  subnetAnswer = "";
  subnetCheck = null;
}

function onSubnetTopic(event: Event): void {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (isSubnetTopic(value)) {
    newSubnetDrill(value);
  }
}

function submitSubnet(event: SubmitEvent): void {
  event.preventDefault();
  if (subnetProblem === null) {
    return;
  }
  subnetCheck = subnetProblem.check(subnetAnswer);
}
</script>

<svelte:head>
  <title>NetLab · Práctica</title>
  <meta
    name="description"
    content="Rutas de aprendizaje, pistas con penalización y validación automática de ejercicios NetLab."
  />
</svelte:head>

<div class="shell">
  <header class="top">
    <div class="logo">Net<b>Lab</b></div>
    <div class="scen mono">
      modo práctica · {PRACTICE_ROUTES.length} rutas · {PRACTICE_EXERCISES.length}
      ejercicios
    </div>
    <a class="navlink" href="/">← Workbench</a>
    <a class="navlink" href="/editor">Editor →</a>
    <div class="sp"></div>
    <span class="counter mono">{solved}/{PRACTICE_EXERCISES.length} resueltos</span>
    <span
      class="pill local"
      title="El puntaje, los intentos y el tiempo viven en localStorage de este navegador."
    >
      guardado local
    </span>
  </header>

  {#if selected === null}
    <main class="routes">
      <section class="intro">
        <h1>Rutas de aprendizaje</h1>
        <p class="lede">
          Cuatro recorridos sobre los 25 ejercicios del catálogo. Cada ejercicio
          se valida en el navegador con el mismo motor que
          <code>netlab validate</code>: topología real, tráfico real y checks
          sobre las trazas.
        </p>
        <p class="lede dim">
          Las pistas restan puntaje y el progreso queda en este navegador.
          Armá la solución en el editor, exportá el JSON v1 y subilo en el
          detalle del ejercicio.
        </p>
        {#if workerError !== null}
          <p class="banner err">Worker: {workerError}</p>
        {/if}
      </section>

      {#each PRACTICE_ROUTES as route (route.id)}
        <section class="route">
          <header class="route-head">
            <div>
              <h2>{route.title}</h2>
              <p class="route-summary">{route.summary}</p>
            </div>
            <span class="pill">
              {routeSolved(route)}/{routeSize(route)} resueltos
            </span>
          </header>

          {#each route.levels as level (level.level)}
            <div class="level">
              <h3 class="level-title">
                <span class="level-number mono">N{level.level}</span>
                {level.title}
              </h3>
              <div class="exercise-grid">
                {#each level.exercises as id (id)}
                  {@const exercise = practiceExercise(id)}
                  {#if exercise !== undefined}
                    {@const entry = progressOf(store, id)}
                    <button
                      class="exercise"
                      type="button"
                      onclick={() => openExercise(id)}
                    >
                      <span class="exercise-title">{exercise.title}</span>
                      <span class="exercise-meta">
                        <span class="kind">{exercise.kind}</span>
                        <span class:ok={entry.passedAt !== null}>
                          {bestLabel(entry)}
                        </span>
                      </span>
                      <span class="exercise-objective">
                        {exercise.objective}
                      </span>
                    </button>
                  {/if}
                {/each}
              </div>
            </div>
          {/each}
        </section>
      {/each}

      <section class="tools">
        <article class="tool">
          <h2>Constructor de tramas <span class="tag">F-101</span></h2>
          <p class="tool-lede">
            Armá un frame Ethernet a mano y ejecutalo en h1 con
            <code>send</code>. L2 + payload hex es el MVP: sin resolución ARP,
            sin ruta y sin flags de capa 3.
          </p>
          <div class="send-grid">
            <label class="field">
              <span>iface</span>
              <input bind:value={sendDraft.iface} spellcheck="false" />
            </label>
            <label class="field">
              <span>dstmac</span>
              <input bind:value={sendDraft.dstmac} spellcheck="false" />
            </label>
            <label class="field">
              <span>ethertype</span>
              <input bind:value={sendDraft.ethertype} spellcheck="false" />
            </label>
            <label class="field wide">
              <span>payload hex</span>
              <input bind:value={sendDraft.hex} spellcheck="false" />
            </label>
          </div>
          <p class="command mono">
            {sendCommand ?? "—"}
          </p>
          {#if sendError !== null}
            <p class="banner err">{sendError}</p>
          {/if}
          <div class="tool-actions">
            <button
              class="primary"
              type="button"
              onclick={sendFrame}
              disabled={sending || !workerReady || sendCommand === null}
            >
              {sending ? "Enviando…" : "▶ Enviar a h1"}
            </button>
            <button
              type="button"
              onclick={() => (sendLines = [])}
              disabled={sendLines.length === 0}
            >
              Limpiar
            </button>
          </div>
          {#if sendLines.length > 0}
            <div class="send-log mono">
              {#each sendLines as line, index (index)}
                <div class="line" class:err={line.kind === "err"}>
                  {#if line.kind === "cmd"}
                    <span class="prompt">h1$</span>
                  {/if}
                  {line.text}
                </div>
              {/each}
            </div>
          {/if}
        </article>

        <article class="tool">
          <h2>Trainer de subnetting <span class="tag">F-117</span></h2>
          <p class="tool-lede">
            Un drill puro en el navegador: escribí las respuestas separadas por
            espacios y mirá la corrección paso a paso.
          </p>
          <div class="quiz-head">
            <label class="field">
              <span>tema</span>
              <select value={subnetTopic} onchange={onSubnetTopic}>
                {#each SUBNET_TOPICS as topic (topic)}
                  <option value={topic}>{TOPIC_LABEL[topic]}</option>
                {/each}
              </select>
            </label>
            <button
              type="button"
              onclick={() => newSubnetDrill(subnetTopic)}
            >
              ⟳ Otro ejercicio
            </button>
          </div>

          {#if subnetProblem !== null}
            <p class="prompt-line">{subnetProblem.title}</p>
            <p class="quiz-prompt">{subnetProblem.prompt}</p>
            <div class="fields">
              {#each subnetProblem.fields as field (field)}
                <span class="chip mono">{field}</span>
              {/each}
            </div>
            <form class="quiz-form" onsubmit={submitSubnet}>
              <input
                bind:value={subnetAnswer}
                placeholder={subnetProblem.fields.join(" ")}
                spellcheck="false"
                aria-label="Respuesta del drill"
              />
              <button class="primary" type="submit">Corregir</button>
            </form>
            {#if subnetCheck !== null}
              <p class="banner" class:ok={subnetCheck.pass} class:err={!subnetCheck.pass}>
                {subnetCheck.pass
                  ? "✓ Correcto"
                  : `✕ Incorrecto · esperado: ${subnetCheck.expected}`}
              </p>
              <ol class="steps">
                {#each subnetCheck.steps as step, index (index)}
                  <li>{step}</li>
                {/each}
              </ol>
            {/if}
          {/if}
        </article>
      </section>
    </main>
  {:else}
    <main class="detail">
      <div class="detail-bar">
        <button type="button" onclick={closeExercise}>← Rutas</button>
        {#if location !== undefined}
          <span class="crumb mono">
            {location.route.title} · N{location.level.level} ·
            {location.level.title}
          </span>
        {/if}
        <div class="sp"></div>
        <span class="chip mono">{selected.kind}</span>
        <span class="pill local">guardado local</span>
      </div>

      <header class="detail-head">
        <h1>{selected.title}</h1>
        <p class="objective">{selected.objective}</p>
      </header>

      <div class="detail-grid">
        <section class="card">
          <h2>Pistas graduadas <span class="tag">F-113</span></h2>
          <p class="card-lede">
            Cada pista resta su penalización. Puntaje actual:
            <strong class="score mono">{currentScore} pts</strong>.
          </p>
          <ol class="hints">
            {#each selected.hints as hint, index (hint.level)}
              <li class="hint" class:locked={index >= revealed}>
                <div class="hint-head">
                  <span class="level-number mono">P{hint.level}</span>
                  <span class="penalty mono">−{hint.penalty} pts</span>
                </div>
                {#if index < revealed}
                  <p>{hint.text}</p>
                {:else}
                  <p class="dim">Pista bloqueada.</p>
                {/if}
              </li>
            {/each}
          </ol>
          <button
            type="button"
            onclick={revealHint}
            disabled={revealed >= selected.hints.length}
          >
            {revealed >= selected.hints.length
              ? "Todas las pistas reveladas"
              : `Revelar pista (nivel ${revealed + 1}, −${selected.hints[revealed]?.penalty ?? 0} pts)`}
          </button>
        </section>

        <aside class="card side">
          <h2>Progreso <span class="tag">F-114</span></h2>
          <dl class="stats">
            <div>
              <dt>Intentos</dt>
              <dd class="mono">{progress.attempts}</dd>
            </div>
            <div>
              <dt>Mejor puntaje</dt>
              <dd class="mono">
                {progress.bestScore === null ? "—" : `${progress.bestScore} pts`}
              </dd>
            </div>
            <div>
              <dt>Pistas usadas</dt>
              <dd class="mono">{progress.hintsRevealed}</dd>
            </div>
            <div>
              <dt>Tiempo</dt>
              <dd class="mono">{formatMs(progress.elapsedMs)}</dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd class:ok={progress.passedAt !== null}>
                {passedLabel(progress.passedAt)}
              </dd>
            </div>
          </dl>
          <p class="dim small">
            Este intento vale {currentScore} pts y el reloj corre desde que
            abriste el ejercicio.
          </p>
        </aside>

        <section class="card validation">
          <h2>Validar solución <span class="tag">F-112</span></h2>
          <p class="card-lede">
            Exportá la topología desde el <a href="/editor">editor</a> y subí
            el JSON v1. El worker corre la simulación con el mismo
            <code>runScenario</code> que <code>netlab validate</code> y devuelve
            los checks, no un replay.
          </p>
          <div class="upload">
            <input
              class="file"
              type="file"
              accept=".json,application/json"
              bind:this={fileInput}
              onchange={onSolutionFile}
            />
            <button type="button" onclick={() => fileInput?.click()}>
              Elegir solución JSON
            </button>
            <span class="file-name mono">
              {solutionName === "" ? "ningún archivo" : solutionName}
            </span>
            <button
              class="primary"
              type="button"
              onclick={validateSolution}
              disabled={solution === null || validating || !workerReady}
            >
              {validating ? "Validando…" : "Validar"}
            </button>
          </div>
          {#if solutionError !== null}
            <p class="banner err">{solutionError}</p>
          {/if}
          {#if workerError !== null}
            <p class="banner err">Worker: {workerError}</p>
          {/if}

          {#if verdict !== null}
            {#if verdict.error !== null}
              <p class="banner err">{verdict.error}</p>
            {:else}
              {@const passed = verdict.checks.filter((check) => check.pass).length}
              <p class="banner" class:ok={verdict.pass} class:err={!verdict.pass}>
                {verdict.pass ? "✓ PASS" : "✕ FAIL"} · {passed}/{verdict.checks.length}
                checks
                {#if verdict.run !== null}
                  <span class="mono run-meta">
                    seed {verdict.run.seed} · t={verdict.run.finalTime} µs ·
                    {verdict.run.processed} eventos
                  </span>
                {/if}
              </p>
              <ul class="checks">
                {#each verdict.checks as check, index (index)}
                  <li class:ok={check.pass} class:err={!check.pass}>
                    <span class="check-mark">{check.pass ? "✓" : "✕"}</span>
                    <span class="check-name">{check.name}</span>
                    <span class="check-detail">{check.detail}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </section>
      </div>
    </main>
  {/if}
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
    --code: #050506;
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

  :global(a) {
    color: var(--acc);
  }

  code,
  .mono {
    font-family: var(--mono);
  }

  code {
    color: var(--warn);
    font-size: 0.92em;
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

  .counter {
    color: var(--ok);
    font-size: 12.5px;
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

  .pill {
    border: 1px solid var(--line);
    background: var(--panel2);
    color: var(--mut);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11.5px;
    white-space: nowrap;
  }

  .pill.local {
    border-color: #3c5c46;
    color: var(--ok);
  }

  .tag {
    font: 600 10.5px var(--mono);
    letter-spacing: 0.4px;
    color: var(--acc);
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 1px 5px;
    vertical-align: middle;
  }

  .routes,
  .detail {
    width: 100%;
    max-width: 1080px;
    margin: 0 auto;
    padding: 22px 18px 64px;
  }

  .routes {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .intro h1,
  .detail-head h1 {
    font: 700 30px var(--disp);
    letter-spacing: 0.5px;
    margin: 0 0 8px;
    text-transform: uppercase;
  }

  .lede {
    margin: 0 0 8px;
    color: var(--mut);
    max-width: 72ch;
    line-height: 1.5;
  }

  .dim {
    color: var(--dim);
  }

  .small {
    font-size: 12px;
    line-height: 1.45;
  }

  .route {
    border: 1px solid var(--line);
    background: var(--panel);
  }

  .route-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--line);
  }

  .route-head h2 {
    margin: 0;
    font: 700 20px var(--disp);
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }

  .route-summary {
    margin: 4px 0 0;
    color: var(--mut);
    font-size: 13px;
    max-width: 72ch;
  }

  .level {
    padding: 12px 18px 16px;
    border-top: 1px solid var(--line);
  }

  .level:first-of-type {
    border-top: 0;
  }

  .level-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 10px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--mut);
  }

  .level-number {
    color: var(--acc);
    font-size: 11.5px;
    border: 1px solid var(--line);
    padding: 1px 6px;
    border-radius: 3px;
  }

  .exercise-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
  }

  .exercise {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
    padding: 12px 13px;
    background: var(--panel2);
    border: 1px solid var(--line);
  }

  .exercise:hover {
    border-color: var(--acc);
  }

  .exercise-title {
    font-weight: 650;
    line-height: 1.3;
  }

  .exercise-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11.5px;
    color: var(--dim);
  }

  .exercise-meta .ok {
    color: var(--ok);
  }

  .kind {
    color: var(--warn);
    font-family: var(--mono);
    font-size: 10.5px;
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 1px 5px;
    text-transform: uppercase;
  }

  .exercise-objective {
    color: var(--mut);
    font-size: 12.5px;
    line-height: 1.4;
  }

  .banner {
    margin: 10px 0 0;
    border: 1px solid var(--line);
    background: var(--panel2);
    padding: 8px 11px;
    font-size: 12.5px;
  }

  .banner.ok {
    border-color: #3c5c46;
    background: #0f1a13;
    color: var(--ok);
  }

  .banner.err {
    border-color: #6a2b26;
    background: #1c100f;
    color: #ff8a7f;
  }

  .tools {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
    gap: 16px;
    margin-top: 8px;
  }

  .tool {
    border: 1px solid var(--line);
    background: var(--panel);
    padding: 16px 18px;
  }

  .tool h2 {
    margin: 0 0 8px;
    font: 700 17px var(--disp);
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }

  .tool-lede {
    margin: 0 0 12px;
    color: var(--mut);
    font-size: 13px;
    line-height: 1.45;
  }

  .send-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11.5px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .field.wide {
    grid-column: 1 / -1;
  }

  .field input,
  .field select,
  .quiz-form input {
    font: 12.5px var(--mono);
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 7px 8px;
    width: 100%;
  }

  .command {
    margin: 12px 0 0;
    padding: 9px 11px;
    background: var(--code);
    border: 1px solid var(--line);
    color: var(--ok);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .tool-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .primary {
    border-color: var(--acc);
    background: #2b1512;
  }

  .send-log {
    margin-top: 12px;
    background: var(--code);
    border: 1px solid var(--line);
    padding: 9px 11px;
    font-size: 12px;
    max-height: 220px;
    overflow: auto;
  }

  .send-log .line {
    color: var(--mut);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 1px 0;
  }

  .send-log .line.err {
    color: #ff8a7f;
  }

  .send-log .prompt {
    color: var(--ok);
    margin-right: 6px;
  }

  .quiz-head {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: 12px;
  }

  .prompt-line {
    margin: 0 0 6px;
    font-weight: 650;
  }

  .quiz-prompt {
    margin: 0 0 10px;
    color: var(--mut);
    line-height: 1.5;
  }

  .fields {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .chip {
    border: 1px solid var(--line);
    background: var(--panel2);
    color: var(--warn);
    padding: 1px 7px;
    border-radius: 3px;
    font-size: 11.5px;
  }

  .quiz-form {
    display: flex;
    gap: 8px;
  }

  .steps {
    margin: 10px 0 0;
    padding-left: 20px;
    color: var(--mut);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .detail-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  .crumb {
    color: var(--mut);
    font-size: 12px;
  }

  .detail-head {
    margin-bottom: 16px;
  }

  .objective {
    margin: 0;
    color: var(--mut);
    max-width: 78ch;
    line-height: 1.55;
    font-size: 14.5px;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(280px, 1fr);
    gap: 14px;
    align-items: start;
  }

  .card {
    border: 1px solid var(--line);
    background: var(--panel);
    padding: 16px 18px;
  }

  .card h2 {
    margin: 0 0 8px;
    font: 700 17px var(--disp);
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }

  .card-lede {
    margin: 0 0 12px;
    color: var(--mut);
    font-size: 13px;
    line-height: 1.45;
  }

  .score {
    color: var(--ok);
  }

  .hints {
    list-style: none;
    margin: 0 0 14px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .hint {
    border: 1px solid var(--line);
    background: var(--panel2);
    padding: 9px 11px;
  }

  .hint.locked {
    border-style: dashed;
  }

  .hint p {
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.5;
  }

  .hint-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .penalty {
    color: var(--warn);
    font-size: 11.5px;
  }

  .side {
    grid-row: span 2;
  }

  .stats {
    margin: 0 0 12px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 12px;
    font-size: 13px;
  }

  .stats div {
    display: contents;
  }

  .stats dt {
    color: var(--dim);
  }

  .stats dd {
    margin: 0;
    text-align: right;
    color: var(--ink);
  }

  .stats dd.ok {
    color: var(--ok);
  }

  .upload {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .file {
    display: none;
  }

  .file-name {
    color: var(--mut);
    font-size: 12px;
  }

  .run-meta {
    display: block;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--mut);
  }

  .checks {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .checks li {
    display: grid;
    grid-template-columns: 18px minmax(180px, 1fr) minmax(0, 1.6fr);
    gap: 8px;
    align-items: start;
    border: 1px solid var(--line);
    background: var(--panel2);
    padding: 7px 9px;
    font-size: 12.5px;
  }

  .checks li.ok .check-mark {
    color: var(--ok);
  }

  .checks li.err .check-mark {
    color: var(--bad);
  }

  .check-name {
    font-weight: 600;
  }

  .check-detail {
    color: var(--mut);
  }

  @media (max-width: 820px) {
    .detail-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .side {
      grid-row: auto;
    }

    .send-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }

    .checks li {
      grid-template-columns: 18px minmax(0, 1fr);
    }

    .check-detail {
      grid-column: 2;
    }
  }
</style>
