import { describe, expect, test } from "bun:test";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../src/lib/topology";
import {
  clampView,
  contentScale,
  panBy,
  panPx,
  resetView,
  viewBoxOf,
  zoomAt,
  zoomAtPoint,
} from "../src/lib/view";

describe("canvas view (F-84)", () => {
  test("reset is the full canvas", () => {
    expect(resetView()).toEqual({ x: 0, y: 0, k: 1 });
    expect(viewBoxOf(resetView())).toBe(`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`);
  });

  test("zoom keeps the cursor world point fixed", () => {
    const before = resetView();
    const fx = 0.25;
    const fy = 0.75;
    const wx = before.x + fx * (CANVAS_WIDTH / before.k);
    const wy = before.y + fy * (CANVAS_HEIGHT / before.k);
    const after = zoomAt(before, fx, fy, 2);
    expect(after.k).toBe(2);
    expect(after.x + fx * (CANVAS_WIDTH / after.k)).toBeCloseTo(wx, 9);
    expect(after.y + fy * (CANVAS_HEIGHT / after.k)).toBeCloseTo(wy, 9);
  });

  test("zoom clamps to min/max scale", () => {
    expect(zoomAt(resetView(), 0.5, 0.5, 100).k).toBe(3);
    expect(zoomAt(resetView(), 0.5, 0.5, 0.001).k).toBe(0.25);
    expect(zoomAt(resetView(), 0.5, 0.5, 1)).toEqual(resetView());
  });

  test("pan moves and clamps to the canvas margin", () => {
    const moved = panBy(resetView(), 100, 50);
    expect(moved).toEqual({ x: 100, y: 50, k: 1 });
    const far = panBy(resetView(), 100_000, -100_000);
    expect(far.x).toBe(CANVAS_WIDTH - 200);
    expect(far.y).toBe(-CANVAS_HEIGHT / far.k + 200);
  });

  test("clampView keeps the scale inside bounds", () => {
    expect(clampView({ x: 0, y: 0, k: 99 }).k).toBe(3);
    expect(clampView({ x: 0, y: 0, k: -2 }).k).toBe(0.25);
  });

  test("element mapping accounts for the meet letterbox", () => {
    // 1600x800 box over a 1440x900 world: height-limited, side bars.
    const s = contentScale(1600, 800, 1);
    expect(s).toBeCloseTo(800 / CANVAS_HEIGHT, 9);
    // Element center is world center: zooming there keeps it fixed.
    const after = zoomAtPoint(resetView(), 1600, 800, 800, 400, 2);
    expect(after.k).toBe(2);
    expect(after.x + CANVAS_WIDTH / after.k / 2).toBeCloseTo(
      CANVAS_WIDTH / 2,
      9,
    );
    expect(after.y + CANVAS_HEIGHT / after.k / 2).toBeCloseTo(
      CANVAS_HEIGHT / 2,
      9,
    );
  });

  test("panPx converts element px through the content scale", () => {
    const s = contentScale(1600, 800, 1);
    const moved = panPx(resetView(), 1600, 800, 100, 0);
    expect(moved.x).toBeCloseTo(-100 / s, 9);
    expect(moved.y).toBe(0);
  });
});
