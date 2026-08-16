import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadConfig } from "../src/config.js";

function minimalConfig(learning?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 2,
    name: "config-test",
    project: { sourceDir: ".", mutablePaths: ["model.py"] },
    evaluator: { command: ["python3", "evaluate.py"] },
    metrics: { primary: { name: "loss", direction: "minimize" } },
    budget: {},
    ...(learning ? { learning } : {}),
    researchInstructions: "test",
  };
}

async function configFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-config-"));
  const file = path.join(directory, "autoresearch.config.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

test("config supplies the full learning policy by default", async () => {
  const config = await loadConfig(await configFile(minimalConfig()));
  assert.equal(config.learning.beamWidth, 3);
  assert.equal(config.metrics.primary.format, "number");
  assert.equal(config.learning.maxTemporaryRegressionRatio, 0.05);
  assert.equal(config.learning.maxFrontierPerCategory, 1);
  assert.deepEqual(config.project.hiddenPaths, []);
  assert.deepEqual(config.evaluator.agentRequests, { allowPairedComparison: false, maxSeeds: 5 });
  assert.equal(config.evaluator.cache, undefined);
  assert.equal(config.learning.strategy.explorationRate, 0.25);
  assert.deepEqual(config.learning.humanLessons, []);
  assert.equal(config.knowledge?.enabled, false);
});

test("config loads an optional evaluator shared cache", async () => {
  const value = minimalConfig();
  value.evaluator = {
    command: ["python3", "evaluate.py"],
    cache: { enabled: true, path: "cache-root", namespace: "dataset-v3", readOnly: true },
  };
  const file = await configFile(value);
  const config = await loadConfig(file);
  assert.deepEqual(config.evaluator.cache, {
    enabled: true,
    path: path.join(path.dirname(file), "cache-root"),
    namespace: "dataset-v3",
    readOnly: true,
    results: false,
  });

  const invalid = minimalConfig();
  invalid.evaluator = { command: ["python3", "evaluate.py"], cache: { namespace: "../escape" } };
  await assert.rejects(loadConfig(await configFile(invalid)), /cache\.namespace must be a safe single path segment/);
});

test("config loads optimized research runtime policies", async () => {
  const value = minimalConfig({
    acquisition: { enabled: true, minimumObservations: 3, explorationFloor: 0.2 },
    ensemble: { enabled: true, minimumMembers: 2, maximumMembers: 3, interval: 4 },
    sliceDiscovery: { enabled: true, minimumSamples: 20, maximumTickets: 2, regressionThreshold: 0.01 },
  });
  value.project = { sourceDir: ".", mutablePaths: ["experiment.json"] };
  value.evaluator = {
    command: ["python3", "evaluate.py"],
    stages: [{ name: "screen", budgetRatio: 0.2 }, { name: "canonical", budgetRatio: 1 }],
    preflight: { command: ["python3", "preflight.py"] },
    checkpointing: { enabled: true, manifestName: "state.json" },
    telemetry: { enabled: true },
    cache: { enabled: true, path: "cache", namespace: "v1", results: true },
  };
  value.search = {
    enabled: true,
    parameters: [{ name: "depth", file: "experiment.json", path: "depth", type: "integer", min: 1, max: 4 }],
    surrogate: { enabled: true, minimumObservations: 3, candidatePoolSize: 16, explorationWeight: 0.4 },
    sweeps: { enabled: true, maxValues: 4, maxConcurrentTrials: 2, reductionFactor: 2 },
  };
  value.execution = {
    experimentConcurrency: 2,
    resources: [{ id: "cpu", cpu: 4, memoryGb: 8, gpu: 0, vramGb: 0, maxConcurrent: 2 }],
    asha: { enabled: true, familySize: 2, reductionFactor: 2, agentCandidates: true },
  };
  const config = await loadConfig(await configFile(value));
  assert.equal(config.evaluator.preflight?.timeoutSeconds, 60);
  assert.equal(config.evaluator.checkpointing?.manifestName, "state.json");
  assert.equal(config.evaluator.cache?.results, true);
  assert.equal(config.execution?.asha?.familySize, 2);
  assert.equal(config.search?.surrogate?.candidatePoolSize, 16);
  assert.deepEqual(config.search?.sweeps, { enabled: true, maxValues: 4, maxConcurrentTrials: 2, reductionFactor: 2 });
  assert.equal(config.learning.ensemble?.maximumMembers, 3);
});

test("config bounds parameter sweep concurrency by execution capacity", async () => {
  const value = minimalConfig();
  value.project = { sourceDir: ".", mutablePaths: ["experiment.json"] };
  value.search = {
    enabled: true,
    parameters: [{ name: "depth", file: "experiment.json", path: "depth", type: "integer", min: 1, max: 4 }],
    sweeps: { maxValues: 4, maxConcurrentTrials: 2, reductionFactor: 2 },
  };
  value.execution = { experimentConcurrency: 1, resourceSlots: ["only-one"] };
  await assert.rejects(loadConfig(await configFile(value)), /maxConcurrentTrials 2 exceeds execution resource capacity 1/);
});

test("config resolves metric display formats and rejects unknown formats", async () => {
  const value = minimalConfig();
  value.metrics = {
    primary: { name: "hit_rate", direction: "maximize", format: "percentage" },
    guardrails: [{ name: "failure_rate", direction: "minimize", format: "percentage", max: 0.05 }],
    objectives: [{ name: "latency_ms", direction: "minimize", format: "number" }],
  };
  const config = await loadConfig(await configFile(value));
  assert.equal(config.metrics.primary.format, "percentage");
  assert.equal(config.metrics.guardrails[0]?.format, "percentage");
  assert.equal(config.metrics.objectives?.[0]?.format, "number");

  const invalid = minimalConfig();
  invalid.metrics = { primary: { name: "loss", direction: "minimize", format: "currency" } };
  await assert.rejects(loadConfig(await configFile(invalid)), /metrics\.primary\.format must be number or percentage/);
});

test("config loads bounded agent evaluation requests", async () => {
  const value = minimalConfig();
  value.evaluator = {
    command: ["python3", "evaluate.py"],
    agentRequests: { allowPairedComparison: true, maxSeeds: 7 },
  };
  const config = await loadConfig(await configFile(value));
  assert.deepEqual(config.evaluator.agentRequests, { allowPairedComparison: true, maxSeeds: 7 });
});

test("config rejects strategy rates above the complete experiment budget", async () => {
  const file = await configFile(minimalConfig({
    strategy: { explorationRate: 0.5, backtrackRate: 0.3, replicationRate: 0.2, falsificationRate: 0.1 },
  }));
  await assert.rejects(loadConfig(file), /must sum to <= 1/);
});

test("config loads human-approved lessons and requires unique ids", async () => {
  const learning = {
    humanLessons: [
      { id: "fixed-budget", claim: "Keep the training budget fixed", guidance: "avoid" },
      { id: "fixed-budget", claim: "Do not add epochs", guidance: "avoid" },
    ],
  };
  await assert.rejects(loadConfig(await configFile(minimalConfig(learning))), /ids must be unique/);
});

test("config keeps hidden evaluator files read-only", async () => {
  const value = minimalConfig();
  value.project = { sourceDir: ".", mutablePaths: ["model.py", "holdout.py"], hiddenPaths: ["holdout.py"] };
  await assert.rejects(loadConfig(await configFile(value)), /hiddenPaths cannot also be mutable/);
});

test("config requires a canonical final stage and isolated parallel search resources", async () => {
  const stages = minimalConfig();
  stages.evaluator = {
    command: ["python3", "evaluate.py"],
    stages: [{ name: "screen", budgetRatio: 0.25 }, { name: "almost", budgetRatio: 0.8 }],
  };
  await assert.rejects(loadConfig(await configFile(stages)), /final evaluator stage must use budgetRatio=1/);

  const parallel = minimalConfig();
  parallel.project = { sourceDir: ".", mutablePaths: ["experiment.json"] };
  parallel.search = { enabled: true, parameters: [{ name: "depth", file: "experiment.json", path: "depth", type: "integer", min: 1, max: 4 }] };
  parallel.execution = { experimentConcurrency: 2, resourceSlots: ["gpu-0"] };
  await assert.rejects(loadConfig(await configFile(parallel)), /at least experimentConcurrency entries/);
});

test("config rejects final-stage repetitions above the statistical seed limit", async () => {
  const value = minimalConfig();
  value.evaluator = {
    command: ["python3", "evaluate.py"],
    repetitions: 2,
    seeds: [1, 2, 3],
    stages: [{ name: "canonical", budgetRatio: 1, repetitions: 3 }],
    statistics: { minimumSeeds: 2, maximumSeeds: 2 },
  };
  await assert.rejects(loadConfig(await configFile(value)), /final evaluator stage repetitions.*maximumSeeds/);

  const disabled = minimalConfig();
  disabled.evaluator = {
    command: ["python3", "evaluate.py"],
    repetitions: 2,
    seeds: [1, 2, 3],
    stages: [{ name: "canonical", budgetRatio: 1, repetitions: 3 }],
    statistics: { enabled: false, minimumSeeds: 1, maximumSeeds: 1 },
  };
  const disabledConfig = await loadConfig(await configFile(disabled));
  assert.equal(disabledConfig.evaluator.stages?.at(-1)?.repetitions, 3);
});

test("config requires metric names to be unique across primary, guardrails, and objectives", async () => {
  const guardrail = minimalConfig();
  guardrail.metrics = {
    primary: { name: "loss", direction: "minimize" },
    guardrails: [{ name: "loss", direction: "minimize", max: 1 }],
  };
  await assert.rejects(loadConfig(await configFile(guardrail)), /names must be unique/);

  const objective = minimalConfig();
  objective.metrics = {
    primary: { name: "loss", direction: "minimize" },
    objectives: [{ name: "loss", direction: "minimize" }],
  };
  await assert.rejects(loadConfig(await configFile(objective)), /names must be unique/);
});
