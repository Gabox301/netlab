/**
 * Ayuda contextual por pantalla (A1 + A2).
 *
 * Restricción dura (S2): ninguna ayuda nueva revela soluciones de ejercicios,
 * checks del validador ni topologías de referencia. Acá solo se enseña a usar
 * la herramienta: qué botón hace qué, qué muestra cada panel, atajos de
 * teclado, la leyenda del replay y el flujo de validación. Los hints
 * graduados de los ejercicios viven en `packages/exercises` y no se tocan.
 *
 * Misma forma que `lib/tutorial.ts`: acá queda la parte pura (pasos, copia en
 * español, filas de atajos y leyenda) y el overlay de cada pantalla es una
 * vista fina. El clamp de índices no se reimplementa: sale de los helpers
 * genéricos de `lib/tutorial.ts`.
 *
 * Nada de este módulo toca storage: la ayuda es reabrible siempre, no tiene
 * estado de primera visita.
 */

import {
  nextStepIndex,
  previousStepIndex,
  stepAt,
  stepPrimaryLabel,
  stepProgressLabel,
} from "./tutorial";

/** Las pantallas que ofrecen ayuda contextual. */
export type HelpScreen = "workbench" | "editor" | "practica";

/** Copia fija de los diálogos, botones y títulos de sección. */
export const HELP_MESSAGES = {
  dialogLabel: "Ayuda del editor",
  openTitle: "Abrir la ayuda del editor",
  open: "Ayuda",
  next: "Siguiente",
  back: "Atrás",
  finish: "Listo",
  close: "Cerrar",
  shortcutsTitle: "Atajos del editor",
  guideTitle: "Guía rápida",
  guideSummary: "Cómo se usa · atajos de replay · leyenda",
  flowTitle: "Flujo de validación",
  keysTitle: "Atajos de replay",
  legendTitle: "Leyenda del replay",
  howTitle: "Cómo se resuelve un ejercicio",
} as const;

/* A1 · Editor -------------------------------------------------------------- */

/** Anclaje de cada paso del tour dentro del editor. */
export type HelpAnchor = "palette" | "canvas" | "properties" | "export";

/** Identificador estable de cada paso del tour. */
export type HelpStepId = "palette" | "canvas" | "properties" | "export";

/** Un paso del tour: copia en español y a qué zona del editor se refiere. */
export interface HelpStep {
  id: HelpStepId;
  anchor: HelpAnchor;
  title: string;
  /** Una sola línea de contexto. */
  line: string;
  /** Acción esperada, en imperativo. */
  action: string;
}

/**
 * Los cuatro pasos del editor, en el orden en que se usa la herramienta:
 * elegir herramienta → dibujar y cablear → ajustar propiedades → exportar.
 */
export const EDITOR_HELP_STEPS: readonly HelpStep[] = [
  {
    id: "palette",
    anchor: "palette",
    title: "Elegí una herramienta",
    line: "La barra flotante tiene select, host, switch, router, cable, undo/redo, copy/paste y zoom.",
    action:
      "Arrastrá un dispositivo al lienzo o hacé clic en su botón para agregarlo.",
  },
  {
    id: "canvas",
    anchor: "canvas",
    title: "Dibujá y cableá",
    line: "Cada dispositivo muestra sus interfaces sobre una grilla de 48 px; el lienzo se puede mover y ampliar.",
    action:
      "Activá cable (∿) y tocá las dos puntas; Esc cancela el cable pendiente.",
  },
  {
    id: "properties",
    anchor: "properties",
    title: "Ajustá las propiedades",
    line: "El panel derecho edita lo que tengas seleccionado: dispositivo, interfaz o cable.",
    action:
      "Elegí un nodo o un cable y cambiá ahí nombre, IP, MAC, rutas o acciones.",
  },
  {
    id: "export",
    anchor: "export",
    title: "Exportá y validá",
    line: "El borrador se guarda solo en este navegador; Exportar JSON baja el escenario v1.",
    action: "Subí ese archivo en el detalle del ejercicio y pulsá Validar.",
  },
];

/** Un atajo de teclado tal como se documenta en la UI. */
export interface HelpShortcut {
  /** Teclas, con `+` para combinaciones y `·` para alternativas. */
  keys: string;
  what: string;
}

/** Un grupo de atajos con su título en español. */
export interface HelpShortcutGroup {
  title: string;
  shortcuts: readonly HelpShortcut[];
}

/**
 * Atajos reales del editor: solo los que `onWindowKeyDown` y los handlers de
 * nodo/interfaz/cable implementan hoy. Fuera de los campos de texto, Ctrl y
 * Cmd son equivalentes.
 */
export const EDITOR_HELP_SHORTCUTS: readonly HelpShortcutGroup[] = [
  {
    title: "Lienzo",
    shortcuts: [
      { keys: "Ctrl+Z", what: "Deshacer el último cambio del lienzo" },
      { keys: "Ctrl+Shift+Z · Ctrl+Y", what: "Rehacer" },
      { keys: "Ctrl+C", what: "Copiar el dispositivo seleccionado" },
      { keys: "Ctrl+V", what: "Pegar el portapapeles en el lienzo" },
      { keys: "Flechas", what: "Mover el nodo enfocado 8 px" },
      { keys: "Shift+Flechas", what: "Mover el nodo enfocado 32 px" },
      { keys: "Enter · Espacio", what: "Seleccionar lo enfocado" },
      { keys: "Esc", what: "Cancelar el cable o volver a modo selección" },
    ],
  },
  {
    title: "Vista",
    shortcuts: [
      { keys: "+ · =", what: "Acercar" },
      { keys: "−", what: "Alejar" },
      { keys: "0", what: "Volver a la vista 100%" },
      { keys: "Rueda", what: "Zoom sobre el puntero" },
    ],
  },
];

