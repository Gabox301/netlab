/**
 * `subnet` — the stateful subnetting trainer inside the shell (F-117, T4).
 *
 * The generator itself (random drill + step-by-step grading) belongs to
 * `@netlab/exercises`; the shell owns the *session*: it draws from
 * `sim.random`, remembers the pending drill and prints the correction. The
 * generator arrives through `ShellOptions.subnet` because `@netlab/shell`
 * and `@netlab/exercises` are siblings in the dependency graph (ADR-001):
 * the shell never imports the exercises package, and the CLI/UI picks the
 * trainer. These tests inject a fake trainer, which is what pins the shell's
 * own contract: grammar, session state, formatting and PRNG wiring.
 */

import { describe, expect, test } from "bun:test";
import { Mulberry32 } from "@netlab/core";
import {
  parseCommandLine,
  type ShellCommand,
  ShellCommandError,
  type ShellError,
  type ShellErrorCode,
  type SubnetProblemLike,
  type SubnetTrainer,
} from "../src/index";
import { Shell } from "../src/shell";
import { sameSubnetLab } from "./lab";

const STEPS: ReadonlyArray<string> = [
  "Paso 1: /26 → máscara 255.255.255.192 (11111111.11111111.11111111.11000000)",
  "Paso 2: red = 10.0.0.0; broadcast = 10.0.0.63",
];

const ANSWER = "10.0.0.0 10.0.0.63";

interface TrainerCall {
  readonly topic: string;
  readonly draw: number;
}

interface FakeTrainer {
  readonly trainer: SubnetTrainer;
  readonly calls: Array<TrainerCall>;
}

/**
 * Trainer stub: one deterministic two-field drill per topic. It records the
 * `rand` value it was handed, which is how the tests prove the shell passes
 * `sim.random.next` (the simulation PRNG) and not something else.
 */
function fakeTrainer(): FakeTrainer {
  const calls: Array<TrainerCall> = [];
  const trainer: SubnetTrainer = (topic, rand) => {
    const draw = rand();
    calls.push({ topic, draw });
    const problem: SubnetProblemLike = {
      topic,
      title: `drill ${topic}`,
      prompt: `drill ${topic} (draw ${draw.toFixed(6)})`,
      fields: ["red", "broadcast"],
      expected: ANSWER.split(" "),
      steps: [...STEPS],
      check: (answer) => ({
        pass: answer.trim().replace(/\s+/g, " ") === ANSWER,
        expected: "red=10.0.0.0 broadcast=10.0.0.63",
        steps: [...STEPS],
      }),
    };
    return problem;
  };
  return { trainer, calls };
}

function accepted(line: string): ShellCommand {
  const result = parseCommandLine(line);
  if (!result.ok) {
    throw new Error(
      `expected ${JSON.stringify(line)} to parse: ${result.error.message}`,
    );
  }
  return result.value;
}

function rejected(line: string): ShellError {
  const result = parseCommandLine(line);
  if (result.ok) {
    throw new Error(`expected ${JSON.stringify(line)} to be rejected`);
  }
  return result.error;
}

