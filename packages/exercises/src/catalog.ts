/**
 * Practice catalog (F-115): the 25 authored exercises plus the four learning
 * routes, loaded through static imports so the browser bundle carries them
 * and no request is needed at runtime.
 *
 * Every payload is validated at load time (`parseExerciseJson` for the
 * exercises, `parsePracticeRoute` for the routes), so a malformed file reaches
 * neither the UI nor a validator silently.
 *
 * The raw exercise object is kept, not the parsed projection: the exercise
 * schema deliberately keeps only the fields a validator reads (it drops VLAN
 * port config and router routes), and those are exactly the preinstalled
 * faults the student starts from.
 */

import { type ExerciseJSON, parseExerciseJson } from "./schema";

/** Wire version of `routes/*.json`, owned by this slice. */
export const PRACTICE_ROUTE_VERSION = 1;

/** One level of a learning route (F-115). */
export interface PracticeRouteLevel {
  /** 1-based position; authored levels increase without gaps. */
  level: number;
  title: string;
  /** Exercise ids, in the order the route lists them. */
  exercises: Array<string>;
}

/** A learning route: ordered levels over the exercise catalog. */
export interface PracticeRoute {
  version: typeof PRACTICE_ROUTE_VERSION;
  id: string;
  title: string;
  summary: string;
  levels: Array<PracticeRouteLevel>;
}

/** Route and level an exercise belongs to, for the practice detail panel. */
export interface PracticeLocation {
  route: PracticeRoute;
  level: PracticeRouteLevel;
}

/* -------------------------------------------------------------------------- */
/* Authored JSON                                                              */
/* -------------------------------------------------------------------------- */

import rawIcmpFragNeededDf from "../exercises/icmp-frag-needed-df.json";
import rawIcmpMtuFragmentation from "../exercises/icmp-mtu-fragmentation.json";
import rawIcmpTraceroute from "../exercises/icmp-traceroute.json";
import rawIpDuplicate from "../exercises/ip-duplicate.json";
import rawIpMissingGateway from "../exercises/ip-missing-gateway.json";
import rawIpSubnettingBasic from "../exercises/ip-subnetting-basic.json";
import rawIpVlsm from "../exercises/ip-vlsm.json";
import rawIpWrongMask from "../exercises/ip-wrong-mask.json";
import rawL2ArpSpoofing from "../exercises/l2-arp-spoofing.json";
import rawL2FloodVsLearn from "../exercises/l2-flood-vs-learn.json";
import rawL2TrunkMisconfigured from "../exercises/l2-trunk-misconfigured.json";
import rawL2VlanIsolated from "../exercises/l2-vlan-isolated.json";
import rawRtConvergence from "../exercises/rt-convergence.json";
import rawRtDefaultRoute from "../exercises/rt-default-route.json";
import rawRtSpecificRoute from "../exercises/rt-specific-route.json";
import rawRtTtlLoop from "../exercises/rt-ttl-loop.json";
import rawRtTwoNetworks from "../exercises/rt-two-networks.json";
import rawSvcDhcpExhausted from "../exercises/svc-dhcp-exhausted.json";
import rawSvcDnsBroken from "../exercises/svc-dns-broken.json";
import rawSvcHttpPort from "../exercises/svc-http-port.json";
import rawTcpClosedPort from "../exercises/tcp-closed-port.json";
import rawTcpCongestion from "../exercises/tcp-congestion.json";
import rawTcpHandshake from "../exercises/tcp-handshake.json";
import rawTcpRetransmission from "../exercises/tcp-retransmission.json";
import rawTcpZeroWindow from "../exercises/tcp-zero-window.json";
import rawCapa2 from "../routes/capa-2.json";
import rawDireccionamientoYRuteo from "../routes/direccionamiento-y-ruteo.json";
import rawServiciosDeRed from "../routes/servicios-de-red.json";
import rawTcpAFondo from "../routes/tcp-a-fondo.json";

/** Catalog order: Layer 2, addressing, routing, ICMP, TCP, services. */
const EXERCISE_SOURCES: ReadonlyArray<unknown> = [
  rawL2FloodVsLearn,
  rawL2VlanIsolated,
  rawL2TrunkMisconfigured,
  rawL2ArpSpoofing,
  rawIpSubnettingBasic,
  rawIpVlsm,
  rawIpWrongMask,
  rawIpDuplicate,
  rawIpMissingGateway,
  rawRtTwoNetworks,
  rawRtDefaultRoute,
  rawRtTtlLoop,
  rawRtSpecificRoute,
  rawRtConvergence,
  rawIcmpTraceroute,
  rawIcmpMtuFragmentation,
  rawIcmpFragNeededDf,
  rawTcpHandshake,
  rawTcpRetransmission,
  rawTcpZeroWindow,
  rawTcpCongestion,
  rawTcpClosedPort,
  rawSvcDnsBroken,
  rawSvcDhcpExhausted,
  rawSvcHttpPort,
];

/** Roadmap order: the four learning routes of Fase 6. */
const ROUTE_SOURCES: ReadonlyArray<unknown> = [
  rawCapa2,
  rawDireccionamientoYRuteo,
  rawTcpAFondo,
  rawServiciosDeRed,
];

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Validate one authored exercise and return it untouched.
 *
 * `parseExerciseJson` is the schema gate; its parsed view would drop the
 * VLAN/routes fields of the trap, so only its verdict is used.
 */
