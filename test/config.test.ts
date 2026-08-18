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
  assert.equal(config.agent.analysis, undefined);
  assert.equal(config.agent.backend.type, "pi-sdk");
  assert.deepEqual(config.agent.backend.command, []);
  assert.equal(config.agent.backend.telemetry?.enabled, false);
  assert.equal(config.agent.lab, undefined);
  assert.equal(config.agent.orchestration?.mode, "single");
});

test("config loads adaptive specialist roles and evidence-gated method refinement", async () => {
  const value = minimalConfig({
    refinement: { enabled: true, minimumEvidence: 3, allowedKinds: ["analysis-recipe", "prompt-note"] },
  });
  value.agent = {
    orchestration: { mode: "adaptive", maxAdvisors: 3, maxParallel: 2, failureAnalystAfter: 2 },
    roles: {
      "hypothesis-generator": { thinkingLevel: "medium" },
      statistician: { thinkingLevel: "high" },
      "failure-analyst": { thinkingLevel: "high" },
    },
  };
  const config = await loadConfig(await configFile(value));
  assert.equal(config.agent.orchestration?.mode, "adaptive");
  assert.equal(config.agent.orchestration?.maxParallel, 2);
  assert.equal(config.agent.roles?.statistician?.id, "statistician");
  assert.equal(config.learning.refinement?.minimumEvidence, 3);
  assert.deepEqual(config.learning.refinement?.allowedKinds, ["analysis-recipe", "prompt-note"]);

  const invalid = structuredClone(value);
  (invalid.agent as Record<string, any>).orchestration.maxParallel = 4;
  await assert.rejects(loadConfig(await configFile(invalid)), /maxParallel cannot exceed maxAdvisors/);
});

test("config loads a Docker-isolated Prime Agent backend and persistent lab", async () => {
  const value = minimalConfig();
  value.agent = {
    backend: {
      type: "prime-agent-rpc",
      command: ["prime-agent"],
      timeoutSeconds: 900,
      inheritEnv: ["PRIME_API_KEY"],
      telemetry: { enabled: true },
      runner: { mode: "docker", image: "prime-agent:test", network: "none" },
    },
    lab: {
      engine: "python",
      path: "research-labs",
      maxCalls: 50,
      runner: { mode: "docker", image: "python:3.13-slim", network: "none" },
    },
  };
  const file = await configFile(value);
  const config = await loadConfig(file);
  assert.equal(config.agent.backend.type, "prime-agent-rpc");
  assert.equal(config.agent.backend.runner.image, "prime-agent:test");
  assert.deepEqual(config.agent.backend.inheritEnv, ["PRIME_API_KEY"]);
  assert.equal(config.agent.backend.telemetry?.enabled, true);
  assert.equal(config.agent.lab?.path, path.join(path.dirname(file), "research-labs"));
  assert.equal(config.agent.lab?.maxCalls, 50);

  const localPrime = structuredClone(value);
  (localPrime.agent as Record<string, any>).backend.runner = { mode: "local", allowHostExecution: true };
  await assert.rejects(loadConfig(await configFile(localPrime)), /prime-agent-rpc backend requires Docker runner mode/);

  const unsafeLocalLab = minimalConfig();
  unsafeLocalLab.agent = { lab: { runner: { mode: "local" } } };
  await assert.rejects(loadConfig(await configFile(unsafeLocalLab)), /agent\.lab local runner requires explicit/);
});

test("config loads a neutral remote evaluator broker", async () => {
  const value = minimalConfig();
  (value.evaluator as Record<string, unknown>).runner = {
    mode: "remote",
    network: "none",
    remote: { command: ["remote-evaluator-broker"], timeoutSeconds: 900, inheritEnv: ["REMOTE_TOKEN"] },
  };
  const config = await loadConfig(await configFile(value));
  assert.equal(config.evaluator.runner.mode, "remote");
  assert.deepEqual(config.evaluator.runner.remote?.command, ["remote-evaluator-broker"]);
  assert.equal(config.evaluator.runner.remote?.maxResponseBytes, 8_388_608);
});

