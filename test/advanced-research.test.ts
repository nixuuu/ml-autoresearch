import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { evaluateWorkspace, spawnSpec } from "../src/evaluator.js";
import { AutoresearchHarness } from "../src/harness.js";
import { bestByObjective, dominates, paretoFrontier } from "../src/pareto.js";
import { appendControlCommand, readControlCommands, readRunControl, setRunControl } from "../src/control.js";
import { importProjectLessons, loadProjectKnowledge, persistProjectKnowledge } from "../src/project-knowledge.js";
import { createResearchMemory } from "../src/research-memory.js";
import { createMetaResearchState, maybeUpdateMetaPolicy, recordMetaOutcome, selectAgentProfile } from "../src/meta-research.js";
import { createResearchCampaign, enqueueMergeCandidate } from "../src/research-campaign.js";
import type { HarnessConfig, ResearchNode, ResearcherFactory, RunState } from "../src/types.js";

async function fixture(name: string): Promise<{ root: string; sourceDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `ml-autoresearch-${name}-`));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "experiment.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const spec = JSON.parse(await readFile("experiment.json", "utf8"));
const budget = Number(process.env.AUTORESEARCH_BUDGET_RATIO ?? 1);
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: spec.value, cost: spec.value * budget } }));
`, "utf8");
  return { root, sourceDir };
}

function config(root: string, sourceDir: string): HarnessConfig {
  return {
    version: 2,
    name: "advanced-test",
    project: { sourceDir, mutablePaths: ["experiment.json"], protectedPaths: ["evaluate.mjs"], hiddenPaths: [], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 2, seeds: [1, 2, 3, 4], inheritEnv: ["PATH"], env: {},
      stages: [
        { name: "screen", budgetRatio: 0.25, repetitions: 1, pruneIfClearlyWorse: true },
        { name: "full", budgetRatio: 1, repetitions: 2, pruneIfClearlyWorse: false },
      ],
      statistics: { enabled: true, confidenceLevel: 0.95, equivalenceMargin: 0.01, minimumSeeds: 2, maximumSeeds: 4, seedStep: 1 },
      repetitionConcurrency: 2,
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: {
      primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" },
      guardrails: [], objectives: [{ name: "cost", direction: "minimize", aggregation: "mean", weight: 1 }], pareto: { enabled: true },
    },
    budget: { maxExperiments: 2, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 3, maxBranchDepth: 3, maxTemporaryRegressionRatio: 1, recentExperiments: 10, maxContextLessons: 10,
      supportThreshold: 2, contradictionThreshold: 1, maxFrontierPerCategory: 2,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0, optimizeRate: 1, mergeRate: 0, ablationRate: 0 },
      humanLessons: [], campaign: { enabled: false, queueRate: 0, maxQueued: 10, hypothesesPerProposal: 2, autoAblations: false, maxAblationsPerPromotion: 1, autoMerge: false },
      meta: { enabled: false, updateInterval: 2, warmupExperiments: 2, explorationFloor: 0.05 },
    },
    search: { enabled: true, seed: 7, exploitationRatio: 0, parameters: [{ name: "value", file: "experiment.json", path: "value", type: "integer", min: 2, max: 5 }] },
    execution: { experimentConcurrency: 1, resourceSlots: [] },
    knowledge: { enabled: false, path: path.join(root, "knowledge.json"), scope: {}, minimumConfidence: 0.7 },
    outputDir: path.join(sourceDir, "runs"), researchInstructions: "test advanced research",
  };
}

test("staged evaluator prunes a clear regression and records saved compute", async () => {
  const { root, sourceDir } = await fixture("stages");
  const cfg = config(root, sourceDir);
  const baseline = await evaluateWorkspace(cfg, sourceDir, path.join(root, "baseline"), "baseline");
  const candidateDir = path.join(root, "candidate");
  await mkdir(candidateDir);
  await writeFile(path.join(candidateDir, "experiment.json"), "{\"value\":0}\n", "utf8");
  await writeFile(path.join(candidateDir, "evaluate.mjs"), await readFile(path.join(sourceDir, "evaluate.mjs"), "utf8"), "utf8");
  const candidate = await evaluateWorkspace(cfg, candidateDir, path.join(root, "candidate-eval"), "candidate", {
    reference: { evaluation: baseline, workspacePath: sourceDir, artifactDir: path.join(root, "reference-extra"), experimentId: "reference-extra" },
  });
  assert.equal(candidate.ok, true);
  assert.equal(candidate.pruned, true);
  assert.equal(candidate.stages?.length, 1);
  assert.equal(candidate.statisticalComparison?.status, "regression");
  assert.ok((candidate.computeSavedRatio ?? 0) > 0);
  assert.ok(Math.abs((candidate.computeSavedRatio ?? 0) - 12 / 17) < 1e-9);
});

test("shared evaluator cache is optional and exposed consistently to local and Docker runners", async () => {
  const { root, sourceDir } = await fixture("shared-cache");
  const cfg = config(root, sourceDir);
  const cacheRoot = path.join(root, "shared-cache-root");
  cfg.evaluator.cache = { enabled: true, path: cacheRoot, namespace: "dataset-v1", readOnly: false };
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const cacheDir = process.env.AUTORESEARCH_SHARED_CACHE_DIR;
if (!cacheDir) throw new Error("missing shared cache");
await mkdir(cacheDir, { recursive: true });
await writeFile(path.join(cacheDir, "used.txt"), process.env.AUTORESEARCH_CACHE_NAMESPACE);
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: 1, cost: 1 } }));
`, "utf8");
  cfg.evaluator.stages = [{ name: "canonical", budgetRatio: 1, repetitions: 1, pruneIfClearlyWorse: false }];
  cfg.evaluator.repetitions = 1;
  cfg.evaluator.statistics!.enabled = false;
  const evaluation = await evaluateWorkspace(cfg, sourceDir, path.join(root, "evaluation"), "candidate");
  assert.equal(evaluation.ok, true);
  assert.equal(await readFile(path.join(cacheRoot, "dataset-v1", "used.txt"), "utf8"), "dataset-v1");

  const localSpec = spawnSpec(cfg, sourceDir, path.join(root, "artifacts"), path.join(root, "artifacts", "metrics.json"), 17, "candidate", cfg.evaluator.stages[0]!);
  assert.equal(localSpec.env.AUTORESEARCH_SHARED_CACHE_DIR, path.join(cacheRoot, "dataset-v1"));

  cfg.evaluator.runner = { ...cfg.evaluator.runner, mode: "docker", image: "python:3.13-slim" };
  cfg.evaluator.cache.readOnly = true;
  const dockerSpec = spawnSpec(cfg, sourceDir, path.join(root, "artifacts"), path.join(root, "artifacts", "metrics.json"), 17, "candidate", cfg.evaluator.stages[0]!);
  assert.ok(dockerSpec.args.includes("AUTORESEARCH_SHARED_CACHE_DIR=/autoresearch-cache"));
  assert.ok(dockerSpec.args.includes(`type=bind,src=${path.join(cacheRoot, "dataset-v1")},dst=/autoresearch-cache,readonly`));

  delete cfg.evaluator.cache;
  const disabledSpec = spawnSpec(cfg, sourceDir, path.join(root, "artifacts"), path.join(root, "artifacts", "metrics.json"), 17, "candidate", cfg.evaluator.stages[0]!);
  assert.ok(!disabledSpec.args.some((argument) => argument.includes("AUTORESEARCH_SHARED_CACHE_DIR")));
});

