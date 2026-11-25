/**
 * F-115 / T5: learning routes over the 25-exercise catalog.
 *
 * Routes are authored JSON (`routes/*.json`) and loaded through
 * `src/catalog.ts`, the same module the browser bundles. These tests pin the
 * invariants a student would notice: the four roadmap routes exist, every id
 * a route references is a real exercise file, and the catalog reaches every
 * exercise at least once. The raw base scenario is asserted too: the exercise
 * schema intentionally drops VLAN/routes fields it never reads, so the
 * catalog must keep the authored JSON (the trap needs those fields) instead
 * of re-serializing the parsed view.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRACTICE_EXERCISES,
  PRACTICE_ROUTES,
  type PracticeRoute,
  parsePracticeRoute,
  practiceExercise,
  practiceRoute,
} from "../src/index";

const ROOT = join(import.meta.dir, "..");
const ROUTES = join(ROOT, "routes");
const EXERCISES = join(ROOT, "exercises");

function routeFiles(): Array<string> {
  return readdirSync(ROUTES)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readRoute(name: string): unknown {
  return JSON.parse(readFileSync(join(ROUTES, name), "utf8"));
}

/** Flattened exercise ids of one route, in authored order. */
function routeExerciseIds(route: PracticeRoute): Array<string> {
  return route.levels.flatMap((level) => level.exercises);
}

describe("learning routes (F-115)", () => {
  test("ships the four roadmap routes", () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toEqual([
      "capa-2.json",
      "direccionamiento-y-ruteo.json",
      "servicios-de-red.json",
      "tcp-a-fondo.json",
    ]);
    expect(PRACTICE_ROUTES).toHaveLength(4);
    expect(PRACTICE_ROUTES.map((route) => route.id).sort()).toEqual(
      files.map((name) => name.replace(/\.json$/, "")),
    );
  });

  test("keeps the roadmap titles", () => {
    expect(PRACTICE_ROUTES.map((route) => route.title)).toEqual([
      "Capa 2",
      "Direccionamiento y ruteo",
      "TCP a fondo",
      "Servicios de red",
    ]);
    for (const route of PRACTICE_ROUTES) {
      expect(route.summary.length).toBeGreaterThan(0);
      expect(route.levels.length).toBeGreaterThan(0);
    }
  });

  test("numbers the levels from 1 without gaps", () => {
    for (const route of PRACTICE_ROUTES) {
      expect(route.levels.map((level) => level.level)).toEqual(
        route.levels.map((_, index) => index + 1),
      );
      for (const level of route.levels) {
        expect(level.title.length).toBeGreaterThan(0);
        expect(level.exercises.length).toBeGreaterThan(0);
      }
    }
  });

  test("every referenced exercise exists as a file and in the catalog", () => {
    for (const route of PRACTICE_ROUTES) {
      for (const id of routeExerciseIds(route)) {
        expect(existsSync(join(EXERCISES, `${id}.json`)), id).toBe(true);
        expect(practiceExercise(id), id).toBeDefined();
      }
    }
  });

  test("reaches every catalog exercise exactly once", () => {
    const referenced = PRACTICE_ROUTES.flatMap(routeExerciseIds).sort();
    expect(new Set(referenced).size).toBe(referenced.length);
    expect(referenced).toEqual(
      PRACTICE_EXERCISES.map((exercise) => exercise.id).sort(),
    );
    expect(PRACTICE_EXERCISES).toHaveLength(25);
  });

  test("looks routes and exercises up by id", () => {
    expect(practiceRoute("capa-2")?.title).toBe("Capa 2");
    expect(practiceRoute("nope")).toBeUndefined();
    expect(practiceExercise("l2-vlan-isolated")?.kind).toBe("configurar");
    expect(practiceExercise("nope")).toBeUndefined();
  });

  test("parses the authored files through the strict parser", () => {
    for (const name of routeFiles()) {
      const parsed = parsePracticeRoute(readRoute(name));
      const catalogued = practiceRoute(parsed.id);
      expect(catalogued).toEqual(parsed);
    }
  });

  test("keeps the authored base scenario, not the schema projection", () => {
    const vlan = practiceExercise("l2-vlan-isolated");
    expect(JSON.stringify(vlan?.base)).toContain('"vlan"');
    const routed = practiceExercise("rt-default-route");
    expect(JSON.stringify(routed?.base)).toContain('"routes"');
  });
});

describe("route parser", () => {
  const VALID: PracticeRoute = {
    version: 1,
    id: "capa-2",
    title: "Capa 2",
    summary: "Switches y VLANs.",
    levels: [
      { level: 1, title: "Aprender", exercises: ["l2-flood-vs-learn"] },
      { level: 2, title: "Aislar", exercises: ["l2-vlan-isolated"] },
    ],
  };

  test("accepts a well-formed route", () => {
    expect(parsePracticeRoute(VALID)).toEqual(VALID);
  });

  test("rejects malformed routes before the UI sees them", () => {
    const broken: ReadonlyArray<unknown> = [
      "capa-2",
      null,
      [],
      { ...VALID, version: 2 },
      { ...VALID, id: "" },
      { ...VALID, title: 5 },
      { ...VALID, summary: "" },
      { ...VALID, levels: [] },
      { ...VALID, levels: [{ level: 1, title: "Aprender", exercises: [] }] },
      {
        ...VALID,
        levels: [
          { level: 0, title: "Aprender", exercises: ["l2-flood-vs-learn"] },
        ],
      },
      {
        ...VALID,
        levels: [
          { level: 1, title: "Aprender", exercises: ["l2-flood-vs-learn"] },
          { level: 1, title: "Otra vez", exercises: ["l2-vlan-isolated"] },
        ],
      },
      {
        ...VALID,
        levels: [
          {
            level: 1,
            title: "Aprender",
            exercises: ["l2-flood-vs-learn", "l2-flood-vs-learn"],
          },
        ],
      },
    ];
    for (const value of broken) {
      expect(() => parsePracticeRoute(value), JSON.stringify(value)).toThrow();
    }
  });
});
