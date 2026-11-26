/**
 * `netlab bench`: micro-benchmarks deterministas del motor.
 *
 * Dos cargas sintéticas sobre `runScenario`:
 * - `flood`: N envíos L2 crudos entre dos hosts (eventos/segundo).
 * - `bulk`: los mismos N envíos con payload de 1400 B (throughput
 *   simulado en Mbps virtuales, tamaño de segmento TCP típico).
 *
 * Los conteos de eventos y bytes son deterministas para una semilla y un
 * tamaño dados; el tiempo de pared y la RSS no (se reportan, no se
 * asertan en CI salvo positividad).
 *
 * Usage: netlab bench [--size tiny|small|medium|large] [--repeat N] [--format human|json]
 * Exit codes: 0 ok · 2 usage o parse error.
 */

import { runScenario } from "./run";
import { parseScenarioJson } from "./scenario";

export const BENCH_USAGE =
  "Usage: netlab bench [--size tiny|small|medium|large] [--repeat N] [--format human|json]\n" +
  "  run synthetic engine benchmarks (flood events/s + bulk simulated Mbps)\n" +
  "  --size tiny|small|medium|large (default small: 200 frames per workload)\n" +
  "  --repeat N runs each workload N times and reports the mean (default 1)\n" +
  "  --format human|json (default human)\n";

export type BenchSize = "tiny" | "small" | "medium" | "large";

export interface BenchOptions {
  size: BenchSize;
  repeat: number;
  format: "human" | "json";
}

export interface WorkloadResult {
  workload: "flood" | "bulk";
  frames: number;
  events: number;
  wallMs: number;
  eventsPerSec: number;
  txBytes: number;
  simMbps: number;
  rssMb: number;
}

const FRAMES_PER_SIZE: Record<BenchSize, number> = {
  tiny: 20,
  small: 200,
  medium: 1000,
  large: 5000,
};

function buildFloodJson(frames: number, payloadSize: number): unknown {
  const payload = "x".repeat(payloadSize);
  const actions = [];
  for (let i = 0; i < frames; i++) {
    actions.push({
      at: `${i * 10}us`,
      host: i % 2 === 0 ? "h1" : "h2",
      iface: "eth0",
      destIp: i % 2 === 0 ? "10.0.0.2" : "10.0.0.1",
      etherType: "0x0800",
      payload: `${i}:${payload}`,
    });
  }
  return {
    version: 1,
    seed: 42,
    until: "30s",
    nodes: [
      {
        type: "host",
        id: "h1",
        interfaces: [
          { name: "eth0", mac: "02:00:00:00:00:0a", ip: "10.0.0.1" },
        ],
      },
      {
        type: "host",
        id: "h2",
        interfaces: [
          { name: "eth0", mac: "02:00:00:00:00:0b", ip: "10.0.0.2" },
        ],
      },
      {
        type: "switch",
        id: "sw1",
        ports: [{ name: "p1" }, { name: "p2" }],
      },
    ],
    links: [
      {
        id: "l1",
        a: { node: "h1", iface: "eth0" },
        b: { node: "sw1", iface: "p1" },
        params: { latencyUs: 10 },
      },
      {
        id: "l2",
        a: { node: "h2", iface: "eth0" },
        b: { node: "sw1", iface: "p2" },
        params: { latencyUs: 10 },
      },
    ],
    actions,
  };
}

/** Corre una carga una vez y mide pared + memoria. Puro salvo el reloj. */
export async function measureOnce(
  workload: "flood" | "bulk",
  frames: number,
): Promise<WorkloadResult> {
  const scenario = parseScenarioJson(
    buildFloodJson(frames, workload === "bulk" ? 1400 : 8),
  );
  const start = performance.now();
  const result = await runScenario(scenario);
  const wallMs = performance.now() - start;
  let txBytes = 0;
  for (const trace of result.traces) {
    if (trace.kind === "frame_tx") {
      txBytes += (trace as unknown as { length: number }).length;
    }
  }
  const wallSec = Math.max(wallMs / 1000, 1e-9);
  const virtualSec = Math.max(result.finalTime / 1_000_000, 1e-9);
  return {
    workload,
    frames,
    events: result.processed,
    wallMs,
    eventsPerSec: result.processed / wallSec,
    txBytes,
    simMbps: (txBytes * 8) / virtualSec / 1_000_000,
    rssMb: process.memoryUsage().rss / 1024 / 1024,
  };
}