/** Paso en `index`, con clamp al rango real del tour del editor. */
export function helpStepAt(index: number): HelpStep {
  return stepAt(EDITOR_HELP_STEPS, index);
}

/** Etiqueta de progreso: `Paso N de M` del tour del editor. */
export function helpProgressLabel(index: number): string {
  return stepProgressLabel(index, EDITOR_HELP_STEPS.length);
}

/** Etiqueta del botón primario: avanza, o cierra en el último paso. */
export function helpNextLabel(index: number): string {
  return stepPrimaryLabel(index, EDITOR_HELP_STEPS.length, HELP_MESSAGES);
}

/** Índice siguiente del tour, sin pasarse del último paso. */
export function nextHelpStep(index: number): number {
  return nextStepIndex(index, EDITOR_HELP_STEPS.length);
}

/** Índice anterior del tour, sin bajar del primero. */
export function previousHelpStep(index: number): number {
  return previousStepIndex(index, EDITOR_HELP_STEPS.length);
}

/* A2 · Guías sin respuestas ------------------------------------------------ */

/**
 * Atajos de replay del workbench: los mismos que atiende `onReplayKey`
 * (Espacio, ← y →) y solo con el foco fuera de campos y botones.
 */
export const WORKBENCH_HELP_SHORTCUTS: readonly HelpShortcutGroup[] = [
  {
    title: "Replay",
    shortcuts: [
      { keys: "Espacio", what: "Pausar o reanudar el replay" },
      { keys: "←", what: "Frame anterior" },
      { keys: "→", what: "Frame siguiente" },
    ],
  },
];

/** Una entrada de la leyenda del replay: muestra visual y qué significa. */
export interface HelpLegendItem {
  /** Clase visual que ya usa el workbench (`tx`, `rx`, `drop`). */
  id: "tx" | "rx" | "drop" | "dropped";
  label: string;
  what: string;
}

/**
 * Leyenda de la animación, derivada de lo que la UI ya pinta: la columna
 * `dir` de la lista y el trazo de los vuelos del flow graph.
 */
export const WORKBENCH_LEGEND: readonly HelpLegendItem[] = [
  {
    id: "tx",
    label: "tx →",
    what: "Sale del dispositivo: el vuelo viaja por el enlace.",
  },
  { id: "rx", label: "← rx", what: "Llega al destino y se acepta." },
  { id: "drop", label: "drop ✕", what: "Se descarta; la fila trae el motivo." },
  {
    id: "dropped",
    label: "vuelo punteado",
    what: "El flow graph marca así un vuelo descartado.",
  },
];

/** Un paso del flujo de validación, sin revelar nada de ningún ejercicio. */
export interface HelpFlowStep {
  id: "build" | "export" | "validate";
  title: string;
  line: string;
}

/**
 * El flujo general de validación: se arma en el editor, se exporta el JSON v1
 * y se sube en el detalle del ejercicio. Es el mismo texto para el workbench y
 * para Práctica, y no depende de qué ejercicio se esté resolviendo.
 */
export const VALIDATION_FLOW: readonly HelpFlowStep[] = [
  {
    id: "build",
    title: "Armá",
    line: "Dibujá la topología en el editor y ajustá interfaces, rutas y acciones.",
  },
  {
    id: "export",
    title: "Exportá",
    line: "Exportar JSON baja el escenario v1 como archivo.",
  },
  {
    id: "validate",
    title: "Subí",
    line: "Elegí ese archivo en el detalle del ejercicio y pulsá Validar.",
  },
];

/**
 * Qué superficies de ayuda ofrece cada pantalla. Una pantalla con tour
 * reabrible puede dejar el resto detrás del botón; sin tour, la guía va
 * inline para que esté siempre a la vista.
 */
export interface ScreenHelp {
  /** El botón de ayuda abre un tour de pasos con overlay. */
  tour: boolean;
  /** La pantalla muestra una guía inline (flujo, atajos, leyenda). */
  inlineGuide: boolean;
}

/** Tabla de ayuda por pantalla; las dos páginas la consultan al renderizar. */
export const SCREEN_HELP: Record<HelpScreen, ScreenHelp> = {
  workbench: { tour: true, inlineGuide: true },
  editor: { tour: true, inlineGuide: false },
  practica: { tour: false, inlineGuide: true },
};

/** True si la pantalla tiene un tour que se reabre desde su botón de ayuda. */
export function hasHelpTour(screen: HelpScreen): boolean {
  return SCREEN_HELP[screen].tour;
}

/** True si la pantalla muestra su guía inline en vez de esconderla tras un tour. */
export function hasInlineGuide(screen: HelpScreen): boolean {
  return SCREEN_HELP[screen].inlineGuide;
}