test("evaluator exposes preflight, cumulative checkpoints, phase telemetry and exact result cache", async () => {
  const { root, sourceDir } = await fixture("observable-evaluator");
  const cfg = config(root, sourceDir);
  const cacheRoot = path.join(root, "cache");
  await writeFile(path.join(sourceDir, "preflight.mjs"), "process.exit(0);\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const cache = process.env.AUTORESEARCH_SHARED_CACHE_DIR;
await mkdir(cache, { recursive: true });
const countPath = path.join(cache, "count.txt");
let count = 0;
try { count = Number(await readFile(countPath, "utf8")); } catch {}
await writeFile(countPath, String(count + 1));
if (process.env.AUTORESEARCH_STAGE === "full") {
  if (!process.env.AUTORESEARCH_PREVIOUS_STAGE_ARTIFACT_DIR || !process.env.AUTORESEARCH_PREVIOUS_CHECKPOINT_MANIFEST_PATH) throw new Error("missing previous stage checkpoint");
  await readFile(process.env.AUTORESEARCH_PREVIOUS_CHECKPOINT_MANIFEST_PATH, "utf8");
}
await writeFile(process.env.AUTORESEARCH_PHASE_EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), phase: "training", status: "completed", durationMs: 25 }) + "\\n");
await writeFile(process.env.AUTORESEARCH_CHECKPOINT_MANIFEST_PATH, JSON.stringify({ stage: process.env.AUTORESEARCH_STAGE }));
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: 2, cost: 1 } }));
`, "utf8");
  cfg.evaluator.cache = { enabled: true, path: cacheRoot, namespace: "v1", readOnly: false, results: true };
  cfg.evaluator.preflight = { enabled: true, command: [process.execPath, "preflight.mjs"], timeoutSeconds: 5 };
  cfg.evaluator.checkpointing = { enabled: true, manifestName: "checkpoint.json" };
  cfg.evaluator.telemetry = { enabled: true };
  cfg.evaluator.statistics!.enabled = false;
  cfg.evaluator.repetitions = 1;
  cfg.evaluator.stages = [
    { name: "screen", budgetRatio: 0.2, repetitions: 1, pruneIfClearlyWorse: false },
    { name: "full", budgetRatio: 1, repetitions: 1, pruneIfClearlyWorse: false },
  ];
  const streamedPhases: string[] = [];
  const first = await evaluateWorkspace(cfg, sourceDir, path.join(root, "first"), "first", {
    onPhase: (event, context) => streamedPhases.push(`${context.stage}:${event.phase}:${event.status}`),
  });
  const second = await evaluateWorkspace(cfg, sourceDir, path.join(root, "second"), "second");
  assert.equal(first.preflight?.ok, true);
  assert.equal(first.phaseDurationsMs?.training, 50);
  assert.deepEqual(streamedPhases, ["screen:training:completed", "full:training:completed"]);
  assert.equal(first.attempts[0]?.checkpointManifestPath?.endsWith("checkpoint-0.json"), true);
  assert.equal(first.cacheMisses, 1);
  assert.equal(second.cacheHits, 1);
  assert.equal(second.cacheMisses, 0);
  assert.equal(await readFile(path.join(cacheRoot, "v1", "count.txt"), "utf8"), "3");
});

test("harness executes deterministic search without asking the agent to mutate the second candidate", async () => {
  const { root, sourceDir } = await fixture("search");
  const cfg = config(root, sourceDir);
  cfg.evaluator.statistics!.enabled = false;
  cfg.budget.maxExperiments = 3;
  cfg.execution = { experimentConcurrency: 2, resourceSlots: ["cpu-0", "cpu-1"] };
  let calls = 0;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      calls += 1;
      await writeFile(path.join(workspacePath, "experiment.json"), "{\"value\":2}\n", "utf8");
      return { narrative: "initial improvement" };
    },
  });
  const state = await new AutoresearchHarness(cfg, factory).run({ configPath: path.join(root, "config.json") });
  assert.equal(calls, 1);
  assert.equal(state.experiments[1]?.strategy, "optimize");
  assert.equal(state.experiments[2]?.strategy, "optimize");
  assert.equal(state.experiments[1]?.agentProfileId, "harness-search");
  assert.equal(state.experiments[2]?.agentProfileId, "harness-search");
  assert.ok(state.experiments[1]?.plan?.searchSuggestion);
  assert.match(await readFile(state.experiments[1]!.proposalPath!, "utf8"), /Harness-planned parallel optimize/);
  assert.match(await readFile(path.join(state.runDir, "events.jsonl"), "utf8"), /"parallelBatch":2/);
});

test("ASHA advances only the strongest deterministic candidate to the canonical rung", async () => {
  const { root, sourceDir } = await fixture("asha-search");
  const cfg = config(root, sourceDir);
  cfg.evaluator.statistics!.enabled = false;
  cfg.budget.maxExperiments = 3;
  cfg.execution = {
    experimentConcurrency: 2,
    resourceSlots: ["cpu-0", "cpu-1"],
    asha: { enabled: true, familySize: 2, reductionFactor: 2, agentCandidates: false },
  };
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      await writeFile(path.join(workspacePath, "experiment.json"), "{\"value\":2}\n", "utf8");
      return { narrative: "initial improvement" };
    },
  });
  const state = await new AutoresearchHarness(cfg, factory).run({ configPath: path.join(root, "config.json") });
  const family = state.experiments.slice(1);
  assert.equal(family.length, 2);
  assert.equal(family.filter((experiment) => experiment.evaluation.pruned).length, 1);
  assert.equal(family.filter((experiment) => experiment.evaluation.stages?.length === 2).length, 1);
});

test("ASHA can prepare a parallel family with independent agent sessions", async () => {
  const { root, sourceDir } = await fixture("asha-agents");
  const cfg = config(root, sourceDir);
  cfg.search = undefined;
  cfg.evaluator.statistics!.enabled = false;
  cfg.budget.maxExperiments = 2;
  cfg.execution = {
    experimentConcurrency: 2,
    resourceSlots: ["cpu-0", "cpu-1"],
    asha: { enabled: true, familySize: 2, reductionFactor: 2, agentCandidates: true },
  };
  let calls = 0;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      const value = 2 + calls++;
      await writeFile(path.join(workspacePath, "experiment.json"), `${JSON.stringify({ value })}\n`, "utf8");
      return { narrative: `agent candidate ${value}` };
    },
  });
  const state = await new AutoresearchHarness(cfg, factory).run({ configPath: path.join(root, "config.json") });
  assert.equal(calls, 2);
  assert.equal(state.experiments.length, 2);
  assert.equal(state.experiments.filter((experiment) => experiment.evaluation.pruned).length, 1);
  assert.ok(state.experiments.every((experiment) => experiment.agentProfileId === "default"));
});

test("parallel search records preparation failures per candidate instead of aborting the run", async () => {
  const { root, sourceDir } = await fixture("search-failure");
  const cfg = config(root, sourceDir);
  cfg.evaluator.statistics!.enabled = false;
  cfg.project.mutablePaths = ["missing.json"];
  cfg.search = {
    enabled: true,
    seed: 7,
    exploitationRatio: 0,
    parameters: [{ name: "missing", file: "missing.json", path: "value", type: "integer", min: 2, max: 5 }],
  };
  cfg.budget.maxExperiments = 3;
  cfg.budget.maxConsecutiveFailures = 5;
  cfg.execution = { experimentConcurrency: 2, resourceSlots: ["cpu-0", "cpu-1"] };
  let calls = 0;
  const factory: ResearcherFactory = async () => ({ async propose() { calls += 1; return { narrative: "no-op warmup" }; } });
  const state = await new AutoresearchHarness(cfg, factory).run({ configPath: path.join(root, "config.json") });
  assert.equal(calls, 1);
  assert.equal(state.experiments.length, 3);
  assert.deepEqual(state.experiments.slice(1).map((experiment) => experiment.decision.status), ["failure", "failure"]);
  assert.ok(state.experiments.slice(1).every((experiment) => experiment.evaluation.error?.includes("Candidate preparation failed")));
  assert.match(await readFile(path.join(state.runDir, "events.jsonl"), "utf8"), /candidate_preparation_failed/);
});

test("a queued search ticket applies its exact preregistered parameter suggestion", async () => {
  const { root, sourceDir } = await fixture("search-ticket");
  const cfg = config(root, sourceDir);
  cfg.evaluator.statistics!.enabled = false;
  cfg.budget.maxExperiments = 1;
  cfg.learning.campaign = { enabled: true, queueRate: 1, maxQueued: 10, hypothesesPerProposal: 2, autoAblations: false, maxAblationsPerPromotion: 1, autoMerge: false };
  let queued = false;
  const factory: ResearcherFactory = async () => ({ async propose() { throw new Error("agent should not be called for a search ticket"); } });
  const state = await new AutoresearchHarness(cfg, factory).run({
    configPath: path.join(root, "config.json"),
    onState: async (snapshot) => {
      if (queued || snapshot.experiments.length > 0) return;
      queued = true;
      const now = new Date().toISOString();
      await appendControlCommand(snapshot.runDir, {
        id: "enqueue-search",
        type: "enqueue",
        createdAt: now,
        ticket: {
          id: "search-exact", kind: "search", hypothesis: "Evaluate value five", status: "queued",
          createdAt: now, updatedAt: now, createdBy: "human", dependencies: [], expectedGain: 1,
          probabilityOfSuccess: 0.5, informationGain: 1, estimatedCost: 1, priority: 1,
          searchSuggestion: { "experiment.json:value": 5 },
        },
      });
    },
  });
  assert.equal(state.experiments[0]?.strategy, "optimize");
  assert.deepEqual(state.experiments[0]?.plan?.searchSuggestion, { "experiment.json:value": 5 });
  assert.deepEqual(JSON.parse(await readFile(path.join(state.experiments[0]!.workspacePath, "experiment.json"), "utf8")), { value: 5 });
});

test("a promoted multi-file change schedules and executes a component ablation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-ablation-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "a.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "b.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const a = JSON.parse(await readFile("a.json", "utf8"));
const b = JSON.parse(await readFile("b.json", "utf8"));
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: a.value + b.value } }));
`, "utf8");
  const cfg = config(root, sourceDir);
  cfg.project.mutablePaths = ["a.json", "b.json"];
  cfg.project.protectedPaths = ["evaluate.mjs"];
  cfg.evaluator.statistics!.enabled = false;
  cfg.evaluator.stages = [{ name: "canonical", budgetRatio: 1, repetitions: 1, pruneIfClearlyWorse: false }];
  cfg.evaluator.repetitions = 1;
  cfg.metrics = { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" }, guardrails: [] };
  cfg.search = { enabled: false, seed: 1, exploitationRatio: 0, parameters: [] };
  cfg.execution = { experimentConcurrency: 1, resourceSlots: [] };
  cfg.learning.strategy = { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0, optimizeRate: 0, mergeRate: 0, ablationRate: 0 };
  cfg.learning.campaign = { enabled: true, queueRate: 1, maxQueued: 10, hypothesesPerProposal: 2, autoAblations: true, maxAblationsPerPromotion: 2, autoMerge: false };
  let calls = 0;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      calls += 1;
      await Promise.all([
        writeFile(path.join(workspacePath, "a.json"), "{\"value\":2}\n", "utf8"),
        writeFile(path.join(workspacePath, "b.json"), "{\"value\":2}\n", "utf8"),
      ]);
      return { narrative: "two-component improvement" };
    },
  });
  const state = await new AutoresearchHarness(cfg, factory).run({ configPath: path.join(root, "config.json") });
  assert.equal(calls, 1);
  assert.equal(state.experiments[0]?.decision.status, "promote");
  assert.equal(state.experiments[1]?.strategy, "ablate");
  assert.equal(state.experiments[1]?.changedPaths.length, 1);
  assert.ok(state.experiments[1]?.plan?.ablation);
  assert.equal(state.campaign?.tickets.filter((ticket) => ticket.kind === "ablation" && ticket.status === "completed").length, 1);
});