/** Corre flood + bulk `repeat` veces y promedia pared/eventos. */
export async function runBenchWorkloads(
  size: BenchSize = "small",
  repeat = 1,
): Promise<Array<WorkloadResult>> {
  const frames = FRAMES_PER_SIZE[size];
  const out: Array<WorkloadResult> = [];
  for (const workload of ["flood", "bulk"] as const) {
    let acc: WorkloadResult | undefined;
    for (let i = 0; i < repeat; i++) {
      const one = await measureOnce(workload, frames);
      if (acc === undefined) {
        acc = { ...one };
      } else {
        acc.events += one.events;
        acc.wallMs += one.wallMs;
        acc.txBytes += one.txBytes;
        acc.rssMb = Math.max(acc.rssMb, one.rssMb);
      }
    }
    const total = acc as WorkloadResult;
    const wallSec = Math.max(total.wallMs / 1000, 1e-9);
    out.push({
      ...total,
      frames,
      eventsPerSec: total.events / wallSec / repeat,
      wallMs: total.wallMs / repeat,
      events: Math.round(total.events / repeat),
      txBytes: Math.round(total.txBytes / repeat),
    });
  }
  return out;
}

function parseBenchArgs(argv: Array<string>): BenchOptions {
  let size: BenchSize = "small";
  let repeat = 1;
  let format: "human" | "json" = "human";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--size") {
      const raw = argv[++i];
      if (
        raw !== "tiny" &&
        raw !== "small" &&
        raw !== "medium" &&
        raw !== "large"
      ) {
        throw new Error(
          `--size must be tiny|small|medium|large, got ${JSON.stringify(raw)}\n${BENCH_USAGE}`,
        );
      }
      size = raw;
    } else if (arg === "--repeat") {
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error(
          `--repeat needs a positive integer, got ${JSON.stringify(raw)}\n${BENCH_USAGE}`,
        );
      }
      repeat = Number.parseInt(raw, 10);
    } else if (arg === "--format") {
      const raw = argv[++i];
      if (raw !== "human" && raw !== "json") {
        throw new Error(
          `--format must be "human" or "json", got ${JSON.stringify(raw)}\n${BENCH_USAGE}`,
        );
      }
      format = raw;
    } else if (arg === "-h" || arg === "--help") {
      throw Object.assign(new Error(BENCH_USAGE), { code: "HELP" });
    } else {
      throw new Error(`unknown flag ${JSON.stringify(arg)}\n${BENCH_USAGE}`);
    }
  }
  return { size, repeat, format };
}

function formatHuman(results: Array<WorkloadResult>): string {
  const lines = [
    "workload  frames  events  wall_ms  events/s  tx_bytes  sim_Mbps  rss_MB",
  ];
  for (const r of results) {
    lines.push(
      `${r.workload.padEnd(8)}  ${String(r.frames).padStart(6)}  ${String(r.events).padStart(6)}  ` +
        `${r.wallMs.toFixed(1).padStart(7)}  ${Math.round(r.eventsPerSec).toString().padStart(8)}  ` +
        `${String(r.txBytes).padStart(8)}  ${r.simMbps.toFixed(2).padStart(8)}  ${r.rssMb.toFixed(1).padStart(6)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Entrypoint CLI: parsea, corre, imprime. Retorna exit code. */
export async function runBench(argv: Array<string>): Promise<number> {
  let opts: BenchOptions;
  try {
    opts = parseBenchArgs(argv);
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "HELP") {
      process.stdout.write(BENCH_USAGE);
      return 0;
    }
    process.stderr.write(err.message);
    if (!err.message.endsWith("\n")) process.stderr.write("\n");
    return 2;
  }
  const results = await runBenchWorkloads(opts.size, opts.repeat);
  if (opts.format === "json") {
    for (const r of results) {
      process.stdout.write(`${JSON.stringify(r)}\n`);
    }
  } else {
    process.stdout.write(formatHuman(results));
  }
  return 0;
}
