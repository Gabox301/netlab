import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./topology";

/* ------------------------------------------------------------------------- */
/* Canvas view (F-84): zoom/pan state for the editor SVG.                     */
/* ------------------------------------------------------------------------- */

/**
 * Transient viewport over the fixed 1440x900 world. `{x, y}` is the
 * top-left world point in view; `k` the scale (1 = whole canvas).
 * Never enters the undo history: it is display state, like `tool`.
 */
export interface CanvasView {
  x: number;
  y: number;
  k: number;
}

export const VIEW_MIN_K = 0.25;
export const VIEW_MAX_K = 3;
/** Keep at least this many world px of canvas on screen when panning. */
export const VIEW_MARGIN = 200;

export function resetView(): CanvasView {
  return { x: 0, y: 0, k: 1 };
}

export function clampView(view: CanvasView): CanvasView {
  const k = Math.min(VIEW_MAX_K, Math.max(VIEW_MIN_K, view.k));
  const w = CANVAS_WIDTH / k;
  const h = CANVAS_HEIGHT / k;
  return {
    k,
    x: Math.min(CANVAS_WIDTH - VIEW_MARGIN, Math.max(-w + VIEW_MARGIN, view.x)),
    y: Math.min(
      CANVAS_HEIGHT - VIEW_MARGIN,
      Math.max(-h + VIEW_MARGIN, view.y),
    ),
  };
}

/**
 * Zoom by `factor` keeping the world point under the cursor fractions
 * (`fx`, `fy` in 0..1 across the element) fixed.
 */
export function zoomAt(
  view: CanvasView,
  fx: number,
  fy: number,
  factor: number,
): CanvasView {
  const k = Math.min(VIEW_MAX_K, Math.max(VIEW_MIN_K, view.k * factor));
  const w0 = CANVAS_WIDTH / view.k;
  const h0 = CANVAS_HEIGHT / view.k;
  const w1 = CANVAS_WIDTH / k;
  const h1 = CANVAS_HEIGHT / k;
  const wx = view.x + fx * w0;
  const wy = view.y + fy * h0;
  return clampView({ k, x: wx - fx * w1, y: wy - fy * h1 });
}

/** Pan by a world-space delta (screen delta divided by scale). */
export function panBy(view: CanvasView, dx: number, dy: number): CanvasView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy });
}

/**
 * Content scale under `preserveAspectRatio="xMidYMid meet"`: the viewBox
 * is fit inside the element, so element px map to world through `s`, not
 * through per-axis division (which over-pans on the letterboxed axis).
 */
export function contentScale(rectW: number, rectH: number, k: number): number {
  return Math.min(rectW / (CANVAS_WIDTH / k), rectH / (CANVAS_HEIGHT / k));
}

/**
 * Zoom by `factor` keeping the world point under the element px
 * (`px`, `py`) fixed, accounting for the meet letterbox bars.
 */
export function zoomAtPoint(
  view: CanvasView,
  rectW: number,
  rectH: number,
  px: number,
  py: number,
  factor: number,
): CanvasView {
  const wv = CANVAS_WIDTH / view.k;
  const hv = CANVAS_HEIGHT / view.k;
  const s = contentScale(rectW, rectH, view.k);
  const fx = (px - (rectW - wv * s) / 2) / (wv * s);
  const fy = (py - (rectH - hv * s) / 2) / (hv * s);
  return zoomAt(view, fx, fy, factor);
}

/** Pan by an element-px delta through the content scale. */
export function panPx(
  view: CanvasView,
  rectW: number,
  rectH: number,
  dxPx: number,
  dyPx: number,
): CanvasView {
  const s = contentScale(rectW, rectH, view.k);
  return panBy(view, -dxPx / s, -dyPx / s);
}

export function viewBoxOf(view: CanvasView): string {
  return `${view.x} ${view.y} ${CANVAS_WIDTH / view.k} ${CANVAS_HEIGHT / view.k}`;
}