test("config makes arbitrary local analysis an explicit trust decision", async () => {
  const unsafe = minimalConfig();
  unsafe.agent = { analysis: { enabled: true, runner: { mode: "local" } } };
  await assert.rejects(loadConfig(await configFile(unsafe)), /requires explicit runner\.allowHostExecution=true/);

  const trusted = minimalConfig();
  trusted.agent = {
    analysis: {
      enabled: true,
      timeoutSeconds: 45,
      maxCalls: 12,
      minimumCallsBeforeProposal: 2,
      maxOutputBytes: 8192,
      runner: { mode: "local", allowHostExecution: true },
    },
  };
  const config = await loadConfig(await configFile(trusted));
  assert.equal(config.agent.analysis?.runner.mode, "local");
  assert.equal(config.agent.analysis?.runner.allowHostExecution, true);
  assert.equal(config.agent.analysis?.maxCalls, 12);
  assert.equal(config.agent.analysis?.minimumCallsBeforeProposal, 2);

  const docker = minimalConfig();
  docker.agent = { analysis: { runner: { mode: "docker" } } };
  await assert.rejects(loadConfig(await configFile(docker)), /Docker runner requires runner\.image/);
});

test("config loads a controlled runtime dependency broker shared with Docker evaluation", async () => {
  const value = minimalConfig();
  value.project = { sourceDir: ".", mutablePaths: ["candidate"] };
  value.agent = {
    analysis: {
      enabled: true,
      runner: { mode: "docker", image: "research-runtime:test", network: "none" },
    },
  };
  value.evaluator = {
    command: ["python3", "evaluate.py"],
    runner: { mode: "docker", image: "research-runtime:test", network: "none" },
  };
  value.runtimeDependencies = {
    manifestPath: "candidate/autoresearch.dependencies.json",
    allowedManagers: ["python", "bun"],
    allow: [
      { manager: "python", package: "xgboost", versions: "==3.0.4" },
      { manager: "bun", package: "zod", versions: "4.1.5" },
    ],
    deny: [{ manager: "python", package: "unsafe-package" }],
    cachePath: "dependency-cache",
    environmentProfiles: { gpu: { image: "research-runtime:gpu", gpus: "all", memory: "16g" } },
  };
  const file = await configFile(value);
  const config = await loadConfig(file);
  assert.equal(config.runtimeDependencies?.strategy, "locked-overlay");
  assert.deepEqual(config.runtimeDependencies?.allowedManagers, ["python", "bun"]);
  assert.equal(config.runtimeDependencies?.manifestPath, "candidate/autoresearch.dependencies.json");
  assert.equal(config.runtimeDependencies?.cachePath, path.join(path.dirname(file), "dependency-cache"));
  assert.equal(config.runtimeDependencies?.python.onlyBinary, true);
  assert.equal(config.runtimeDependencies?.bun.ignoreScripts, true);
  assert.equal(config.runtimeDependencies?.environmentProfiles.gpu?.gpus, "all");

  const localEvaluator = structuredClone(value);
  (localEvaluator.evaluator as Record<string, unknown>).runner = { mode: "local" };
  await assert.rejects(loadConfig(await configFile(localEvaluator)), /requires evaluator Docker mode/);

  const protectedManifest = structuredClone(value);
  protectedManifest.project = { sourceDir: ".", mutablePaths: ["candidate/model.py"] };
  await assert.rejects(loadConfig(await configFile(protectedManifest)), /manifestPath must be inside project\.mutablePaths/);
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
    retireAfterSemanticNoOps: 3,
    parameters: [{ name: "depth", file: "experiment.json", path: "depth", type: "integer", min: 1, max: 4, requiresCapability: "tree-depth-v1" }],
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
  assert.equal(config.search?.retireAfterSemanticNoOps, 3);
  assert.equal(config.search?.parameters[0]?.requiresCapability, "tree-depth-v1");
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
