/**
 * Fase 6 / T3: the initial 25-exercise catalog, graded end to end.
 *
 * Every exercise is parsed with the T1 schema and every reference solution is
 * parsed with the CLI's own Scenario v1 parser, prepared by `prepareScenario`
 * (which appends the probes the checks need) and run through the *real*
 * `runScenario`. Nothing is mocked: a reference that only looks right fails
 * here, and so does a trap that only looks wrong.
 *
 * Catalog shape
 * -------------
 * `netlab-roadmap.md` §5.8 advertises "25 ejercicios" but its table has 26
 * bullets. The chosen merge (T3 design decision) folds the two Layer-2
 * bullets "aprendizaje del switch" and "inundación vs hub" into one exercise,
 * `l2-flood-vs-learn`, which contrasts a hub with a learning switch in the
 * same topology. Every other bullet is 1:1:
 *
 *   Capa 2 ......... 4  (merged bullet counted once)
 *   Direccionamiento 5
 *   Ruteo .......... 5
 *   ICMP/TTL ....... 3
 *   TCP/UDP ........ 5
 *   Servicios ...... 3
 *   total .......... 25
 *
 * Supported substitutions (documented, not silent)
 * ------------------------------------------------
 * - RIP is not implemented: `rt-convergence` grades static-route failover
 *   around a cut primary link (the roadmap bullet is "RIP y convergencia").
 * - A v1 scenario cannot instantiate `DnsServer`/`DhcpServer` (the CLI test
 *   wires those objects code-side), and the HTTP slice has no redirects.
 *   The Services block therefore grades the supported observables:
 *     `svc-dns-broken`     -> diagnose the DNS timeout and use the literal IP;
 *     `svc-dhcp-exhausted` -> DHCP silence, configure a static address;
 *     `svc-http-port`      -> no 3xx: discover the service on a non-standard port.
 * - Zero-window probing is a code-side TcpSocket option, not Scenario v1
 *   state: `tcp-zero-window` grades the observable window/cwnd via `ss`.
 * - Reno congestion dynamics are internal and the shell's sockets carry no
 *   trace bus: `tcp-congestion` grades the supported bandwidth bottleneck
 *   (`bandwidthBps`/`queueLimit`) instead of cwnd samples.
 * - The lab shell's `ping` has no DF flag: `icmp-frag-needed-df` carries the
 *   DF ping as a scenario action and grades the router's `state` records.
 *
 * Traps
 * -----
 * The starting scenario (the `base` authored in the exercise JSON) is the
 * default documented trap: submitting it unchanged must fail at least one
 * check. The raw JSON is used, not `ExerciseJSON.base`, because the exercise
 * schema keeps only the fields the validator reads (it drops VLAN port config
 * and router routes, which are exactly the faults of several traps). Two
 * exercises have a base that is already the reference (the retransmission
 * analysis and the closed-port contrast), so they ship an explicit
 * `<id>.trap.json`.
 *
 * Probes
 * ------
 * `prepareScenario` appends every ping/exec/arp probe at one virtual instant,
 * and the real runner executes shell actions synchronously. A second probe at
 * that instant can therefore observe a half-open handshake or an empty ARP
 * cache. Each exercise carries at most one shell probe; everything else is
 * trace/macTable/route evidence (plus ordinary traffic actions in `base`).
 * `icmp-frag-needed-df` is trace-only: its DF ping is a scenario action.
 *
 * Determinism: every seed is fixed in the exercise, the runner is awaited
 * once per verdict, and no test uses a wall clock or a live timer.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "../../cli/src/run";
import { parseScenarioJson, type Scenario } from "../../cli/src/scenario";
import {
  type ExerciseJSON,
  type ExerciseKind,
  type ExerciseValidationResult,
  parseExerciseJson,
  prepareScenario,
  validateExercise,
} from "../src/index";

const ROOT = join(import.meta.dir, "..");
const EXERCISES = join(ROOT, "exercises");
const SOLUTIONS = join(ROOT, "solutions");

type Block =
  | "Capa 2"
  | "Direccionamiento"
  | "Ruteo"
  | "ICMP/TTL"
  | "TCP/UDP"
  | "Servicios";

interface CatalogEntry {
  id: string;
  block: Block;
  kind: ExerciseKind;
  /** Explicit trap needed when `base` itself is the reference. */
  trapFile?: boolean;
}

