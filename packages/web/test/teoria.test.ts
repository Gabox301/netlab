import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANDING_THEORY } from "../src/lib/landing";
import {
  TEORIA_EXERCISES,
  TEORIA_HERO,
  TEORIA_PRACTICE_NOTE,
  TEORIA_PRACTICE_ROUTE,
  TEORIA_ROUTE,
  TEORIA_SECTIONS,
  type TeoriaSection,
  teoriaAnchor,
} from "../src/lib/teoria";

/** Las cuatro secciones, en el orden de las capas. */
const EXPECTED_ANCHORS = ["capa-2-arp", "ipv4-icmp", "tcp", "dns-dhcp"];

/** Un slug de ancla: minúsculas, dígitos y guiones, sin empezar con guion. */
const ANCHOR = /^[a-z0-9][a-z0-9-]*$/;

const ROUTES_DIR = fileURLToPath(new URL("../src/routes/", import.meta.url));
const EXERCISES_DIR = fileURLToPath(
  new URL("../../exercises/exercises/", import.meta.url),
);

function routeFile(...parts: string[]): string {
  return join(ROUTES_DIR, ...parts);
}

function source(...parts: string[]): string {
  return readFileSync(routeFile(...parts), "utf8");
}

/** `id` → `title` de cada ejercicio real del catálogo, leído de disco. */
function catalog(): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(EXERCISES_DIR)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const raw: unknown = JSON.parse(
      readFileSync(join(EXERCISES_DIR, name), "utf8"),
    );
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`${name}: no es un objeto JSON`);
    }
    const { id, title } = raw as { id?: unknown; title?: unknown };
    if (typeof id !== "string" || typeof title !== "string") {
      throw new Error(`${name}: sin id o title`);
    }
    found.set(id, title);
  }
  return found;
}

/** Cada `href` estático o dinámico (`href={...}`) del fuente. */
function hrefs(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/href=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    found.push(match[1] ?? match[2] ?? "");
  }
  return found;
}

/** Ningún link puede apuntar a un `.md`: esos docs no se sirven en el sitio. */
function mdHrefs(text: string): string[] {
  return hrefs(text).filter((href) => /\.md\b/.test(href));
}