/** Await a rejected `exec` and return the typed shell error code. */
async function execError(
  shell: Shell,
  line: string,
): Promise<{ code: ShellErrorCode; message: string }> {
  try {
    await shell.exec(line);
  } catch (error) {
    if (error instanceof ShellCommandError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(line)} to fail`);
}

describe("parse: subnet grammar", () => {
  test("parses new with and without a theme", () => {
    expect(accepted("subnet new")).toEqual({ kind: "subnet.new" });
    expect(accepted("subnet new cidr")).toEqual({
      kind: "subnet.new",
      topic: "cidr",
    });
    for (const topic of ["cidr", "vlsm", "summary", "usable"] as const) {
      expect(accepted(`subnet new ${topic}`)).toEqual({
        kind: "subnet.new",
        topic,
      });
    }
  });

  test("parses answer values in order", () => {
    expect(accepted("subnet answer 10.0.0.0 10.0.0.63")).toEqual({
      kind: "subnet.answer",
      values: ["10.0.0.0", "10.0.0.63"],
    });
    expect(accepted("subnet answer 10.0.0.0/26")).toEqual({
      kind: "subnet.answer",
      values: ["10.0.0.0/26"],
    });
  });

  test("malformed subnet lines are typed errors, never exceptions", () => {
    expect(rejected("subnet").code).toBe("missing_argument");
    expect(rejected("subnet bogus").code).toBe("unknown_subcommand");
    expect(rejected("subnet new bogus").code).toBe("invalid_argument");
    expect(rejected("subnet new cidr extra").code).toBe("unexpected_argument");
    expect(rejected("subnet answer").code).toBe("missing_argument");
    expect(rejected("subnet answer --all").code).toBe("unknown_flag");
  });
});

describe("subnet new: drill generation (F-117)", () => {
  test("draws from sim.random and prints the drill", async () => {
    const seed = 31;
    const lab = sameSubnetLab(seed);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    const lines = await shell.exec("subnet new cidr");
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]?.topic).toBe("cidr");

    // The generator is handed the simulation PRNG itself.
    const expected = new Mulberry32(seed).next();
    expect(fake.calls[0]?.draw).toBe(expected);

    expect(lines.length).toBe(3);
    expect(lines[0]).toBe("subnet drill: cidr");
    expect(lines[1]).toBe(`drill cidr (draw ${expected.toFixed(6)})`);
    expect(lines[2]).toBe("answer: subnet answer red broadcast");
  });

  test("without a theme it picks one of the four at random", async () => {
    const seed = 32;
    const lab = sameSubnetLab(seed);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    const lines = await shell.exec("subnet new");
    const topics = ["cidr", "vlsm", "summary", "usable"];
    const chosen = fake.calls[0]?.topic as string;
    expect(topics).toContain(chosen);
    expect(lines[0]).toBe(`subnet drill: ${chosen}`);
  });

  test("breaks ties with the simulation PRNG: same seed, same drill", async () => {
    const first = sameSubnetLab(77);
    const firstFake = fakeTrainer();
    const firstShell = new Shell({
      host: first.a,
      sim: first.sim,
      subnet: firstFake.trainer,
    });

    const second = sameSubnetLab(77);
    const secondFake = fakeTrainer();
    const secondShell = new Shell({
      host: second.a,
      sim: second.sim,
      subnet: secondFake.trainer,
    });

    expect(await firstShell.exec("subnet new vlsm")).toEqual(
      await secondShell.exec("subnet new vlsm"),
    );

    const other = sameSubnetLab(78);
    const otherFake = fakeTrainer();
    const otherShell = new Shell({
      host: other.a,
      sim: other.sim,
      subnet: otherFake.trainer,
    });
    const otherLines = await otherShell.exec("subnet new vlsm");
    expect(otherLines[1]).not.toBe(
      `drill vlsm (draw ${firstFake.calls[0]?.draw.toFixed(6)})`,
    );
  });

  test("a new drill replaces the pending one", async () => {
    const lab = sameSubnetLab(33);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    await shell.exec("subnet new cidr");
    await shell.exec("subnet new usable");
    expect(fake.calls.length).toBe(2);

    const lines = await shell.exec(`subnet answer ${ANSWER}`);
    expect(lines[0]).toBe("answer: correct");
  });

  test("without a trainer the command is an explicit unsupported error", async () => {
    const lab = sameSubnetLab(34);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const error = await execError(shell, "subnet new cidr");
    expect(error.code).toBe("unsupported");
    expect(error.message).toContain("subnet");
  });
});

describe("subnet answer: grading and the explained correction", () => {
  test("grades the pending drill and prints every step", async () => {
    const lab = sameSubnetLab(41);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    await shell.exec("subnet new cidr");
    const lines = await shell.exec(`subnet answer ${ANSWER}`);
    expect(lines[0]).toBe("answer: correct");
    expect(lines.slice(1)).toEqual([...STEPS]);
  });

  test("a wrong answer shows the expected values plus the steps", async () => {
    const lab = sameSubnetLab(42);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    await shell.exec("subnet new cidr");
    const lines = await shell.exec("subnet answer 10.0.0.0 10.0.0.255");
    expect(lines[0]).toBe("answer: incorrect");
    expect(lines[1]).toBe("expected: red=10.0.0.0 broadcast=10.0.0.63");
    expect(lines.slice(2)).toEqual([...STEPS]);
  });

  test("the drill stays pending so the student can retry", async () => {
    const lab = sameSubnetLab(43);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    await shell.exec("subnet new cidr");
    expect((await shell.exec("subnet answer 10.0.0.0 10.0.0.255"))[0]).toBe(
      "answer: incorrect",
    );
    expect((await shell.exec(`subnet answer ${ANSWER}`))[0]).toBe(
      "answer: correct",
    );
  });

  test("answering with no pending drill is a typed error", async () => {
    const lab = sameSubnetLab(44);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    const error = await execError(shell, `subnet answer ${ANSWER}`);
    expect(error.code).toBe("execution_failed");
    expect(error.message).toContain("subnet new");
  });

  test("answering with no trainer and no drill is a typed error too", async () => {
    const lab = sameSubnetLab(45);
    const shell = new Shell({ host: lab.a, sim: lab.sim });

    const error = await execError(shell, `subnet answer ${ANSWER}`);
    expect(error.code).toBe("execution_failed");
  });
});

describe("subnet: help and formatting", () => {
  test("help lists both subnet commands", async () => {
    const lab = sameSubnetLab(51);
    const shell = new Shell({ host: lab.a, sim: lab.sim });
    const lines = await shell.exec("help");

    expect(lines.some((line) => line.startsWith("subnet new"))).toBe(true);
    expect(lines.some((line) => line.startsWith("subnet answer"))).toBe(true);
    for (const line of lines) {
      expect(line.includes("\u001b[")).toBe(false);
    }
  });

  test("no command output contains terminal escapes", async () => {
    const lab = sameSubnetLab(52);
    const fake = fakeTrainer();
    const shell = new Shell({
      host: lab.a,
      sim: lab.sim,
      subnet: fake.trainer,
    });

    for (const line of [
      ...(await shell.exec("subnet new summary")),
      ...(await shell.exec(`subnet answer ${ANSWER}`)),
      ...(await shell.exec("subnet answer wrong")),
    ]) {
      expect(line.includes("\u001b[")).toBe(false);
    }
  });
});