test("an interrupted future-schema run resumes without rerunning its baseline", async () => {
  const { root, sourceDir } = await fixture("resume");
  const cfg = config(root, sourceDir);
  cfg.evaluator.statistics!.enabled = false;
  cfg.budget.maxExperiments = 1;
  const aborted = new AbortController();
  aborted.abort();
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      await writeFile(path.join(workspacePath, "experiment.json"), "{\"value\":2}\n", "utf8");
      return { narrative: "resume candidate" };
    },
  });
  const first = await new AutoresearchHarness(cfg, factory).run({ configPath: path.join(root, "config.json"), signal: aborted.signal });
  assert.equal(first.status, "interrupted");
  assert.equal(first.experiments.length, 0);
  const baselineStartedAt = first.baseline.attempts[0]!.stdoutPath;
  await mkdir(path.join(first.runDir, "experiments", "exp-0001", "workspace"), { recursive: true });
  await writeFile(path.join(first.runDir, "experiments", "exp-0001", "workspace", "partial.txt"), "recover me", "utf8");
  const resumed = await new AutoresearchHarness(cfg, factory).run({
    configPath: path.join(first.runDir, "config.resolved.json"), resumeRunDir: first.runDir,
  });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.experiments.length, 1);
  assert.equal(resumed.baseline.attempts[0]!.stdoutPath, baselineStartedAt);
  assert.equal((await readdir(path.join(first.runDir, "orphaned"))).length, 1);
});

