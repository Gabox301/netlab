import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LANDING_CARDS,
  LANDING_HERO,
  LANDING_STEPS,
  LANDING_THEORY,
  LANDING_THEORY_ROOT,
} from "../src/lib/landing";

/** Rutas internas que puede tener una card: nada más entra por acá. */
const VALID_HREFS = /^\/(workbench|editor|practica)$/;

const ROUTES_DIR = fileURLToPath(new URL("../src/routes/", import.meta.url));

function svelteSources(dir: string = ROUTES_DIR): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [path, text] of svelteSources(full)) {
        found.set(path, text);
      }
      continue;
    }
    if (entry.name.endsWith(".svelte")) {
      found.set(full, readFileSync(full, "utf8"));
    }
  }
  return found;
}

function routeFile(...parts: string[]): string {
  return join(ROUTES_DIR, ...parts);
}

/** Texto de cada `<a>` que apunta a la raíz con `resolve("/")`. */
function rootLinks(text: string): string[] {
  const anchors = text.match(
    /<a\b[^>]*resolve\("\/"\)[^>]*>[\s\S]{0,160}?<\/a>/g,
  );
  return anchors ?? [];
}

describe("cards de la landing (S1)", () => {
  test("tres cards en el orden de uso: workbench, editor y práctica", () => {
    expect(LANDING_CARDS.map((card) => card.id)).toEqual([
      "workbench",
      "editor",
      "practica",
    ]);
    expect(LANDING_CARDS.map((card) => card.title)).toEqual([
      "Workbench",
      "Editor",
      "Práctica",
    ]);
    expect(LANDING_CARDS.map((card) => card.href)).toEqual([
      "/workbench",
      "/editor",
      "/practica",
    ]);
  });

  test("los destinos son rutas internas válidas y no se repiten", () => {
    for (const card of LANDING_CARDS) {
      expect(card.href).toMatch(VALID_HREFS);
    }
    expect(new Set(LANDING_CARDS.map((card) => card.href)).size).toBe(
      LANDING_CARDS.length,
    );
  });

  test("ninguna card queda con copy vacío", () => {
    for (const card of LANDING_CARDS) {
      for (const [field, value] of Object.entries(card)) {
        if (field === "href") {
          continue;
        }
        expect(typeof value).toBe("string");
        expect(String(value).trim().length).toBeGreaterThan(0);
      }
      expect(card.line.trim()).not.toBe(card.title.trim());
    }
  });
});

describe("hero y camino de entrada (S1)", () => {
  test("el hero explica qué es NetLab: stack propio, determinismo y semilla", () => {
    const hero = Object.values(LANDING_HERO).join(" ");
    expect(hero).toMatch(/stack TCP\/IP propio/);
    expect(hero).toMatch(/determinista/);
    expect(hero).toMatch(/semilla/);
    for (const value of Object.values(LANDING_HERO)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
    expect(LANDING_HERO.metaDescription.length).toBeLessThanOrEqual(200);
  });

  test("cómo empezar son tres pasos numerados y no vacíos", () => {
    expect(LANDING_STEPS.map((step) => step.n)).toEqual(["1", "2", "3"]);
    for (const step of LANDING_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.line.trim().length).toBeGreaterThan(0);
      expect(step.line.trim()).not.toBe(step.title.trim());
    }
  });

  test("la teoría apunta a docs/teoria y cada doc existe en el repo", () => {
    expect(LANDING_THEORY).toHaveLength(4);
    expect(new Set(LANDING_THEORY.map((item) => item.doc)).size).toBe(
      LANDING_THEORY.length,
    );
    for (const item of LANDING_THEORY) {
      expect(item.doc.startsWith(LANDING_THEORY_ROOT)).toBe(true);
      expect(item.doc.endsWith(".md")).toBe(true);
      expect(item.protocol.trim().length).toBeGreaterThan(0);
      expect(item.line.trim().length).toBeGreaterThan(0);
      expect(existsSync(new URL(`../../../${item.doc}`, import.meta.url))).toBe(
        true,
      );
    }
  });
});

describe("pins de presencia: landing en /, workbench en /workbench (S2)", () => {
  test("la landing renderiza los datos puros en `routes/+page.svelte`", () => {
    const text = readFileSync(routeFile("+page.svelte"), "utf8");
    for (const name of [
      "LANDING_HERO",
      "LANDING_CARDS",
      "LANDING_STEPS",
      "LANDING_THEORY",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("resolve(card.href)");
    expect(text).toContain('class="skip"');
    expect(text).toContain('href="#modos"');
    expect(text).toContain('resolve("/workbench")');
  });

  test("la landing ya no contiene la simulación: el workbench se mudó", () => {
    const text = readFileSync(routeFile("+page.svelte"), "utf8");
    expect(text).not.toContain("sim.worker");
    expect(text).not.toContain("buildPackets");
    expect(text).not.toContain("filter-expr");
  });

  test("el workbench conserva skip-link, estado y guía en su archivo nuevo", () => {
    const text = readFileSync(routeFile("workbench", "+page.svelte"), "utf8");
    expect(text).toContain('class="skip"');
    expect(text).toContain('href="#filter-expr"');
    expect(text).toContain('role="status"');
    expect(text).toContain('aria-live="polite"');
    expect(text).toContain("workbenchStatus({");
    expect(text).toContain("prefers-reduced-motion");
    expect(text).toContain("VALIDATION_FLOW");
    expect(text).toContain('data-tutorial="run"');
    expect(text).toContain("sim.worker");
  });

  test("el header del workbench vuelve al inicio", () => {
    const text = readFileSync(routeFile("workbench", "+page.svelte"), "utf8");
    expect(text).toContain('resolve("/")}>← Inicio');
    expect(text).toContain('resolve("/editor")');
    expect(text).toContain('resolve("/practica")');
  });

  test("ningún link rotulado Workbench apunta ya a `/`", () => {
    const offenders: string[] = [];
    for (const [path, text] of svelteSources()) {
      for (const anchor of rootLinks(text)) {
        if (/workbench/i.test(anchor)) {
          offenders.push(`${path}: ${anchor}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("editor y práctica enlazan al workbench en su ruta nueva", () => {
    expect(readFileSync(routeFile("editor", "+page.svelte"), "utf8")).toContain(
      'resolve("/workbench")}>Workbench',
    );
    expect(
      readFileSync(routeFile("practica", "+page.svelte"), "utf8"),
    ).toContain('resolve("/workbench")}>← Workbench');
  });
});
