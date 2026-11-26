/**
 * Tutorial interactivo de bienvenida (Fase 8 T3).
 *
 * El overlay de tres pasos vive en `routes/+page.svelte`; acá queda la parte
 * pura que se puede pinnear con tests: los pasos anclados al golden path del
 * workbench (Run → frame → scrub), la copia en español, la clave de
 * localStorage y la decisión de primera visita.
 *
 * El estado es un documento versionado mínimo
 * (`{"version":1,"status":"seen"|"completed"}`) en `netlab.tutorial.v1`.
 * Igual que el progreso de Práctica, leer y escribir nunca lanzan: storage
 * deshabilitado, modo privado y el prerender estático leen como "primera
 * visita", y una escritura rechazada se descarta.
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

function clampIndex(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(value), 0), TUTORIAL_STEPS.length - 1);
}

/** Paso en `index`, con clamp: nunca devuelve `undefined`. */
export function tutorialStepAt(index: number): TutorialStep {
  return TUTORIAL_STEPS[clampIndex(index)] as TutorialStep;
}

/** Etiqueta de progreso: `Paso N de M`, con clamp al rango real. */
export function tutorialProgressLabel(index: number): string {
  return `Paso ${clampIndex(index) + 1} de ${TUTORIAL_STEPS.length}`;
}

/** Etiqueta del botón primario: avanza, o cierra en el último paso. */
export function tutorialNextLabel(index: number): string {
  return clampIndex(index) === TUTORIAL_STEPS.length - 1
    ? TUTORIAL_MESSAGES.finish
    : TUTORIAL_MESSAGES.next;
}

/** Índice siguiente, sin pasarse del último paso. */
export function nextTutorialStep(index: number): number {
  return Math.min(clampIndex(index) + 1, TUTORIAL_STEPS.length - 1);
}

/** Índice anterior, sin bajar del primero. */
export function previousTutorialStep(index: number): number {
  return Math.max(clampIndex(index) - 1, 0);
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