test("a live run pauses and resumes at a safe boundary", async () => {
  const { root, sourceDir } = await fixture("pause-resume");
  const cfg = config(root, sourceDir);
  cfg.evaluator.statistics!.enabled = false;
  cfg.budget.maxExperiments = 1;
  const statuses: string[] = [];
  let pauseRequested = false;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      await writeFile(path.join(workspacePath, "experiment.json"), "{\"value\":2}\n", "utf8");
      return { narrative: "candidate after pause" };
    },
  });
  const state = await new AutoresearchHarness(cfg, factory).run({
    configPath: path.join(root, "config.json"),
    onState: async (snapshot) => {
      statuses.push(snapshot.status);
      if (!pauseRequested && snapshot.status === "running" && snapshot.experiments.length === 0) {
        pauseRequested = true;
        await setRunControl(snapshot.runDir, "paused", "test pause");
      } else if (snapshot.status === "paused") {
        await setRunControl(snapshot.runDir, "running", "test resume");
      }
    },
  });
  assert.ok(statuses.includes("paused"));
  assert.equal(state.status, "completed");
  assert.equal((await readRunControl(state.runDir)).desiredState, "stopped");
});

test("interrupting a paused run finalizes it as interrupted", async () => {
  const { root, sourceDir } = await fixture("pause-interrupt");
  const cfg = config(root, sourceDir);
  cfg.evaluator.statistics!.enabled = false;
  cfg.budget.maxExperiments = 1;
  const abort = new AbortController();
  let pauseRequested = false;
  const factory: ResearcherFactory = async () => ({ async propose() { throw new Error("agent should not run while paused"); } });
  const state = await new AutoresearchHarness(cfg, factory).run({
    configPath: path.join(root, "config.json"),
    signal: abort.signal,
    onState: async (snapshot) => {
      if (!pauseRequested && snapshot.status === "running" && snapshot.experiments.length === 0) {
        pauseRequested = true;
        await setRunControl(snapshot.runDir, "paused", "inspect before interrupt");
      } else if (snapshot.status === "paused") {
        abort.abort();
      }
    },
  });
  assert.equal(state.status, "interrupted");
  assert.match(state.stopReason ?? "", /while paused/);
  assert.equal((await readRunControl(state.runDir)).desiredState, "stopped");
});

