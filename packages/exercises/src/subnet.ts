/**
 * Subnetting trainer (F-117): random drills plus a step-by-step correction.
 *
 * Four themes, each one a pure function of an injected PRNG:
 *
 * - `cidr`    — given `ip/len`, derive network, broadcast, mask, the usable
 *               range and how many hosts fit;
 * - `vlsm`    — given a base block and a list of host demands, assign the
 *               subnets with VLSM (largest first, power-of-two blocks);
 * - `summary` — given several networks, compute the minimal supernet;
 * - `usable`  — given `ip/len`, derive the usable range and the broadcast.
 *
 * Every drill returns `steps`, the correction explained octet by octet, and a
 * `check(answer)` that grades a whitespace-separated list of answers and hands
 * the same steps back. Grading is exact after trimming, lowercasing and
 * comparing whole numbers numerically, so `062` and `62` are the same answer
 * but `10.0.0.05` is not `10.0.0.5`.
 *
 * Determinism: the only source of randomness is the injected `rand`, exactly
 * like `sim.random.next()`. Nothing here reads `Math.random()` or the clock,
 * so a seed plus a theme always replays the same drill (S1, ADR-001).
 *
 * Address arithmetic note: this package does not declare `@netlab/bytes` (the
 * workspace links only the declared dependencies), so the 32-bit helpers below
 * are local. The mask itself still comes from `@netlab/core` (`prefixToMask`),
 * the canonical implementation, so the `/0`–`/32` edges are never hand-rolled.
 */

import { prefixToMask } from "@netlab/core";

/** Drill themes the trainer can generate. */
export const SUBNET_TOPICS = ["cidr", "vlsm", "summary", "usable"] as const;

/** One drill theme. */
export type SubnetTopic = (typeof SUBNET_TOPICS)[number];

/** Injected randomness: the same shape as `sim.random.next`. */
export type SubnetRandom = () => number;

/** Outcome of grading one answer. */
export interface SubnetCheck {
  /** True when every field matched. */
  readonly pass: boolean;
  /** The canonical answer, one `field=value` pair per asked field. */
  readonly expected: string;
  /** The correction, explained step by step. */
  readonly steps: ReadonlyArray<string>;
}

/** One generated drill. */
export interface SubnetProblem {
  readonly topic: SubnetTopic;
  /** Short label, e.g. `CIDR: 10.0.0.5/26`. */
  readonly title: string;
  /** The statement, in the same Spanish the exercise catalog uses. */
  readonly prompt: string;
  /** Field names, in the order the answers must be given. */
  readonly fields: ReadonlyArray<string>;
  /** Canonical answers, aligned with {@link fields}. */
  readonly expected: ReadonlyArray<string>;
  /** The correction, explained step by step. */
  readonly steps: ReadonlyArray<string>;
  /** Grade one whitespace-separated answer list. */
  check(answer: string): SubnetCheck;
}

/** True for a known {@link SubnetTopic}. */
export function isSubnetTopic(value: string): value is SubnetTopic {
  return (SUBNET_TOPICS as ReadonlyArray<string>).includes(value);
}

/* -------------------------------------------------------------------------- */
/* 32-bit IPv4 helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Dotted quad for an unsigned 32-bit word. */
function dottedOf(value: number): string {
  const v = value >>> 0;
  return (
    `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.` +
    `${(v >>> 8) & 0xff}.${v & 0xff}`
  );
}

/** `10.0.0.5` as `00001010.00000000.00000000.00000101`. */
function binaryOf(value: number): string {
  const shifts = [24, 16, 8, 0];
  return shifts
    .map((shift) => ((value >>> shift) & 0xff).toString(2).padStart(8, "0"))
    .join(".");
}