describe("secciones de /teoria (L4, S1)", () => {
  test("cuatro secciones en el orden de las capas", () => {
    expect(TEORIA_SECTIONS.map((section) => section.anchor)).toEqual(
      EXPECTED_ANCHORS,
    );
    expect(TEORIA_SECTIONS).toHaveLength(4);
  });

  test("anclas únicas y con forma de slug", () => {
    const anchors = TEORIA_SECTIONS.map((section) => section.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const anchor of anchors) {
      expect(anchor).toMatch(ANCHOR);
      expect(teoriaAnchor(anchor)).toBe(`#${anchor}`);
    }
  });

  test("cada sección trae título, un párrafo y una lista corta de conceptos", () => {
    for (const section of TEORIA_SECTIONS) {
      expect(section.title.trim().length).toBeGreaterThan(0);
      // Un párrafo: el resumen no se parte en líneas ni en viñetas.
      expect(section.summary.trim().length).toBeGreaterThan(200);
      expect(section.summary).not.toContain("\n");
      expect(section.concepts.length).toBeGreaterThanOrEqual(4);
      expect(section.concepts.length).toBeLessThanOrEqual(8);
      for (const concept of section.concepts) {
        expect(concept.label.trim().length).toBeGreaterThan(0);
        expect(concept.detail.trim().length).toBeGreaterThan(0);
        expect(concept.detail.trim()).not.toBe(concept.label.trim());
      }
      expect(section.exercises.length).toBeGreaterThan(0);
      for (const exercise of section.exercises) {
        expect(exercise.id.trim().length).toBeGreaterThan(0);
        expect(exercise.title.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("los conceptos no repiten etiqueta dentro de una sección", () => {
    for (const section of TEORIA_SECTIONS) {
      const labels = section.concepts.map((concept) => concept.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  test("el hero y la nota de práctica no quedan vacíos", () => {
    for (const value of Object.values(TEORIA_HERO)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
    expect(TEORIA_HERO.metaDescription.length).toBeLessThanOrEqual(200);
    expect(TEORIA_PRACTICE_NOTE).toContain("práctica");
    expect(TEORIA_ROUTE).toBe("/teoria");
    expect(TEORIA_PRACTICE_ROUTE).toBe("/practica");
  });
});

describe("ejercicios portados del catálogo real (L4)", () => {
  const real = catalog();

  test("cada id existe en packages/exercises y el título es el real", () => {
    expect(real.size).toBeGreaterThan(0);
    for (const exercise of TEORIA_EXERCISES) {
      expect(real.has(exercise.id)).toBe(true);
      expect(real.get(exercise.id)).toBe(exercise.title);
    }
  });

  test("los 25 ejercicios del catálogo aparecen una sola vez", () => {
    const listed = TEORIA_EXERCISES.map((exercise) => exercise.id);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...real.keys()].sort());
    expect(listed).toHaveLength(25);
  });

  test("cada id cae en la sección de su ruta", () => {
    const sectionOf = (anchor: string): TeoriaSection | undefined =>
      TEORIA_SECTIONS.find((section) => section.anchor === anchor);
    const ids = (anchor: string): string[] =>
      sectionOf(anchor)?.exercises.map((exercise) => exercise.id) ?? [];
    expect(ids("capa-2-arp")).toEqual([
      "l2-flood-vs-learn",
      "l2-vlan-isolated",
      "l2-trunk-misconfigured",
      "l2-arp-spoofing",
    ]);
    expect(ids("tcp")).toEqual([
      "tcp-handshake",
      "tcp-retransmission",
      "tcp-zero-window",
      "tcp-congestion",
      "tcp-closed-port",
    ]);
    expect(ids("dns-dhcp")).toEqual([
      "svc-dns-broken",
      "svc-dhcp-exhausted",
      "svc-http-port",
    ]);
    expect(ids("ipv4-icmp")).toContain("icmp-frag-needed-df");
    expect(ids("ipv4-icmp")).toContain("rt-default-route");
  });
});

describe("datos puros: lib/teoria.ts no renderiza (L4)", () => {
  const text = readFileSync(
    new URL("../src/lib/teoria.ts", import.meta.url),
    "utf8",
  );

  test("sin imports, sin Svelte y sin resolve()", () => {
    expect(text).not.toMatch(/^import /m);
    expect(text).not.toContain("$app/paths");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("</script>");
  });

  test("el contenido cita los comandos de la consola del host", () => {
    const details = TEORIA_SECTIONS.flatMap((section) =>
      section.concepts.map((concept) => concept.detail),
    ).join(" ");
    expect(details).toContain("ip addr show");
    expect(details).toContain("ip neigh show");
    expect(details).toContain("ip route show");
    expect(details).toContain("traceroute");
    expect(details).toContain("dhclient");
    expect(details).toContain("dig");
  });

  test("lo que solo existe en la CLI no se promete como UI web", () => {
    const all = JSON.stringify(TEORIA_SECTIONS);
    expect(all).not.toContain("netlab run");
    expect(all).not.toContain("netlab pcap");
    expect(all).not.toContain("tshark");
    expect(all).not.toContain(".pcap");
  });
});

describe("página /teoria (L4): índice, anclas y ejercicios", () => {
  const text = source("teoria", "+page.svelte");

  test("skip-link sin animación", () => {
    expect(text).toContain('class="skip"');
    expect(text).toContain('href="#indice"');
    expect(text).not.toMatch(/animation|@keyframes|transition:/);
  });

  test("el índice usa las anclas de las secciones", () => {
    expect(text).toContain("teoriaAnchor(section.anchor)");
    expect(text).toContain("id={section.anchor}");
    expect(text).toContain("TEORIA_SECTIONS");
  });

  test("cada ejercicio linkea la ruta de práctica y se nombra por título", () => {
    expect(text).toContain('href={resolve("/practica")}>{exercise.title}</a>');
    expect(text).not.toContain('resolve("/practica/');
    expect(text).not.toContain("?exercise=");
  });

  test("ningún href apunta a un .md", () => {
    expect(mdHrefs(text)).toEqual([]);
    expect(text).not.toMatch(/docs\/teoria/);
  });
});

describe("la landing repunta la teoría a /teoria (L4)", () => {
  const text = source("+page.svelte");

  test("los datos de teoría apuntan a la ruta, con ancla", () => {
    const anchors = TEORIA_SECTIONS.map((section) => section.anchor);
    for (const item of LANDING_THEORY) {
      expect(item.href).toBe(TEORIA_ROUTE);
      expect(anchors).toContain(item.anchor);
    }
    expect(new Set(LANDING_THEORY.map((item) => item.anchor)).size).toBe(
      LANDING_THEORY.length,
    );
  });

  test("la página enlaza /teoria y ya no muestra el path del doc", () => {
    expect(text).toContain('resolve("/teoria")');
    expect(text).toContain("resolve(item.href)");
    expect(text).toContain("item.anchor");
    expect(text).not.toContain("item.doc");
  });

  test("ningún link visible de la landing apunta a un .md", () => {
    expect(mdHrefs(text)).toEqual([]);
    expect(text).not.toMatch(/\.md\b/);
  });
});
