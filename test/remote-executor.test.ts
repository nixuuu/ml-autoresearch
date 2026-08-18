import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { test } from "bun:test";
import { executeRemoteEvaluation } from "../src/remote-executor.js";
import { evaluateWorkspace } from "../src/evaluator.js";
import type { HarnessConfig } from "../src/types.js";

test("remote executor uses a correlated bounded JSONL contract", async () => {
  const response = await executeRemoteEvaluation({
    command: [process.execPath, path.join(import.meta.dir, "fixtures", "fake-remote-executor.ts")],
    timeoutSeconds: 10,
    inheritEnv: ["PATH"],
    env: {},
    maxResponseBytes: 64 * 1024,
  }, {
    workspace: { path: "/tmp/workspace", fingerprint: "abc", readOnly: true },
    evaluator: {
      command: ["python", "evaluate.py"], env: {}, timeoutSeconds: 60, seed: 7, repetition: 0,
      experimentId: "exp-1", stage: { name: "canonical", budgetRatio: 1 },
    },
    resources: { network: "none", pidsLimit: 64, readOnlyRoot: true },
    artifacts: { metrics: true, phaseEvents: true, checkpointManifest: false },
  });
  assert.equal(response.status, "completed");
  assert.deepEqual(response.metrics?.metrics, { score: 8 });
  assert.equal(response.phaseEvents?.[0]?.phase, "canonical");
});

test("evaluator consumes remote metrics through the neutral broker contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-remote-eval-"));
  const command = [process.execPath, path.join(import.meta.dir, "fixtures", "fake-remote-executor.ts")];
  const config = {
    evaluator: {
      command: ["python", "evaluate.py"], timeoutSeconds: 60, repetitions: 1, seeds: [7], inheritEnv: [], env: {},
      stages: [{ name: "canonical", budgetRatio: 1, pruneIfClearlyWorse: false }], repetitionConcurrency: 1,
      statistics: { enabled: false, confidenceLevel: 0.95, equivalenceMargin: 0, minimumSeeds: 1, maximumSeeds: 1, seedStep: 1 },
      runner: { mode: "remote", network: "none", readOnlyRoot: true, pidsLimit: 64, remote: { command, timeoutSeconds: 10, inheritEnv: ["PATH"], env: {}, maxResponseBytes: 65_536 } },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0, aggregation: "mean" }, guardrails: [] },
  } as HarnessConfig;
  const evaluation = await evaluateWorkspace(config, root, path.join(root, "artifacts"), "exp-1");
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.aggregatedMetrics.score, 8);
  assert.equal(evaluation.attempts[0]?.metadata?.provider, "fake");
});
