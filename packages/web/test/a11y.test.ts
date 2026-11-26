import { describe, expect, test } from "bun:test";
import {
  contrastRatio,
  meetsAaNormalText,
  relativeLuminance,
  workbenchStatus,
} from "../src/lib/a11y";

describe("contraste AA de la paleta (Fase 8 T2)", () => {
  test("negro sobre blanco da 21:1", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 9);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 9);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  test("el texto tenue sobre el fondo cumple AA normal (≥ 4.5:1)", () => {
    expect(meetsAaNormalText("#9d9da6", "#0b0b0d")).toBe(true);
    expect(contrastRatio("#9d9da6", "#0b0b0d")).toBeGreaterThanOrEqual(4.5);
  });

  test("hex inválido falla fuerte", () => {
    expect(() => relativeLuminance("rojo")).toThrow("hex inválido");
  });
});

describe("mensaje de estado del workbench (región aria-live)", () => {
  test("cargando", () => {
    expect(
      workbenchStatus({
        loading: true,
        errored: false,
        total: 0,
        selectedT: null,
      }),
    ).toBe("Ejecutando simulación en el worker…");
  });

  test("error", () => {
    expect(
      workbenchStatus({
        loading: false,
        errored: true,
        total: 0,
        selectedT: null,
      }),
    ).toContain("alerta de error");
  });

  test("frame seleccionado", () => {
    expect(
      workbenchStatus({
        loading: false,
        errored: false,
        total: 68,
        selectedT: 120,
      }),
    ).toBe("Frame de t = 120 µs seleccionado; 68 frames en total.");
  });

  test("sin selección", () => {
    expect(
      workbenchStatus({
        loading: false,
        errored: false,
        total: 68,
        selectedT: null,
      }),
    ).toContain("68 frames cargados");
  });
});

describe("DOM a11y del workbench en /workbench (pins de presencia)", () => {
  const source = Bun.file(
    new URL("../src/routes/workbench/+page.svelte", import.meta.url),
  );

  test("skip-link a la lista de paquetes", async () => {
    const text = await source.text();
    expect(text).toContain('class="skip"');
    expect(text).toContain('href="#filter-expr"');
  });

  test("región de estado con aria-live", async () => {
    const text = await source.text();
    expect(text).toContain('role="status"');
    expect(text).toContain('aria-live="polite"');
    expect(text).toContain("workbenchStatus({");
  });

  test("se respeta prefers-reduced-motion", async () => {
    const text = await source.text();
    expect(text).toContain("prefers-reduced-motion");
  });
});