test("control commands are append-only and Pareto helpers keep trade-off winners", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-control-"));
  await setRunControl(runDir, "paused", "inspect");
  assert.equal((await readRunControl(runDir)).desiredState, "paused");
  const now = new Date().toISOString();
  const ticket = { id: "human-1", kind: "hypothesis" as const, hypothesis: "test another branch", status: "queued" as const, createdAt: now, updatedAt: now, createdBy: "human" as const, dependencies: [], expectedGain: 0, probabilityOfSuccess: 0.5, informationGain: 1, estimatedCost: 1, priority: 1 };
  await appendControlCommand(runDir, { id: "command-1", type: "enqueue", createdAt: now, ticket });
  assert.equal((await readControlCommands(runDir)).commands[0]?.type, "enqueue");

  const objectives = [
    { name: "score", direction: "maximize" as const, aggregation: "mean" as const, weight: 1 },
    { name: "cost", direction: "minimize" as const, aggregation: "mean" as const, weight: 1 },
  ];
  const node = (id: string, score: number, cost: number): ResearchNode => ({ id, workspacePath: id, workspaceFingerprint: id, metrics: { score, cost }, branchDepth: 0, status: "frontier", wasLeader: false, strategy: "explore", changeCategory: "other", selectedCount: 0 });
  const nodes = [node("fast", 8, 1), node("accurate", 10, 3), node("dominated", 7, 4)];
  assert.equal(dominates(nodes[0]!.metrics, nodes[2]!.metrics, objectives), true);
  assert.deepEqual(paretoFrontier(nodes, objectives).map((entry) => entry.id), ["fast", "accurate"]);
  assert.deepEqual(bestByObjective(nodes, objectives), { score: { experimentId: "accurate", value: 10 }, cost: { experimentId: "fast", value: 1 } });
});

