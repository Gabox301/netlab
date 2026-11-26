/**
 * Tutorial interactivo de bienvenida (Fase 8 T3).
 *
 * El overlay de tres pasos vive en `routes/workbench/+page.svelte`; acá queda la parte
 * pura que se puede pinnear con tests: los pasos anclados al golden path del
 * workbench (Run → frame → scrub), la copia en español, la clave de
 * localStorage y la decisión de primera visita.
 *
 * El estado es un documento versionado mínimo
 * (`{"version":1,"status":"seen"|"completed"}`) en `netlab.tutorial.v1`.
 * Igual que el progreso de Práctica, leer y escribir nunca lanzan: storage
 * deshabilitado, modo privado y el prerender estático leen como "primera
 * visita", y una escritura rechazada se descarta.
 *
 * La navegación de pasos (`clampStepIndex`, `stepAt`, `stepProgressLabel`,
 * `stepPrimaryLabel`, `nextStepIndex`, `previousStepIndex`) es genérica y la
 * comparte el overlay de ayuda contextual de `lib/help.ts`: un solo lugar
 * define cómo se clampea un índice, no dos copias del mismo cálculo.
 */

/** Clave de storage del documento del tutorial. */
export const TUTORIAL_STORAGE_KEY = "netlab.tutorial.v1";

/** Versión del JSON detrás de {@link TUTORIAL_STORAGE_KEY}. */
export const TUTORIAL_VERSION = 1;

/** Atributo que marca los anclajes reales dentro del workbench. */
export const TUTORIAL_ANCHOR_ATTR = "data-tutorial";

/** Anclaje de cada paso dentro del workbench. */
export type TutorialAnchor = "run" | "packets" | "timeline";

/** Identificador estable de cada paso. */
export type TutorialStepId = "run" | "frame" | "scrub";

/** Un paso del overlay: copia en español y el anclaje que ilumina. */
export interface TutorialStep {
  id: TutorialStepId;
  anchor: TutorialAnchor;
  title: string;
  /** Una sola línea de contexto. */
  line: string;
  /** Acción esperada, en imperativo. */
  action: string;
}

/** Los tres pasos, en el orden del golden path. */
export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "run",
    anchor: "run",
    title: "Corré el escenario",
    line: "El worker simula dos subredes y devuelve las tramas reales del escenario.",
    action: "Pulsá ▶ Run para generar el listado de frames.",
  },
  {
    id: "frame",
    anchor: "packets",
    title: "Abrí un frame",
    line: "Cada fila es una trama capturada; el inspector muestra sus capas y el volcado hex.",
    action: "Elegí un frame de la lista y mirá el panel Inspector.",
  },
  {
    id: "scrub",
    anchor: "timeline",
    title: "Movete en la línea de tiempo",
    line: "El replay es determinista: el mismo seed produce siempre las mismas tramas.",
    action: "Arrastrá el scrubber y seguí el reloj virtual.",
  },
];

/** Copia fija del diálogo y de sus botones. */
export const TUTORIAL_MESSAGES = {
  dialogLabel: "Tutorial de bienvenida",
  next: "Siguiente",
  back: "Atrás",
  skip: "Omitir",
  finish: "Listo",
  help: "Ayuda",
  helpTitle: "Reabrir el tutorial de bienvenida",
} as const;

/** Estado persistido: visto (mostrado alguna vez) o completado. */
export type TutorialStatus = "seen" | "completed";

/** El documento que vive en {@link TUTORIAL_STORAGE_KEY}. */
export interface TutorialState {
  version: typeof TUTORIAL_VERSION;
  status: TutorialStatus;
}

/** El slice de `Storage` que usa este módulo (un fake entra en tests). */
export interface TutorialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Documento con `status`, listo para serializar. */
export function tutorialState(status: TutorialStatus): TutorialState {
  return { version: TUTORIAL_VERSION, status };
}

/**
 * Parse estricto del documento: versión y `status` conocidos, o `null`.
 * Nunca lanza; un texto corrupto se trata como "no hay estado".
 */
export function parseTutorialState(text: string | null): TutorialState | null {
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== TUTORIAL_VERSION) {
    return null;
  }
  const status = raw.status;
  if (status !== "seen" && status !== "completed") {
    return null;
  }
  return { version: TUTORIAL_VERSION, status };
}

