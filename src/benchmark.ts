import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunState } from "./types.js";
import { writeJsonAtomic } from "./io.js";

export interface BenchmarkMatrixSpec {
  version: 1;
  name: string;
  entries: Array<{ id: string; model: string; harness: string; runDir: string }>;
}

export interface BenchmarkRunResult {
  id: string;
  model: string;
  harness: string;
  runId: string;
  status: RunState["status"];
  primaryMetric: string;
  direction: "minimize" | "maximize";
  baseline: number;
  final: number;
  improvement: number;
  relativeImprovement: number | null;
  experiments: number;
  promotions: number;
  validEvaluations: number;
  totalCostUsd: number;
  totalTokens: number;
  activeDurationMs: number;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function renderMarkdown(name: string, results: BenchmarkRunResult[]): string {
  const sorted = [...results].sort((left, right) => (right.relativeImprovement ?? Number.NEGATIVE_INFINITY) - (left.relativeImprovement ?? Number.NEGATIVE_INFINITY) || left.totalCostUsd - right.totalCostUsd);
  const rows = sorted.map((result) => `| ${result.model} | ${result.harness} | ${result.id} | ${result.status} | ${result.final.toFixed(6)} | ${result.relativeImprovement === null ? "n/a" : `${(result.relativeImprovement * 100).toFixed(2)}%`} | $${result.totalCostUsd.toFixed(4)} | ${result.experiments} |`).join("\n");
  return `# ${name}\n\n| Model | Harness | Run | Status | Final metric | Relative improvement | Agent cost | Experiments |\n|---|---|---|---|---:|---:|---:|---:|\n${rows || "| — | — | — | — | — | — | — | — |"}\n`;
}

export async function buildBenchmarkMatrix(specPath: string, outputDir?: string): Promise<{ outputDir: string; results: BenchmarkRunResult[]; summary: unknown }> {
  const absoluteSpec = path.resolve(specPath);
  const raw = JSON.parse(await readFile(absoluteSpec, "utf8")) as BenchmarkMatrixSpec;
  if (raw.version !== 1 || !raw.name || !Array.isArray(raw.entries) || raw.entries.length === 0) throw new Error("benchmark spec must have version=1, name, and non-empty entries");
  const ids = new Set<string>();
  const results: BenchmarkRunResult[] = [];
  for (const entry of raw.entries) {
    if (!entry.id || !entry.model || !entry.harness || !entry.runDir) throw new Error("every benchmark entry requires id, model, harness, and runDir");
    if (ids.has(entry.id)) throw new Error(`duplicate benchmark entry id ${entry.id}`);
    ids.add(entry.id);
    const runDir = path.resolve(path.dirname(absoluteSpec), entry.runDir);
    const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")) as RunState;
    const primary = state.primaryMetric;
    if (!primary) throw new Error(`run ${entry.id} does not record its primary metric`);
    const baseline = state.baseline.aggregatedMetrics[primary.name];
    const final = state.acceptedMetrics[primary.name];
    if (baseline === undefined || final === undefined) throw new Error(`run ${entry.id} is missing primary metric ${primary.name}`);
    const improvement = primary.direction === "maximize" ? final - baseline : baseline - final;
    results.push({
      id: entry.id, model: entry.model, harness: entry.harness, runId: state.runId, status: state.status,
      primaryMetric: primary.name, direction: primary.direction, baseline, final, improvement,
      relativeImprovement: baseline === 0 ? null : improvement / Math.abs(baseline),
      experiments: state.experiments.length,
      promotions: state.experiments.filter((experiment) => experiment.decision.status === "promote").length,
      validEvaluations: state.experiments.filter((experiment) => experiment.evaluation.ok).length,
      totalCostUsd: state.experiments.reduce((sum, experiment) => sum + experiment.accounting.agentUsage.costUsd, 0),
      totalTokens: state.experiments.reduce((sum, experiment) => sum + experiment.accounting.agentUsage.totalTokens, 0),
      activeDurationMs: state.activeDurationMs ?? state.experiments.reduce((sum, experiment) => sum + experiment.accounting.durationMs, 0),
    });
  }
  const targetDir = path.resolve(outputDir ?? path.join(path.dirname(absoluteSpec), "benchmark-results"));
  const grouped = new Map<string, BenchmarkRunResult[]>();
  for (const result of results) {
    const key = `${result.model}\u0000${result.harness}`;
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }
  const cells = [...grouped.values()].map((cellRuns) => {
    return {
      model: cellRuns[0]!.model,
      harness: cellRuns[0]!.harness,
      runs: cellRuns.length,
      meanRelativeImprovement: mean(cellRuns.flatMap((run) => run.relativeImprovement === null ? [] : [run.relativeImprovement])),
      meanCostUsd: mean(cellRuns.map((run) => run.totalCostUsd)),
      meanActiveDurationMs: mean(cellRuns.map((run) => run.activeDurationMs)),
      completionRate: cellRuns.filter((run) => run.status === "completed").length / cellRuns.length,
    };
  }).sort((left, right) => right.meanRelativeImprovement - left.meanRelativeImprovement || left.meanCostUsd - right.meanCostUsd);
  const summary = { schemaVersion: 1, name: raw.name, createdAt: new Date().toISOString(), cells, runs: results };
  await writeJsonAtomic(path.join(targetDir, "benchmark.json"), summary);
  await writeFile(path.join(targetDir, "BENCHMARK.md"), renderMarkdown(raw.name, results), "utf8");
  return { outputDir: targetDir, results, summary };
}
