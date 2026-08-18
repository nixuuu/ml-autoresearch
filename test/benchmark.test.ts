import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { buildBenchmarkMatrix } from "../src/benchmark.js";

test("benchmark matrix compares model and harness cells from durable run state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-benchmark-"));
  for (const [name, final, cost] of [["run-a", 2, 0.2], ["run-b", 3, 0.4]] as const) {
    const runDir = path.join(root, name);
    await mkdir(runDir);
    await writeFile(path.join(runDir, "state.json"), JSON.stringify({
      schemaVersion: 6, runId: name, name, status: "completed", startedAt: "2026-01-01T00:00:00.000Z",
      configPath: "config.json", runDir, sourceDir: root,
      primaryMetric: { name: "score", direction: "maximize", aggregation: "mean", minimumDelta: 0 },
      acceptedWorkspacePath: runDir,
      baseline: { ok: true, attempts: [], aggregatedMetrics: { score: 1 } },
      acceptedMetrics: { score: final },
      experiments: [{ decision: { status: "promote" }, evaluation: { ok: true }, accounting: { agentUsage: { costUsd: cost, totalTokens: 100 }, durationMs: 10 } }],
    }), "utf8");
  }
  const specPath = path.join(root, "matrix.json");
  await writeFile(specPath, JSON.stringify({
    version: 1, name: "Model x harness",
    entries: [
      { id: "a", model: "model-1", harness: "pi-sdk", runDir: "run-a" },
      { id: "b", model: "model-1", harness: "prime-agent", runDir: "run-b" },
    ],
  }), "utf8");
  const result = await buildBenchmarkMatrix(specPath);
  assert.equal((result.summary as any).cells[0].harness, "prime-agent");
  assert.equal(result.results[1]?.relativeImprovement, 2);
  assert.match(await readFile(path.join(result.outputDir, "BENCHMARK.md"), "utf8"), /Model x harness/);
});