test("project knowledge imports supported cross-run lessons as tentative verification targets", async () => {
  const { root, sourceDir } = await fixture("knowledge");
  const cfg = config(root, sourceDir);
  cfg.knowledge = { enabled: true, path: path.join(root, "project-knowledge.json"), scope: { dataset: "v1" }, minimumConfidence: 0.7 };
  const now = new Date().toISOString();
  const memory = createResearchMemory(cfg, now);
  memory.lessons.push({
    id: "lesson-0001", claim: "Depth three is stable on dataset v1.", normalizedClaim: "depth three is stable on dataset v1.",
    status: "supported", guidance: "consider", confidence: 0.9, evidenceFor: ["exp-1", "exp-2"], evidenceAgainst: [], createdAt: now, updatedAt: now,
  });
  const baseline = { ok: true, attempts: [], aggregatedMetrics: { score: 1, cost: 1 } };
  const state: RunState = {
    schemaVersion: 6, runId: "run-one", name: cfg.name, status: "completed", startedAt: now, configPath: "config.json", runDir: root,
    sourceDir, primaryMetric: cfg.metrics.primary, acceptedWorkspacePath: sourceDir, baseline, acceptedMetrics: baseline.aggregatedMetrics,
    researchMemory: memory, experiments: [],
  };
  await persistProjectKnowledge(cfg, state);
  const stored = await loadProjectKnowledge(cfg);
  assert.equal(stored?.lessons[0]?.status, "supported");
  const imported = importProjectLessons(createResearchMemory(cfg, now), stored);
  assert.equal(imported.lessons[0]?.status, "tentative");
  assert.equal(imported.lessons[0]?.guidance, "verify");
  assert.deepEqual(imported.lessons[0]?.evidenceFor, []);
});