/** Build a word from four octets. */
function word(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Dotted mask of a prefix, from the canonical implementation. */
function maskOf(prefixLength: number): number {
  return prefixToMask(prefixLength).toU32();
}

/** Address with the host bits cleared. */
function networkOf(address: number, prefixLength: number): number {
  return (address & maskOf(prefixLength)) >>> 0;
}

/** Last address of the block. */
function broadcastOf(address: number, prefixLength: number): number {
  return (
    (networkOf(address, prefixLength) | (~maskOf(prefixLength) >>> 0)) >>> 0
  );
}

/** Total addresses in a block. */
function sizeOf(prefixLength: number): number {
  return 2 ** (32 - prefixLength);
}

/** Smallest power of two that is `>= value`. */
function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value));
}

/** Prefix length of a power-of-two block size. */
function prefixOfSize(size: number): number {
  return 32 - Math.log2(size);
}

/** Starting blocks the drills borrow addresses from (documentation ranges). */
const BASE_POOL: ReadonlyArray<number> = [
  word(10, 0, 0, 0),
  word(10, 10, 0, 0),
  word(172, 16, 8, 0),
  word(192, 168, 1, 0),
  word(203, 0, 113, 0),
  word(198, 51, 100, 0),
];

/** Base prefixes the VLSM drills start from: a `/23` or a `/24`. */
const VLSM_BASE_PREFIXES: ReadonlyArray<number> = [23, 24];

/* -------------------------------------------------------------------------- */
/* PRNG helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Read one draw, rejecting a source that is not a `[0, 1)` PRNG. */
function nextDraw(rand: SubnetRandom): number {
  const value = rand();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(
      `subnet random source must return values in [0, 1): ${value}`,
    );
  }
  return value;
}

/** Integer in `[min, max]`, both inclusive. */
function randomInt(rand: SubnetRandom, min: number, max: number): number {
  const span = max - min + 1;
  return min + Math.floor(nextDraw(rand) * span);
}

/** One element, chosen uniformly. */
function pick<T>(rand: SubnetRandom, items: ReadonlyArray<T>): T {
  return at(items, randomInt(rand, 0, items.length - 1));
}

/** Indexed read that fails loudly instead of returning `undefined`. */
function at<T>(items: ReadonlyArray<T>, index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new RangeError(`missing index ${index} of ${items.length}`);
  }
  return value;
}