const CATALOG: ReadonlyArray<CatalogEntry> = [
  // Capa 2 — 4 exercises: the first one is the documented merge.
  { id: "l2-flood-vs-learn", block: "Capa 2", kind: "configurar" },
  { id: "l2-vlan-isolated", block: "Capa 2", kind: "configurar" },
  { id: "l2-trunk-misconfigured", block: "Capa 2", kind: "diagnosticar" },
  { id: "l2-arp-spoofing", block: "Capa 2", kind: "diagnosticar" },
  // Direccionamiento — 5.
  { id: "ip-subnetting-basic", block: "Direccionamiento", kind: "configurar" },
  { id: "ip-vlsm", block: "Direccionamiento", kind: "configurar" },
  { id: "ip-wrong-mask", block: "Direccionamiento", kind: "diagnosticar" },
  { id: "ip-duplicate", block: "Direccionamiento", kind: "diagnosticar" },
  { id: "ip-missing-gateway", block: "Direccionamiento", kind: "configurar" },
  // Ruteo — 5. RIP is substituted by static-route failover.
  { id: "rt-two-networks", block: "Ruteo", kind: "configurar" },
  { id: "rt-default-route", block: "Ruteo", kind: "configurar" },
  { id: "rt-ttl-loop", block: "Ruteo", kind: "diagnosticar" },
  { id: "rt-specific-route", block: "Ruteo", kind: "diagnosticar" },
  { id: "rt-convergence", block: "Ruteo", kind: "diagnosticar" },
  // ICMP/TTL — 3.
  { id: "icmp-traceroute", block: "ICMP/TTL", kind: "diagnosticar" },
  { id: "icmp-mtu-fragmentation", block: "ICMP/TTL", kind: "diagnosticar" },
  { id: "icmp-frag-needed-df", block: "ICMP/TTL", kind: "diagnosticar" },
  // TCP/UDP — 5. Zero window and Reno are substituted by supported evidence.
  { id: "tcp-handshake", block: "TCP/UDP", kind: "construir" },
  {
    id: "tcp-retransmission",
    block: "TCP/UDP",
    kind: "analizar",
    trapFile: true,
  },
  { id: "tcp-zero-window", block: "TCP/UDP", kind: "analizar" },
  { id: "tcp-congestion", block: "TCP/UDP", kind: "optimizar" },
  {
    id: "tcp-closed-port",
    block: "TCP/UDP",
    kind: "analizar",
    trapFile: true,
  },
  // Servicios — 3 supported substitutes.
  { id: "svc-dns-broken", block: "Servicios", kind: "diagnosticar" },
  { id: "svc-dhcp-exhausted", block: "Servicios", kind: "diagnosticar" },
  { id: "svc-http-port", block: "Servicios", kind: "diagnosticar" },
];

