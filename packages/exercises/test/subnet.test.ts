/**
 * F-117 / T4: the subnetting trainer (CIDR, VLSM, route summarization and
 * usable-range drills).
 *
 * The generator is pure and takes an injected PRNG (`rand`), so every test
 * pins a seed: the same seed must replay the exact same drill, and nothing in
 * the module may reach for `Math.random` or the clock. The assertions check
 * the *arithmetic*, not the implementation: each expected answer is verified
 * against the definitions (network = ip AND mask, broadcast = network OR
 * ~mask, hosts = 2^(32-prefix) - 2, supernet = longest common prefix), which
 * is what a wrong generator cannot fake.
 */

import { describe, expect, test } from "bun:test";
import {
  Host,
  Mulberry32,
  prefixFromMask,
  prefixToMask,
  Simulation,
  TraceBus,
} from "@netlab/core";
import { Shell, type SubnetTrainer } from "@netlab/shell";
import {
  generateSubnetProblem,
  isSubnetTopic,
  SUBNET_TOPICS,
  type SubnetProblem,
  type SubnetTopic,
} from "../src/index";

/** Seeded `rand` in `[0, 1)`, the same shape `sim.random.next` provides. */
function prng(seed: number): () => number {
  const random = new Mulberry32(seed);
  return () => random.next();
}

/** Indexed read that fails loudly instead of returning `undefined`. */
function at<T>(items: ReadonlyArray<T>, index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`missing index ${index} in ${JSON.stringify(items)}`);
  }
  return value;
}

/** Dotted quad as an unsigned 32-bit word. */
function u32Of(text: string): number {
  const parts = text.split(".");
  if (parts.length !== 4) {
    throw new Error(`not an IPv4 address: ${text}`);
  }
  let value = 0;
  for (const part of parts) {
    value = value * 256 + Number(part);
  }
  return value >>> 0;
}

/** Dotted quad for an unsigned 32-bit word. */
function dottedOf(value: number): string {
  const v = value >>> 0;
  return (
    `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.` +
    `${(v >>> 8) & 0xff}.${v & 0xff}`
  );
}

/** Total addresses in a block. */
function sizeOf(prefixLength: number): number {
  return 2 ** (32 - prefixLength);
}

interface Block {
  /** Address as written. */
  readonly raw: number;
  /** Address with the host bits cleared. */
  readonly network: number;
  readonly prefixLength: number;
  readonly size: number;
}

/** Parse `10.0.0.0/26`, keeping the raw address so alignment is checkable. */
function parseBlock(text: string): Block {
  const [address, prefixText] = text.split("/");
  if (address === undefined || prefixText === undefined) {
    throw new Error(`not a CIDR block: ${text}`);
  }
  const prefixLength = Number(prefixText);
  const size = sizeOf(prefixLength);
  const raw = u32Of(address);
  return { raw, network: raw - (raw % size), prefixLength, size };
}

/** Capture groups of a required match; fails loudly when the prompt drifts. */
function captures(pattern: RegExp, text: string): ReadonlyArray<string> {
  const match = pattern.exec(text);
  if (match === null) {
    throw new Error(`prompt does not match ${pattern}: ${text}`);
  }
  return match.slice(1).map((group) => group ?? "");
}

/** Every `a.b.c.d/len` mentioned in a prompt, in order. */
function cidrsIn(text: string): Array<string> {
  return [...text.matchAll(/\d+\.\d+\.\d+\.\d+\/\d+/g)].map((match) =>
    at(match, 0),
  );
}