/** `50, 14 y 6`: Spanish list with the last item joined by `y`. */
function joinEs(items: ReadonlyArray<string>): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} y ${at(items, items.length - 1)}`;
}

/* -------------------------------------------------------------------------- */
/* Grading                                                                    */
/* -------------------------------------------------------------------------- */

/** `red=10.0.0.0 broadcast=10.0.0.63`: the canonical answer line. */
function labelled(
  fields: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): string {
  return fields
    .map((field, index) => `${field}=${at(expected, index)}`)
    .join(" ");
}

/** One answer token against one expected token. */
function tokenMatches(answer: string, expected: string): boolean {
  const left = answer.trim().toLowerCase();
  const right = expected.trim().toLowerCase();
  if (left === right) {
    return true;
  }
  const integer = /^-?[0-9]+$/;
  return (
    integer.test(left) && integer.test(right) && Number(left) === Number(right)
  );
}

interface ProblemInput {
  readonly topic: SubnetTopic;
  readonly title: string;
  readonly prompt: string;
  readonly fields: ReadonlyArray<string>;
  readonly expected: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
}

/** Assemble a drill and its grader. */
function problem(input: ProblemInput): SubnetProblem {
  return {
    topic: input.topic,
    title: input.title,
    prompt: input.prompt,
    fields: input.fields,
    expected: input.expected,
    steps: input.steps,
    check(answer: string): SubnetCheck {
      const tokens = answer
        .split(/[\s,;]+/)
        .filter((token) => token.length > 0);
      const pass =
        tokens.length === input.expected.length &&
        tokens.every((token, index) =>
          tokenMatches(token, at(input.expected, index)),
        );
      return {
        pass,
        expected: labelled(input.fields, input.expected),
        steps: input.steps,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* cidr                                                                       */
/* -------------------------------------------------------------------------- */

/** One address inside a fresh block, plus every edge derived from it. */
interface HostBlock {
  /** The address as given, with its prefix length. */
  readonly given: string;
  readonly prefixLength: number;
  readonly address: number;
  readonly network: number;
  readonly broadcast: number;
  /** Dotted mask. */
  readonly mask: number;
  readonly first: number;
  readonly last: number;
  /** Addresses left after removing the network and broadcast addresses. */
  readonly hosts: number;
  readonly size: number;
}

/** Draw a usable host address and derive its block edges. */
function drawHostBlock(rand: SubnetRandom): HostBlock {
  const prefixLength = randomInt(rand, 8, 30);
  const base = networkOf(pick(rand, BASE_POOL), prefixLength);
  const size = sizeOf(prefixLength);
  const address = (base + randomInt(rand, 1, size - 2)) >>> 0;
  const network = networkOf(address, prefixLength);
  const broadcast = broadcastOf(address, prefixLength);
  const mask = maskOf(prefixLength);
  return {
    given: `${dottedOf(address)}/${prefixLength}`,
    prefixLength,
    address,
    network,
    broadcast,
    mask,
    first: (network + 1) >>> 0,
    last: (broadcast - 1) >>> 0,
    hosts: size - 2,
    size,
  };
}

const CIDR_FIELDS: ReadonlyArray<string> = [
  "red",
  "broadcast",
  "mascara",
  "primera",
  "ultima",
  "hosts",
];

function cidrProblem(rand: SubnetRandom): SubnetProblem {
  const block = drawHostBlock(rand);
  const { given, prefixLength, network, broadcast } = block;
  const mask = dottedOf(block.mask);

  const expected = [
    dottedOf(network),
    dottedOf(broadcast),
    mask,
    dottedOf(block.first),
    dottedOf(block.last),
    String(block.hosts),
  ];

  const steps = [
    `Paso 1: /${prefixLength} deja ${32 - prefixLength} bits de host: ` +
      `máscara = ${mask} (${binaryOf(block.mask)}).`,
    `Paso 2: ${dottedOf(block.address)} = ${binaryOf(block.address)}.`,
    `Paso 3: red = ${dottedOf(block.address)} AND ${mask} = ` +
      `${dottedOf(network)} (${binaryOf(network)}), los bits de host en cero.`,
    `Paso 4: broadcast = red OR ${dottedOf(~block.mask >>> 0)} = ` +
      `${dottedOf(broadcast)} (${binaryOf(broadcast)}), todos los bits de ` +
      "host en uno.",
    `Paso 5: primera útil = ${dottedOf(network)} + 1 = ` +
      `${dottedOf(block.first)}; última útil = ${dottedOf(broadcast)} - 1 = ` +
      `${dottedOf(block.last)}.`,
    `Paso 6: hosts útiles = 2^(${32 - prefixLength}) - 2 = ` +
      `2^${32 - prefixLength} - 2 = ${block.size} - 2 = ${block.hosts}.`,
  ];

  return problem({
    topic: "cidr",
    title: `CIDR: ${given}`,
    prompt:
      `Dada ${given}, calculá red, broadcast, máscara, primera y última ` +
      "dirección útil, y hosts útiles.",
    fields: CIDR_FIELDS,
    expected,
    steps,
  });
}

/* -------------------------------------------------------------------------- */
/* usable                                                                     */
/* -------------------------------------------------------------------------- */

const USABLE_FIELDS: ReadonlyArray<string> = ["primera", "ultima", "broadcast"];

function usableProblem(rand: SubnetRandom): SubnetProblem {
  const block = drawHostBlock(rand);
  const { given, prefixLength, network, broadcast } = block;
  const mask = dottedOf(block.mask);

  const expected = [
    dottedOf(block.first),
    dottedOf(block.last),
    dottedOf(broadcast),
  ];

  const steps = [
    `Paso 1: /${prefixLength} deja ${32 - prefixLength} bits de host: ` +
      `máscara = ${mask} (${binaryOf(block.mask)}).`,
    `Paso 2: ${dottedOf(block.address)} = ${binaryOf(block.address)}.`,
    `Paso 3: red = ${dottedOf(block.address)} AND ${mask} = ` +
      `${dottedOf(network)}; broadcast = red OR ${dottedOf(~block.mask >>> 0)} ` +
      `= ${dottedOf(broadcast)}.`,
    `Paso 4: primera útil = ${dottedOf(network)} + 1 = ` +
      `${dottedOf(block.first)}; última útil = ${dottedOf(broadcast)} - 1 = ` +
      `${dottedOf(block.last)}.`,
    `Paso 5: el bloque tiene ${block.size} direcciones y quedan ` +
      `${block.hosts} útiles: la de red y el broadcast no se asignan.`,
  ];

  return problem({
    topic: "usable",
    title: `Rango útil: ${given}`,
    prompt:
      `Dada ${given}, calculá la primera y la última dirección útil, y el ` +
      "broadcast.",
    fields: USABLE_FIELDS,
    expected,
    steps,
  });
}

/* -------------------------------------------------------------------------- */
/* vlsm                                                                       */
/* -------------------------------------------------------------------------- */

/** Host demands that map to distinct block sizes (4, 8, 16, 32, 64). */
const HOST_POOL: ReadonlyArray<number> = [2, 6, 14, 30, 62];

interface Assignment {
  readonly network: number;
  readonly prefixLength: number;
}

function vlsmProblem(rand: SubnetRandom): SubnetProblem {
  const basePrefix = pick(rand, VLSM_BASE_PREFIXES);
  const base = networkOf(pick(rand, BASE_POOL), basePrefix);
  const count = randomInt(rand, 2, 3);

  // Distinct demands, so every label maps to exactly one block.
  const pool = [...HOST_POOL];
  const demands: Array<number> = [];
  for (let index = 0; index < count; index++) {
    const chosen = randomInt(rand, 0, pool.length - 1);
    demands.push(at(pool.splice(chosen, 1), 0));
  }

  // VLSM: allocate largest first from the start of the base block. Sizes are
  // powers of two, so every following block stays naturally aligned.
  const order = demands
    .map((need, index) => ({ need, index }))
    .sort((left, right) => right.need - left.need || left.index - right.index);
  const assigned: Array<Assignment> = [];
  let cursor = base;
  for (const item of order) {
    const block = nextPowerOfTwo(item.need + 2);
    const prefixLength = prefixOfSize(block);
    assigned[item.index] = { network: cursor, prefixLength };
    cursor += block;
  }

  const fields = Array.from({ length: count }, (_, index) => `red${index + 1}`);
  const expected: Array<string> = [];
  for (let index = 0; index < count; index++) {
    const block = assigned[index];
    if (block === undefined) {
      throw new RangeError(`missing VLSM assignment ${index}`);
    }
    expected.push(`${dottedOf(block.network)}/${block.prefixLength}`);
  }

  const steps: Array<string> = [
    `Paso 1: ordená los pedidos de mayor a menor: ${joinEs(
      order.map((item) => String(item.need)),
    )} hosts. Ese es el orden en que se asignan los bloques.`,
  ];
  for (const item of order) {
    const block = nextPowerOfTwo(item.need + 2);
    const assignment = assigned[item.index];
    if (assignment === undefined) {
      throw new RangeError(`missing VLSM assignment for ${item.need}`);
    }
    steps.push(
      `Paso ${steps.length + 1}: ${item.need} + 2 = ${item.need + 2} → ` +
        `siguiente potencia de 2 = ${block} = /${assignment.prefixLength} → ` +
        `red${item.index + 1} = ${dottedOf(assignment.network)}/` +
        `${assignment.prefixLength}.`,
    );
  }
  const baseEnd = (base + sizeOf(basePrefix) - 1) >>> 0;
  const free = sizeOf(basePrefix) - (cursor - base);
  steps.push(
    free > 0
      ? `Paso ${steps.length + 1}: quedan libres ${dottedOf(cursor)} - ` +
          `${dottedOf(baseEnd)} (${free} direcciones) para futuras subredes.`
      : `Paso ${steps.length + 1}: el reparto usa el bloque completo, sin ` +
          "espacio para más subredes.",
  );

  return problem({
    topic: "vlsm",
    title: `VLSM: ${dottedOf(base)}/${basePrefix} en ${count} subredes`,
    prompt:
      `Repartí ${dottedOf(base)}/${basePrefix} para ` +
      `${joinEs(demands.map((need) => String(need)))} hosts con VLSM, en ese ` +
      "orden.",
    fields,
    expected,
    steps,
  });
}

/* -------------------------------------------------------------------------- */
/* summary                                                                    */
/* -------------------------------------------------------------------------- */

function summaryProblem(rand: SubnetRandom): SubnetProblem {
  const parentPrefix = randomInt(rand, 16, 24);
  const base = networkOf(pick(rand, BASE_POOL), parentPrefix);
  const count = randomInt(rand, 2, 4);
  // Four slots (two extra bits) always fit the three or four blocks.
  const split = count <= 2 ? randomInt(rand, 1, 2) : 2;
  const blockPrefix = parentPrefix + split;
  const blockSize = sizeOf(blockPrefix);
  const slots = 2 ** split;

  const indices = Array.from({ length: slots }, (_, index) => index);
  for (let index = 0; index < count; index++) {
    const other = randomInt(rand, index, slots - 1);
    const left = at(indices, index);
    const right = at(indices, other);
    indices[index] = right;
    indices[other] = left;
  }
  const chosen = indices.slice(0, count);
  const networks = chosen.map((slot) => (base + slot * blockSize) >>> 0);
  const given = networks.map(
    (network) => `${dottedOf(network)}/${blockPrefix}`,
  );

  const first = at(networks, 0);
  const differing = networks.reduce(
    (accumulator, network) => accumulator | (network ^ first),
    0,
  );
  const commonPrefix = Math.clz32(differing);
  const supernet = networkOf(first, commonPrefix);
  const answer = `${dottedOf(supernet)}/${commonPrefix}`;

  const steps: Array<string> = given.map(
    (text, index) =>
      `Paso ${index + 1}: ${text} = ${binaryOf(at(networks, index))}.`,
  );
  steps.push(
    `Paso ${steps.length + 1}: comparando en binario, los primeros ` +
      `${commonPrefix} bits son iguales y el bit ${commonPrefix + 1} ya ` +
      "difiere.",
  );
  steps.push(
    `Paso ${steps.length + 1}: supernet = ${answer} (rango ` +
      `${dottedOf(supernet)} - ${dottedOf(broadcastOf(supernet, commonPrefix))}).`,
  );

  return problem({
    topic: "summary",
    title: `Resumen: ${given.length} redes en ${answer}`,
    prompt: `Resumí ${joinEs(given)} en la supernet mínima.`,
    fields: ["supernet"],
    expected: [answer],
    steps,
  });
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Generate one drill of `topic` from `rand`.
 *
 * The PRNG is the only source of variation, so the same seed and theme always
 * replay the same drill. A broken `rand` (outside `[0, 1)`) is a programming
 * error and throws `RangeError`.
 */
export function generateSubnetProblem(
  topic: SubnetTopic,
  rand: SubnetRandom,
): SubnetProblem {
  switch (topic) {
    case "cidr":
      return cidrProblem(rand);
    case "vlsm":
      return vlsmProblem(rand);
    case "summary":
      return summaryProblem(rand);
    case "usable":
      return usableProblem(rand);
    default: {
      const unknown: never = topic;
      throw new TypeError(`unknown subnet topic: ${String(unknown)}`);
    }
  }
}
