import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { AutoresearchHarness } from "../src/harness.js";
import { applySweepValue, readSweepReferenceValue, resolveParameterSweep } from "../src/parameter-sweep.js";
import type { HarnessConfig, ResearchOutcome, ResearcherFactory } from "../src/types.js";

function sweepConfig(sourceDir: string): HarnessConfig {
  return {
    version: 2,
    name: "parameter-sweep-test",
    project: { sourceDir, mutablePaths: ["experiment.json"], protectedPaths: ["evaluate.mjs"], hiddenPaths: [], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 1, seeds: [7], inheritEnv: ["PATH"], env: {},
      stages: [
        { name: "screen", budgetRatio: 0.2, repetitions: 1, pruneIfClearlyWorse: false },
        { name: "canonical", budgetRatio: 1, repetitions: 1, pruneIfClearlyWorse: false },
      ],
      statistics: { enabled: false, confidenceLevel: 0.95, equivalenceMargin: 0, minimumSeeds: 1, maximumSeeds: 1, seedStep: 1 },
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 1, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 2, maxBranchDepth: 2, maxTemporaryRegressionRatio: 1, recentExperiments: 10, maxContextLessons: 10,
      supportThreshold: 2, contradictionThreshold: 1, maxFrontierPerCategory: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0, optimizeRate: 0, mergeRate: 0, ablationRate: 0 },
      humanLessons: [],
    },
    search: {
      enabled: true,
      seed: 17,
      exploitationRatio: 0,
      parameters: [{ name: "weight", file: "experiment.json", path: "model.weight", type: "float", min: 0, max: 4 }],
      sweeps: { enabled: true, maxValues: 4, maxConcurrentTrials: 2, reductionFactor: 2 },
    },
    execution: { experimentConcurrency: 1, resourceSlots: ["sweep-a", "sweep-b"] },
    outputDir: path.join(sourceDir, "runs"),
    researchInstructions: "Use a bounded parameter sweep when several values of one declared parameter should be compared.",
  };
}

test("parameter sweep validates and safely applies declared JSON parameters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-sweep-unit-"));
  await writeFile(path.join(root, "experiment.json"), `${JSON.stringify({ model: { weight: 1 } })}\n`, "utf8");
  await writeFile(path.join(root, "evaluate.mjs"), "", "utf8");
  const config = sweepConfig(root);
  const request = { mode: "parameter_sweep" as const, parameter: "weight", values: [0.5, 1, 2], rationale: "compare one axis" };
  const resolved = resolveParameterSweep(config, request);
  assert.equal(resolved.parameter.path, "model.weight");
  assert.equal(await readSweepReferenceValue(config, root, resolved.parameter), 1);
  await applySweepValue(config, root, resolved.parameter, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, "experiment.json"), "utf8")).model.weight, 2);
  assert.throws(() => resolveParameterSweep(config, { ...request, values: [1, 1] }), /must be unique/);
  assert.throws(() => resolveParameterSweep(config, { ...request, values: [1, 5] }), /must be <= 4/);
});

test("harness evaluates several values as one experiment, prunes weak trials, and promotes the winner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-sweep-run-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "experiment.json"), `${JSON.stringify({ model: { weight: 1 } })}\n`, "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const config = JSON.parse(await readFile("experiment.json", "utf8"));
const score = 10 - Math.abs(config.model.weight - 2);
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score } }));
`, "utf8");
  const config = sweepConfig(sourceDir);
  let reflected: ResearchOutcome | undefined;
  const factory: ResearcherFactory = async () => ({
    async propose(context) {
      assert.equal(context.evaluationRequests.allowParameterSweep, true);
      assert.deepEqual(context.evaluationRequests.sweepParameters.map((parameter) => parameter.name), ["weight"]);
      return {
        narrative: "Compare three weight values in one controlled experiment.",
        plan: {
          hypothesis: "A weight near 2 maximizes the synthetic score.",
          changeCategory: "optimization",
          expectedEffect: "Select the best weight while pruning weak values after screening.",
          notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
          evaluationRequest: { mode: "parameter_sweep", parameter: "weight", values: [0, 2, 4], rationale: "One causal parameter axis" },
        },
      };
    },
    async reflect(outcome) {
      reflected = outcome;
      return { narrative: "Weight 2 won the controlled sweep.", summary: "Weight 2 was selected.", notes: [], lessonUpdates: [], questionUpdates: [], nextHypotheses: [] };
    },
  });
  const progress: string[] = [];
  const state = await new AutoresearchHarness(config, factory).run({
    configPath: path.join(root, "config.json"),
    onProgress: (message) => progress.push(message),
  });

  assert.equal(state.experiments.length, 1);
  const experiment = state.experiments[0]!;
  assert.equal(experiment.decision.status, "promote");
  assert.equal(experiment.parameterSweep?.selectedValue, 2);
  assert.equal(experiment.parameterSweep?.trials.length, 3);
  assert.equal(experiment.parameterSweep?.trials.filter((trial) => trial.status === "winner").length, 1);
  assert.equal(experiment.parameterSweep?.trials.filter((trial) => trial.status === "pruned").length, 1);
  assert.ok((experiment.parameterSweep?.computeSavedRatio ?? 0) > 0);
  assert.equal(experiment.evaluation.aggregatedMetrics.score, 10);
  assert.equal(reflected?.parameterSweep?.selectedValue, 2);
  assert.deepEqual(JSON.parse(await readFile(path.join(experiment.workspacePath, "experiment.json"), "utf8")), { model: { weight: 2 } });
  assert.equal(JSON.parse(await readFile(path.join(state.runDir, "experiments", "exp-0001", "parameter-sweep", "result.json"), "utf8")).selectedValue, 2);
  assert.match(progress.join("\n"), /SWEEP PRUNE/);
  assert.match(progress.join("\n"), /SWEEP WINNER: trial-02/);
  const report = await readFile(path.join(state.runDir, "REPORT.md"), "utf8");
  assert.match(report, /Parameter sweep: weight selected 2 from 3 values/);
  assert.match(await readFile(path.join(state.runDir, "RESEARCH_MEMORY.md"), "utf8"), /swept weight across/);
});
