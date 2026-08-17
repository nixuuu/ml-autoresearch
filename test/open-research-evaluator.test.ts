import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

test("open research example emits finite protected baseline metrics", async () => {
  const exampleDir = path.resolve(import.meta.dir, "../examples/open-research");
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-open-eval-"));
  const metricsPath = path.join(artifactDir, "metrics.json");
  const processResult = Bun.spawnSync(["python3", "evaluate.py"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      AUTORESEARCH_METRICS_PATH: metricsPath,
      AUTORESEARCH_STAGE: "canonical",
      AUTORESEARCH_BUDGET_RATIO: "1",
      AUTORESEARCH_SEED: "17",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(processResult.exitCode, 0, processResult.stderr.toString());
  const payload = JSON.parse(await readFile(metricsPath, "utf8")) as { metrics: Record<string, number> };
  assert.ok(Number.isFinite(payload.metrics.holdout_rmse));
  assert.ok(Number.isFinite(payload.metrics.prediction_latency_ms));
  assert.ok(Number.isFinite(payload.metrics.candidate_bytes));
  assert.ok(payload.metrics.holdout_rmse! > 0.1, "baseline should not contain a perfect-score shortcut");
});