const BLOCK_COUNTS: Readonly<Record<Block, number>> = {
  "Capa 2": 4,
  Direccionamiento: 5,
  Ruteo: 5,
  "ICMP/TTL": 3,
  "TCP/UDP": 5,
  Servicios: 3,
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Exercise files present on disk, sorted; empty before the catalog exists. */
function exerciseFiles(): Array<string> {
  if (!existsSync(EXERCISES)) {
    return [];
  }
  return readdirSync(EXERCISES)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function exercisePath(id: string): string {
  return join(EXERCISES, `${id}.json`);
}

function solutionPath(id: string): string {
  return join(SOLUTIONS, `${id}.json`);
}

function trapPath(id: string): string {
  return join(SOLUTIONS, `${id}.trap.json`);
}

function loadExercise(entry: CatalogEntry): ExerciseJSON {
  return parseExerciseJson(readJson(exercisePath(entry.id)));
}

function loadSolution(entry: CatalogEntry): unknown {
  return readJson(solutionPath(entry.id));
}

/** The authored base is the documented trap unless the exercise overrides it. */
function loadTrap(entry: CatalogEntry): unknown {
  if (entry.trapFile === true) {
    return readJson(trapPath(entry.id));
  }
  const raw = readJson(exercisePath(entry.id)) as { base?: unknown };
  return raw.base;
}

/**
 * Validate one candidate with the exact runner the `netlab` command uses.
 * `prepareScenario` pins the exercise seed and appends the probes; the cast
 * is the CLI's own check that the structural view is a Scenario.
 */
async function validate(
  exercise: ExerciseJSON,
  source: unknown,
): Promise<ExerciseValidationResult> {
  const scenario = parseScenarioJson(source);
  const prepared = prepareScenario(exercise, scenario);
  return validateExercise(exercise, prepared, (value) =>
    runScenario(value as Scenario),
  );
}

describe("catalog shape", () => {
  test("there are exactly the 25 catalog files", () => {
    const expected = CATALOG.map((entry) => `${entry.id}.json`).sort();
    expect(exerciseFiles()).toEqual(expected);
  });

  test("every block keeps its roadmap count after the L2 merge", () => {
    const counts: Record<string, number> = {};
    for (const entry of CATALOG) {
      counts[entry.block] = (counts[entry.block] ?? 0) + 1;
    }
    expect(counts).toEqual(BLOCK_COUNTS);
    expect(CATALOG).toHaveLength(25);
  });

  test("the merged L2 exercise contrasts flooding with learning", () => {
    const exercise = loadExercise({
      id: "l2-flood-vs-learn",
      block: "Capa 2",
      kind: "configurar",
    });
    const baseTypes = exercise.base.nodes.map((node) => node.type);
    expect(baseTypes).toContain("hub");
    expect(baseTypes).toContain("switch");
    const tables = exercise.checks.filter((check) => check.type === "macTable");
    expect(tables.length).toBeGreaterThanOrEqual(2);
    expect(exercise.objective).toMatch(/hub/i);
    expect(exercise.objective).toMatch(/switch/i);
  });

  test("Services documents the three supported substitutes", () => {
    const ids = CATALOG.filter((entry) => entry.block === "Servicios").map(
      (entry) => entry.id,
    );
    expect(ids).toEqual([
      "svc-dns-broken",
      "svc-dhcp-exhausted",
      "svc-http-port",
    ]);
  });

  test("the two explicit traps exist where the base is the reference", () => {
    for (const entry of CATALOG) {
      if (entry.trapFile === true) {
        expect(existsSync(trapPath(entry.id))).toBe(true);
      }
    }
  });

  test("each exercise keeps at most one shell probe for the real runner", () => {
    for (const entry of CATALOG) {
      const probes = loadExercise(entry).checks.filter(
        (check) =>
          check.type === "ping" ||
          check.type === "exec" ||
          check.type === "arp",
      );
      expect(probes.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("catalog exercises", () => {
  for (const entry of CATALOG) {
    test(`${entry.id}: parses with hints, seed and checks`, () => {
      const exercise = loadExercise(entry);
      expect(exercise.id).toBe(entry.id);
      expect(exercise.kind).toBe(entry.kind);
      expect(exercise.seed).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(exercise.seed)).toBe(true);
      expect(exercise.until).toBeDefined();
      expect(exercise.hints.length).toBeGreaterThanOrEqual(2);
      for (const hint of exercise.hints) {
        expect(hint.penalty).toBeGreaterThan(0);
      }
      expect(exercise.checks.length).toBeGreaterThanOrEqual(1);
    });

    test(`${entry.id}: the reference solution passes and is deterministic`, async () => {
      const exercise = loadExercise(entry);
      const solution = loadSolution(entry);

      const first = await validate(exercise, solution);
      expect(first.checks.filter((check) => !check.pass)).toEqual([]);
      expect(first.pass).toBe(true);
      expect(first.run.seed).toBe(exercise.seed);
      expect(first.run.finalTime).toBeGreaterThan(0);
      expect(first.run.processed).toBeGreaterThan(0);

      const second = await validate(exercise, solution);
      expect(second).toEqual(first);
    });

    test(`${entry.id}: the trap fails`, async () => {
      const exercise = loadExercise(entry);
      const trap = loadTrap(entry);

      const result = await validate(exercise, trap);
      expect(result.pass).toBe(false);
      expect(result.checks.some((check) => !check.pass)).toBe(true);
    });
  }
});
