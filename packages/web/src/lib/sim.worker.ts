/**
 * Simulation worker (S3, S10): runs the fixed two-subnet lab off the main
 * thread and keeps one interactive shell session per host, so the terminal
 * tab can run commands against the same live lab the UI is inspecting. It
 * also validates practice solutions (F-112) with the exact runner
 * `netlab validate` uses. It imports only `@netlab/*` engine packages — never
 * SvelteKit or client UI code.
 */

import {
  parseScenarioJson,
  runScenario as runExerciseScenario,
  type Scenario,
} from "@netlab/cli";
import type { Host } from "@netlab/core";
import {
  parseExerciseJson,
  prepareScenario,
  validateExercise,
} from "@netlab/exercises";
import { Shell } from "@netlab/shell";
import {
  buildLab,
  type Lab,
  runScenario,
  SEED,
  serializeTrace,
} from "./scenario";
import type {
  ExecResponse,
  WorkerRequest,
  WorkerResponse,
} from "./sim-protocol";

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

/** Lab driven by `exec`; rebuilt lazily after every `run`. */
let lab: Lab | null = null;
/** One shell per host id: its constructor chains the host callbacks. */
const shells = new Map<string, Shell>();

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Lazily build the lab the interactive shells drive. */
function session(): Lab {
  lab ??= buildLab(SEED);
  return lab;
}

/** Only hosts run a shell in this slice: the router has none yet. */
function hostFor(active: Lab, id: string): Host | null {
  if (id === active.h1.id) {
    return active.h1;
  }
  if (id === active.h2.id) {
    return active.h2;
  }
  return null;
}

function shellFor(active: Lab, id: string): Shell | null {
  const host = hostFor(active, id);
  if (host === null) {
    return null;
  }
  const cached = shells.get(id);
  if (cached !== undefined) {
    return cached;
  }
  const shell = new Shell({ host, sim: active.sim });
  shells.set(id, shell);
  return shell;
}

async function handleRun(): Promise<void> {
  // `run` restarts the interactive session: the live lab and its shells are
  // dropped, so the terminal output on screen is history, not live state.
  lab = null;
  shells.clear();
  try {
    const result = await runScenario();
    scope.postMessage({ kind: "result", result });
  } catch (cause) {
    scope.postMessage({ kind: "error", message: errorMessage(cause) });
  }
}

async function handleExec(request: {
  host: string;
  cmd: string;
}): Promise<void> {
  const active = session();
  const shell = shellFor(active, request.host);
  if (shell === null) {
    scope.postMessage({
      kind: "exec",
      host: request.host,
      cmd: request.cmd,
      lines: [],
      error: `unknown host: ${request.host}`,
      simTimeUs: active.sim.now,
      traces: [],
    });
    return;
  }

  // `Shell.exec` performs all of its virtual work synchronously and only the
  // lines travel through the promise, so the drain and the clock read happen
  // here: this answer owns exactly the traces its command produced.
  const pending = shell.exec(request.cmd);
  const traces = active.bus.drain().map(serializeTrace);
  const simTimeUs = active.sim.now;
  let lines: string[] = [];
  let error: string | null = null;
  try {
    lines = await pending;
  } catch (cause) {
    error = errorMessage(cause);
  }

  const response: ExecResponse = {
    kind: "exec",
    host: request.host,
    cmd: request.cmd,
    lines,
    error,
    simTimeUs,
    traces,
  };
  scope.postMessage(response);
}

/**
 * Validate one uploaded solution (F-112) through the same pipeline as
 * `netlab validate`: parse the exercise and the student scenario, append the
 * probes the checks need, run once with the CLI runner and answer with the
 * flat verdict. Parse errors are a normal answer so the panel can show them.
 */
async function handleValidate(request: {
  exercise: unknown;
  solution: unknown;
}): Promise<void> {
  try {
    const exercise = parseExerciseJson(request.exercise);
    const scenario = parseScenarioJson(request.solution);
    const prepared = prepareScenario(exercise, scenario);
    const result = await validateExercise(exercise, prepared, (value) =>
      runExerciseScenario(value as Scenario),
    );
    scope.postMessage({
      kind: "validate",
      pass: result.pass,
      checks: result.checks,
      run: result.run,
      error: null,
    });
  } catch (cause) {
    scope.postMessage({
      kind: "validate",
      pass: false,
      checks: [],
      run: null,
      error: errorMessage(cause),
    });
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "run") {
    void handleRun();
    return;
  }
  if (request.type === "validate") {
    void handleValidate(request);
    return;
  }
  void handleExec(request);
};