/** `50, 14 y 6` — Spanish list with the last item joined by `y`. */
function joinEs(items: ReadonlyArray<string>): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} y ${at(items, items.length - 1)}`;
}

/** Canonical answer line for a drill, with each field labelled. */
function labelled(problem: SubnetProblem): string {
  return problem.fields
    .map((field, index) => `${field}=${at(problem.expected, index)}`)
    .join(" ");
}

/** The drill's answers with one field replaced by a value it cannot hold. */
function withWrongField(problem: SubnetProblem, index: number): string {
  const expected = at(problem.expected, index);
  const wrong = expected === "0.0.0.0" ? "255.255.255.255" : "0.0.0.0";
  return problem.expected
    .map((value, at_) => (at_ === index ? wrong : value))
    .join(" ");
}

describe("subnet trainer: topics and generation contract (F-117)", () => {
  test("SUBNET_TOPICS lists the four drill themes", () => {
    expect([...SUBNET_TOPICS]).toEqual(["cidr", "vlsm", "summary", "usable"]);
    expect(isSubnetTopic("cidr")).toBe(true);
    expect(isSubnetTopic("vlsm")).toBe(true);
    expect(isSubnetTopic("Cidr")).toBe(false);
    expect(isSubnetTopic("bogus")).toBe(false);
  });

  test("the same seed replays the same drill for every topic", () => {
    for (const topic of SUBNET_TOPICS) {
      const first = generateSubnetProblem(topic, prng(99));
      const second = generateSubnetProblem(topic, prng(99));
      expect(second.topic).toBe(topic);
      expect(second.title).toBe(first.title);
      expect(second.prompt).toBe(first.prompt);
      expect([...second.fields]).toEqual([...first.fields]);
      expect([...second.expected]).toEqual([...first.expected]);
      expect([...second.steps]).toEqual([...first.steps]);
    }
  });

  test("different seeds produce different drills", () => {
    const prompts = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      prompts.add(generateSubnetProblem("cidr", prng(seed)).prompt);
    }
    expect(prompts.size).toBeGreaterThan(1);
  });

  test("every drill carries steps and every check returns them", () => {
    for (const topic of SUBNET_TOPICS) {
      for (let seed = 1; seed <= 10; seed++) {
        const problem = generateSubnetProblem(topic, prng(seed));
        expect(problem.steps.length).toBeGreaterThan(0);
        expect(problem.steps.every((step) => step.length > 0)).toBe(true);
        const result = problem.check(problem.expected.join(" "));
        expect(result.pass).toBe(true);
        expect([...result.steps]).toEqual([...problem.steps]);
        expect(result.expected).toBe(labelled(problem));
      }
    }
  });

  test("the generator reads only the injected PRNG", () => {
    const draws: Array<number> = [];
    const constant = (): number => {
      draws.push(0.5);
      return 0.5;
    };
    const problem = generateSubnetProblem("cidr", constant);
    expect(draws.length).toBeGreaterThan(0);
    expect(problem.prompt).toBe(
      generateSubnetProblem("cidr", () => 0.5).prompt,
    );
    // Out-of-range draws are a programming error, never silently clamped.
    expect(() => generateSubnetProblem("cidr", () => 1)).toThrow(RangeError);
    expect(() => generateSubnetProblem("cidr", () => -0.1)).toThrow(RangeError);
  });

  test("an unknown topic is rejected", () => {
    expect(() =>
      generateSubnetProblem("bogus" as SubnetTopic, () => 0.5),
    ).toThrow();
  });
});

describe("cidr: ip + prefix to network, broadcast, mask and usable range", () => {
  test("every generated drill is arithmetically consistent", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const problem = generateSubnetProblem("cidr", prng(seed));
      expect(problem.topic).toBe("cidr");
      expect([...problem.fields]).toEqual([
        "red",
        "broadcast",
        "mascara",
        "primera",
        "ultima",
        "hosts",
      ]);

      const given = cidrsIn(problem.prompt);
      expect(given.length).toBe(1);
      const givenBlock = parseBlock(at(given, 0));
      const mask = at(problem.expected, 2);
      const prefixLength = prefixFromMask(mask);
      expect(prefixLength).toBe(givenBlock.prefixLength);
      expect(mask).toBe(prefixToMask(prefixLength).toString());

      const size = sizeOf(prefixLength);
      const network = u32Of(at(problem.expected, 0));
      const broadcast = u32Of(at(problem.expected, 1));
      expect(network).toBe(givenBlock.network);
      expect(network % size).toBe(0);
      expect(broadcast).toBe(network + size - 1);
      expect(u32Of(at(problem.expected, 3))).toBe(network + 1);
      expect(u32Of(at(problem.expected, 4))).toBe(broadcast - 1);
      expect(at(problem.expected, 5)).toBe(String(size - 2));

      // The given address really belongs to the block and is a usable host.
      expect(givenBlock.raw).toBeGreaterThan(network);
      expect(givenBlock.raw).toBeLessThan(broadcast);

      // The explanation works through the mask, the binary form and the range.
      expect(problem.steps.length).toBeGreaterThanOrEqual(5);
      expect(problem.steps.join("\n")).toContain(mask);
      expect(problem.steps.join("\n")).toContain(at(problem.expected, 0));
    }
  });

  test("check grades the canonical answer, tolerates spacing and rejects a wrong field", () => {
    const problem = generateSubnetProblem("cidr", prng(11));
    const canonical = problem.expected.join(" ");

    expect(problem.check(canonical).pass).toBe(true);
    expect(problem.check(`  ${problem.expected.join("   ")}  `).pass).toBe(
      true,
    );

    const numeric = [...problem.expected];
    numeric[5] = `0${at(problem.expected, 5)}`;
    expect(problem.check(numeric.join(" ")).pass).toBe(true);

    for (let index = 0; index < problem.fields.length; index++) {
      const result = problem.check(withWrongField(problem, index));
      expect(result.pass).toBe(false);
      expect(result.expected).toBe(labelled(problem));
      expect([...result.steps]).toEqual([...problem.steps]);
    }

    // Too few answers is a failure, never a partial pass.
    expect(problem.check(problem.expected.slice(0, 2).join(" ")).pass).toBe(
      false,
    );
  });
});

describe("vlsm: base block + host demands to assigned subnets", () => {
  test("the allocation is smallest-fit, descending and contiguous", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const problem = generateSubnetProblem("vlsm", prng(seed));
      expect(problem.topic).toBe("vlsm");
      expect(problem.fields.length).toBe(problem.expected.length);
      expect(problem.fields.length).toBeGreaterThanOrEqual(2);
      expect(problem.fields.length).toBeLessThanOrEqual(3);

      const vlsm = captures(
        /(\d+\.\d+\.\d+\.\d+\/\d+) para (.+) hosts/,
        problem.prompt,
      );
      const base = parseBlock(at(vlsm, 0));
      const demands = at(vlsm, 1).split(/, | y /);
      expect(demands.length).toBe(problem.expected.length);

      const blocks = problem.expected.map(parseBlock);
      for (const block of blocks) {
        // Answers are canonical: host bits cleared.
        expect(block.raw).toBe(block.network);
        expect(block.network + block.size).toBeLessThanOrEqual(
          base.network + base.size,
        );
      }

      // Each demand gets the smallest block that still fits two extra
      // addresses (network + broadcast).
      demands.forEach((demand, index) => {
        const block = at(blocks, index);
        const needed = Number(demand) + 2;
        expect(needed).toBeLessThanOrEqual(block.size);
        if (block.size > 4) {
          expect(block.size / 2).toBeLessThan(needed);
        }
      });

      // Allocation runs from the start of the base, in descending size, with
      // no gaps and no overlap: that is what makes the result VLSM.
      const sorted = [...blocks].sort(
        (left, right) => left.network - right.network,
      );
      expect(at(sorted, 0).network).toBe(base.network);
      for (let index = 0; index < sorted.length - 1; index++) {
        const block = at(sorted, index);
        const next = at(sorted, index + 1);
        expect(block.network + block.size).toBe(next.network);
        expect(block.size).toBeGreaterThanOrEqual(next.size);
      }

      // The explanation walks the descending order it allocated in.
      expect(problem.steps.length).toBeGreaterThanOrEqual(
        problem.fields.length + 1,
      );
      expect(problem.steps.join("\n")).toContain(
        joinEs(
          demands
            .map((demand) => demand.trim())
            .sort((a, b) => Number(b) - Number(a)),
        ),
      );
    }
  });

  test("check grades every assigned subnet", () => {
    const problem = generateSubnetProblem("vlsm", prng(3));
    expect(problem.check(problem.expected.join(" ")).pass).toBe(true);
    for (let index = 0; index < problem.expected.length; index++) {
      expect(problem.check(withWrongField(problem, index)).pass).toBe(false);
    }
    expect(problem.check(problem.expected.join(", ")).pass).toBe(true);
  });
});

describe("summary: several networks to the minimal supernet", () => {
  test("the answer is the shortest prefix that still covers every network", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const problem = generateSubnetProblem("summary", prng(seed));
      expect(problem.topic).toBe("summary");
      expect([...problem.fields]).toEqual(["supernet"]);

      const given = cidrsIn(problem.prompt);
      expect(given.length).toBeGreaterThanOrEqual(2);
      expect(given.length).toBeLessThanOrEqual(4);

      const answer = parseBlock(at(problem.expected, 0));
      expect(answer.raw).toBe(answer.network);

      for (const cidr of given) {
        const block = parseBlock(cidr);
        expect(block.raw).toBe(block.network);
        expect(block.network).toBeGreaterThanOrEqual(answer.network);
        expect(block.network + block.size).toBeLessThanOrEqual(
          answer.network + answer.size,
        );
      }

      // Minimality: one bit longer would not cover them, so the answer is
      // exactly the longest common prefix of the given networks.
      const networks = given.map((cidr) => parseBlock(cidr).network);
      const first = at(networks, 0);
      const differing = networks.reduce(
        (accumulator, network) => accumulator | (network ^ first),
        0,
      );
      expect(answer.prefixLength).toBe(Math.clz32(differing));

      expect(problem.steps.length).toBeGreaterThanOrEqual(3);
      expect(problem.steps.join("\n")).toContain(at(problem.expected, 0));
    }
  });

  test("check accepts the supernet and rejects a wider or narrower one", () => {
    const problem = generateSubnetProblem("summary", prng(8));
    const answer = parseBlock(at(problem.expected, 0));
    expect(problem.check(problem.expected.join(" ")).pass).toBe(true);

    const narrower = `${at(problem.expected, 0).split("/")[0]}/${answer.prefixLength + 1}`;
    expect(problem.check(narrower).pass).toBe(false);
    expect(problem.check("0.0.0.0/0").pass).toBe(false);
  });
});

describe("usable: prefix to the usable range and the broadcast", () => {
  test("the range matches the block definition", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const problem = generateSubnetProblem("usable", prng(seed));
      expect(problem.topic).toBe("usable");
      expect([...problem.fields]).toEqual(["primera", "ultima", "broadcast"]);

      const given = cidrsIn(problem.prompt);
      expect(given.length).toBe(1);
      const block = parseBlock(at(given, 0));
      const size = block.size;

      expect(u32Of(at(problem.expected, 0))).toBe(block.network + 1);
      expect(u32Of(at(problem.expected, 1))).toBe(block.network + size - 2);
      expect(u32Of(at(problem.expected, 2))).toBe(block.network + size - 1);

      expect(problem.steps.length).toBeGreaterThanOrEqual(3);
      expect(problem.steps.join("\n")).toContain("broadcast");
    }
  });

  test("check grades the three answers and rejects a wrong one", () => {
    const problem = generateSubnetProblem("usable", prng(21));
    expect(problem.check(problem.expected.join(" ")).pass).toBe(true);
    for (let index = 0; index < problem.expected.length; index++) {
      expect(problem.check(withWrongField(problem, index)).pass).toBe(false);
    }
  });
});

describe("the trainer plugs into the shell session (F-117 end to end)", () => {
  test("generateSubnetProblem satisfies the shell's injected trainer shape", () => {
    const trainer: SubnetTrainer = generateSubnetProblem;
    expect(typeof trainer).toBe("function");
    expect(trainer("cidr", prng(5)).topic).toBe("cidr");
  });

  test("subnet new + subnet answer run a real drill to a correct verdict", async () => {
    const seed = 61;
    const sim = new Simulation(seed);
    const host = new Host(sim, "a", new TraceBus());
    const shell = new Shell({ host, sim, subnet: generateSubnetProblem });

    const drill = await shell.exec("subnet new cidr");
    expect(drill.length).toBe(3);
    expect(drill[0]).toBe("subnet drill: cidr");
    expect(at(drill, 2)).toBe(
      "answer: subnet answer red broadcast mascara primera ultima hosts",
    );

    // Independently derive the answers from the statement the shell printed.
    const given = cidrsIn(at(drill, 1));
    expect(given.length).toBe(1);
    const block = parseBlock(at(given, 0));
    const last = block.network + block.size - 1;
    const answer = [
      dottedOf(block.network),
      dottedOf(last),
      prefixToMask(block.prefixLength).toString(),
      dottedOf(block.network + 1),
      dottedOf(last - 1),
      String(block.size - 2),
    ];

    const graded = await shell.exec(`subnet answer ${answer.join(" ")}`);
    expect(at(graded, 0)).toBe("answer: correct");
    expect(graded.length).toBeGreaterThanOrEqual(6);
    expect(graded.slice(1).join("\n")).toContain(answer[2] as string);

    // The drill stays pending: a retry is graded again, never lost.
    const retried = await shell.exec(`subnet answer ${answer.join(" ")}`);
    expect(at(retried, 0)).toBe("answer: correct");
  });

  test("a wrong answer prints the canonical values and the steps", async () => {
    const sim = new Simulation(62);
    const host = new Host(sim, "a", new TraceBus());
    const shell = new Shell({ host, sim, subnet: generateSubnetProblem });

    await shell.exec("subnet new usable");
    const graded = await shell.exec("subnet answer 0.0.0.0 0.0.0.0 0.0.0.0");
    expect(at(graded, 0)).toBe("answer: incorrect");
    expect(at(graded, 1).startsWith("expected: primera=")).toBe(true);
    expect(graded.length).toBeGreaterThanOrEqual(4);
  });
});