function loadExercise(raw: unknown, index: number): ExerciseJSON {
  try {
    parseExerciseJson(raw);
  } catch (cause) {
    throw new Error(
      `practice catalog exercises[${index}]: ${messageOf(cause)}`,
    );
  }
  return raw as ExerciseJSON;
}

/* -------------------------------------------------------------------------- */
/* Route parser                                                               */
/* -------------------------------------------------------------------------- */

function failRoute(path: string, why: string): Error {
  return new Error(path === "" ? `route: ${why}` : `route ${path}: ${why}`);
}

function routeRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw failRoute(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function routeString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw failRoute(path, `"${key}" must be a non-empty string`);
  }
  return value;
}

function routeArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): Array<unknown> {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw failRoute(path, `"${key}" must be an array`);
  }
  return value;
}

function routeInteger(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw failRoute(path, `"${key}" must be an integer >= ${min}: ${value}`);
  }
  return value;
}

function routeExerciseId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw failRoute(path, "exercise ids must be non-empty strings");
  }
  return value;
}

/**
 * Parse one `routes/*.json` document (F-115).
 *
 * The parser is structural: it cannot know the catalog (that would make it
 * circular), so "the id exists" is the routes test's invariant, while
 * versions, ordering, duplicates and required fields fail here.
 */
export function parsePracticeRoute(value: unknown): PracticeRoute {
  const obj = routeRecord(value, "");
  if (obj["version"] !== PRACTICE_ROUTE_VERSION) {
    throw failRoute(
      "",
      `"version" must be ${PRACTICE_ROUTE_VERSION}, got ${JSON.stringify(obj["version"])}`,
    );
  }
  const id = routeString(obj, "id", "");
  const title = routeString(obj, "title", "");
  const summary = routeString(obj, "summary", "");
  const rawLevels = routeArray(obj, "levels", "");
  if (rawLevels.length === 0) {
    throw failRoute("", `"levels" needs at least one level`);
  }
  const seen = new Set<string>();
  const levels: Array<PracticeRouteLevel> = [];
  let previous = 0;
  rawLevels.forEach((entry, levelIndex) => {
    const path = `levels[${levelIndex}]`;
    const levelObj = routeRecord(entry, path);
    const level = routeInteger(levelObj, "level", path, 1);
    if (level <= previous) {
      throw failRoute(path, `"level" must increase across levels: ${level}`);
    }
    previous = level;
    const levelTitle = routeString(levelObj, "title", path);
    const rawExercises = routeArray(levelObj, "exercises", path);
    if (rawExercises.length === 0) {
      throw failRoute(path, `"exercises" needs at least one exercise id`);
    }
    const exercises = rawExercises.map((entryId, exerciseIndex) => {
      const exerciseId = routeExerciseId(
        entryId,
        `${path}.exercises[${exerciseIndex}]`,
      );
      if (seen.has(exerciseId)) {
        throw failRoute(
          `${path}.exercises[${exerciseIndex}]`,
          `duplicate exercise id ${JSON.stringify(exerciseId)}`,
        );
      }
      seen.add(exerciseId);
      return exerciseId;
    });
    levels.push({ level, title: levelTitle, exercises });
  });
  return { version: PRACTICE_ROUTE_VERSION, id, title, summary, levels };
}

function loadRoute(raw: unknown, index: number): PracticeRoute {
  try {
    return parsePracticeRoute(raw);
  } catch (cause) {
    throw new Error(`practice catalog routes[${index}]: ${messageOf(cause)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

/** The 25 authored exercises, raw so the trap topology survives. */
export const PRACTICE_EXERCISES: ReadonlyArray<ExerciseJSON> =
  EXERCISE_SOURCES.map((raw, index) => loadExercise(raw, index));

/** The four learning routes (F-115). */
export const PRACTICE_ROUTES: ReadonlyArray<PracticeRoute> = ROUTE_SOURCES.map(
  (raw, index) => loadRoute(raw, index),
);

const EXERCISE_INDEX: ReadonlyMap<string, ExerciseJSON> = new Map(
  PRACTICE_EXERCISES.map((exercise) => [exercise.id, exercise]),
);

const ROUTE_INDEX: ReadonlyMap<string, PracticeRoute> = new Map(
  PRACTICE_ROUTES.map((route) => [route.id, route]),
);

/** One exercise by id; `undefined` when the catalog does not have it. */
export function practiceExercise(id: string): ExerciseJSON | undefined {
  return EXERCISE_INDEX.get(id);
}

/** One learning route by id. */
export function practiceRoute(id: string): PracticeRoute | undefined {
  return ROUTE_INDEX.get(id);
}

/** Route and level listing `exerciseId`, for the detail breadcrumb. */
export function practiceLocation(
  exerciseId: string,
): PracticeLocation | undefined {
  for (const route of PRACTICE_ROUTES) {
    for (const level of route.levels) {
      if (level.exercises.includes(exerciseId)) {
        return { route, level };
      }
    }
  }
  return undefined;
}
