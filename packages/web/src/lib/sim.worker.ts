/**
 * Simulation worker (S3): runs the fixed two-subnet lab off the main thread
 * and posts one message with the whole deterministic run. It imports only
 * `@netlab/*` engine packages — never SvelteKit or client UI code.
 */

import { runScenario } from "./scenario";
import type { WorkerRequest, WorkerResponse } from "./sim-protocol";

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
}

const scope = globalThis as unknown as WorkerScope;

async function handleRun(): Promise<void> {
  try {
    const result = await runScenario();
    scope.postMessage({ kind: "result", result });
  } catch (cause) {
    scope.postMessage({
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

scope.onmessage = (event) => {
  if (event.data.type === "run") {
    void handleRun();
  }
};