/** Serializa el documento exactamente como lo lee {@link parseTutorialState}. */
export function serializeTutorialState(state: TutorialState): string {
  return JSON.stringify(state);
}

/**
 * Si el overlay debe abrirse: `null`, vacío, basura o una versión distinta
 * cuentan como primera visita; `seen` y `completed` ya no se muestran solos.
 */
export function shouldShowTutorial(storageValue: string | null): boolean {
  return parseTutorialState(storageValue) === null;
}

/* Navegación de pasos compartida con `lib/help.ts` -------------------------- */

/**
 * Índice dentro de `[0, total - 1]`: un índice no finito cae en el primero.
 * `total` es la cantidad real de pasos del overlay que navega.
 */
export function clampStepIndex(index: number, total: number): number {
  const last = Math.max(total - 1, 0);
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(index), 0), last);
}

/** La copia que un overlay de pasos necesita para su botón primario. */
export interface StepMessages {
  next: string;
  finish: string;
}

/** Paso en `index` dentro de `steps`, con clamp: nunca devuelve `undefined`. */
export function stepAt<T>(steps: readonly T[], index: number): T {
  return steps[clampStepIndex(index, steps.length)] as T;
}

/** Etiqueta de progreso: `Paso N de M`, con clamp al rango real. */
export function stepProgressLabel(index: number, total: number): string {
  return `Paso ${clampStepIndex(index, total) + 1} de ${Math.max(total, 1)}`;
}

/** Etiqueta del botón primario: avanza, o cierra en el último paso. */
export function stepPrimaryLabel(
  index: number,
  total: number,
  messages: StepMessages,
): string {
  return clampStepIndex(index, total) === Math.max(total - 1, 0)
    ? messages.finish
    : messages.next;
}

/** Índice siguiente, sin pasarse del último paso. */
export function nextStepIndex(index: number, total: number): number {
  return Math.min(clampStepIndex(index, total) + 1, Math.max(total - 1, 0));
}

/** Índice anterior, sin bajar del primero. */
export function previousStepIndex(index: number, total: number): number {
  return Math.max(clampStepIndex(index, total) - 1, 0);
}

/* Tutorial de bienvenida (Fase 8 T3) -------------------------------------- */

/** Paso en `index`, con clamp: nunca devuelve `undefined`. */
export function tutorialStepAt(index: number): TutorialStep {
  return stepAt(TUTORIAL_STEPS, index);
}

/** Etiqueta de progreso: `Paso N de M`, con clamp al rango real. */
export function tutorialProgressLabel(index: number): string {
  return stepProgressLabel(index, TUTORIAL_STEPS.length);
}

/** Etiqueta del botón primario: avanza, o cierra en el último paso. */
export function tutorialNextLabel(index: number): string {
  return stepPrimaryLabel(index, TUTORIAL_STEPS.length, TUTORIAL_MESSAGES);
}

/** Índice siguiente, sin pasarse del último paso. */
export function nextTutorialStep(index: number): number {
  return nextStepIndex(index, TUTORIAL_STEPS.length);
}

/** Índice anterior, sin bajar del primero. */
export function previousTutorialStep(index: number): number {
  return previousStepIndex(index, TUTORIAL_STEPS.length);
}

/** Browser storage cuando existe; `null` en workers, tests y prerender. */
function defaultStorage(): TutorialStorage | null {
  const candidate = (
    globalThis as { localStorage?: TutorialStorage | undefined }
  ).localStorage;
  return candidate ?? null;
}

/** Valor crudo del documento; storage ausente o que falla lee como `null`. */
export function readTutorialValue(
  storage: TutorialStorage | null = defaultStorage(),
): string | null {
  if (storage === null) {
    return null;
  }
  try {
    return storage.getItem(TUTORIAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persiste `seen`/`completed`; una escritura rechazada se descarta. */
export function saveTutorialStatus(
  status: TutorialStatus,
  storage: TutorialStorage | null = defaultStorage(),
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(
      TUTORIAL_STORAGE_KEY,
      serializeTutorialState(tutorialState(status)),
    );
  } catch {
    // Cuota llena o modo privado: el tutorial sigue reabrible desde Ayuda.
  }
}
