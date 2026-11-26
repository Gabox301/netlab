/**
 * Helpers de accesibilidad del workbench: puros y testeables.
 *
 * El DOM (skip-link, región aria-live, `prefers-reduced-motion`) vive en
 * `routes/workbench/+page.svelte`; acá queda la lógica que sí se puede pinnear con
 * tests: contraste WCAG de la paleta y el mensaje de estado en español.
 */

/** Luminancia relativa WCAG 2.x de un `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (match === null) {
    throw new Error(`hex inválido: ${JSON.stringify(hex)}`);
  }
  const channels = [0, 2, 4].map((at) => {
    const v = Number.parseInt((match[1] as string).slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ratio de contraste WCAG entre texto (`fg`) y fondo (`bg`). */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** True si el par cumple AA para texto normal (≥ 4.5:1). */
export function meetsAaNormalText(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= 4.5;
}

export interface WorkbenchStatus {
  loading: boolean;
  errored: boolean;
  total: number;
  /** Tiempo virtual del frame seleccionado, o null si no hay selección. */
  selectedT: number | null;
}

/** Mensaje en español para la región `role="status"` del workbench. */
export function workbenchStatus(status: WorkbenchStatus): string {
  if (status.loading) {
    return "Ejecutando simulación en el worker…";
  }
  if (status.errored) {
    return "La simulación falló; el detalle está en la alerta de error.";
  }
  if (status.selectedT !== null) {
    return (
      `Frame de t = ${status.selectedT} µs seleccionado; ` +
      `${status.total} frames en total.`
    );
  }
  return (
    `${status.total} frames cargados; ` +
    "elegí uno de la lista para inspeccionarlo."
  );
}
