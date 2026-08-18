import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { evaluateWorkspace } from "../src/evaluator.js";
import type { HarnessConfig } from "../src/types.js";

async function semanticFixture(): Promise<{ root: string; source: string; config: HarnessConfig }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-semantics-"));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "candidate.json"), "{\"weight\":1}\n", "utf8");
  await writeFile(path.join(source, "evaluate.mjs"), `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({
  metrics: { score: 1 },
  metadata: {
    prediction_sha256: "${"a".repeat(64)}",
    candidate_capabilities: ["weighted-model"],
    consumed_search_parameters: ["candidate.json:weight"]
  }
}));
`, "utf8");
  const config = {
    version: 2,
    name: "semantic-test",
    project: { sourceDir: source, mutablePaths: ["candidate.json"], protectedPaths: ["evaluate.mjs"], hiddenPaths: [], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 1, seeds: [7], inheritEnv: ["PATH"], env: {},
      stages: [
        { name: "smoke", budgetRatio: 0.1, repetitions: 1, pruneIfClearlyWorse: false },
        { name: "canonical", budgetRatio: 1, repetitions: 1, pruneIfClearlyWorse: false },
      ],
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.01, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 1, maxWallTimeMinutes: 0, maxConsecutiveFailures: 3 },
    learning: {
      beamWidth: 1, maxBranchDepth: 2, maxTemporaryRegressionRatio: 0.1, recentExperiments: 2, maxContextLessons: 2,
      supportThreshold: 2, contradictionThreshold: 1, maxFrontierPerCategory: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 }, humanLessons: [],
    },
    outputDir: path.join(root, "runs"), researchInstructions: "test",
  } as HarnessConfig;
  return { root, source, config };
}

test("exact prediction hashes prune semantic no-ops before later evaluator stages", async () => {
  const { root, source, config } = await semanticFixture();
  const baseline = await evaluateWorkspace(config, source, path.join(root, "baseline"), "baseline");
  const candidate = path.join(root, "candidate");
  await mkdir(candidate);
  await writeFile(path.join(candidate, "candidate.json"), "{\"weight\":2}\n", "utf8");
  await writeFile(path.join(candidate, "evaluate.mjs"), await readFile(path.join(source, "evaluate.mjs"), "utf8"), "utf8");
  const evaluation = await evaluateWorkspace(config, candidate, path.join(root, "candidate-eval"), "candidate", {
    semanticReferences: [{ id: "baseline", evaluation: baseline }],
  });
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.pruned, true);
  assert.equal(evaluation.semanticDuplicateOf, "baseline");
  assert.equal(evaluation.stages?.length, 1);
  assert.deepEqual(evaluation.semantic?.candidateCapabilities, ["weighted-model"]);
  assert.deepEqual(evaluation.semantic?.consumedSearchParameters, ["candidate.json:weight"]);
  assert.ok((evaluation.computeSavedRatio ?? 0) > 0);
});

test("evaluator rejects malformed semantic metadata", async () => {
  const { root, source, config } = await semanticFixture();
  await writeFile(path.join(source, "evaluate.mjs"), `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: 1 }, metadata: { prediction_sha256: "not-a-hash" } }));
`, "utf8");
  config.evaluator.stages = [{ name: "canonical", budgetRatio: 1, repetitions: 1, pruneIfClearlyWorse: false }];
  const evaluation = await evaluateWorkspace(config, source, path.join(root, "invalid"), "invalid");
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.error ?? "", /prediction_sha256/);
});