test("meta-research explores untried implementer profiles and records policy updates", async () => {
  const { root, sourceDir } = await fixture("meta");
  const cfg = config(root, sourceDir);
  cfg.agent.pool = [
    { id: "sol", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh" },
    { id: "luna", model: "openai-codex/gpt-5.6-luna", thinkingLevel: "max" },
  ];
  cfg.learning.meta = { enabled: true, warmupExperiments: 2, updateInterval: 2, explorationFloor: 0.05 };
  const meta = createMetaResearchState(cfg);
  const first = selectAgentProfile(cfg, meta);
  recordMetaOutcome(meta, first.id, "exploit", 0.4, "promote");
  const second = selectAgentProfile(cfg, meta);
  assert.notEqual(second.id, first.id);
  recordMetaOutcome(meta, second.id, "explore", -0.2, "other");
  maybeUpdateMetaPolicy(cfg, meta, 2);
  assert.equal(meta.agentPerformance.reduce((sum, profile) => sum + profile.trials, 0), 2);
  assert.equal(meta.policyUpdates.length, 1);
  assert.ok((meta.policyUpdates[0]?.strategyRates.exploit ?? 0) > (meta.policyUpdates[0]?.strategyRates.explore ?? 0));
});

test("campaign schedules merge only for disjoint non-ancestor frontier branches", async () => {
  const { root, sourceDir } = await fixture("merge-campaign");
  const cfg = config(root, sourceDir);
  cfg.learning.campaign = { enabled: true, queueRate: 1, maxQueued: 10, hypothesesPerProposal: 2, autoAblations: false, maxAblationsPerPromotion: 1, autoMerge: true };
  const makeNode = (id: string, parentId: string): ResearchNode => ({ id, parentId, workspacePath: id, workspaceFingerprint: id, metrics: { score: 1, cost: 1 }, branchDepth: 1, status: "frontier", wasLeader: false, strategy: "explore", changeCategory: "other", selectedCount: 0 });
  const graph = {
    schemaVersion: 3 as const,
    leaderId: "baseline",
    frontierIds: ["exp-0001", "exp-0002"],
    paretoFrontierIds: ["baseline"],
    nodes: [
      { ...makeNode("baseline", "root"), parentId: undefined, status: "leader" as const },
      makeNode("exp-0001", "baseline"),
      makeNode("exp-0002", "baseline"),
    ].map((node) => {
      if (node.id === "baseline") {
        const { parentId: _parentId, ...baseline } = node;
        return baseline;
      }
      return node;
    }),
  };
  const baseRecord = {
    startedAt: "now", finishedAt: "now", branchDepth: 1, forbiddenChanges: [],
    evaluation: { ok: true, attempts: [], aggregatedMetrics: { score: 1, cost: 1 } },
    decision: { status: "retain" as const, primaryDelta: 0, reasons: [] },
    accounting: {
      durationMs: 0, evaluatorDurationMs: 0,
      agentUsage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
      primaryImprovement: null, relativePrimaryImprovement: null, costPerImprovementUsd: null, timePerImprovementMs: null,
    },
  };
  const experiments = [
    { ...baseRecord, id: "exp-0001", index: 1, workspacePath: "exp-0001", parentId: "baseline", strategy: "explore" as const, changedPaths: ["a.json"] },
    { ...baseRecord, id: "exp-0002", index: 2, workspacePath: "exp-0002", parentId: "baseline", strategy: "explore" as const, changedPaths: ["b.json"] },
  ];
  const campaign = createResearchCampaign("merge", "run");
  const ticket = enqueueMergeCandidate(campaign, graph, experiments, cfg);
  assert.deepEqual(ticket?.merge, { sourceExperimentIds: ["exp-0001", "exp-0002"], pathsFromSecond: ["b.json"] });
  graph.nodes.find((node) => node.id === "exp-0002")!.parentId = "exp-0001";
  const secondCampaign = createResearchCampaign("no descendant merge", "run-2");
  assert.equal(enqueueMergeCandidate(secondCampaign, graph, experiments, cfg), undefined);
});
