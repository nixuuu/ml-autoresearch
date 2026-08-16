import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { AutoresearchHarness } from "../src/harness.js";
import type { HarnessConfig, ResearchContext, ResearcherFactory } from "../src/types.js";

test("harness promotes an improvement, retains a bounded branch, and preserves the leader", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-test-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "model.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const model = JSON.parse(await readFile("model.json", "utf8"));
const metrics = { score: model.value, complexity: model.value };
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics }));
`, "utf8");

  const config: HarnessConfig = {
    version: 2,
    name: "integration-test",
    project: { sourceDir, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"],
      timeoutSeconds: 10,
      repetitions: 2,
      seeds: [1, 2],
      inheritEnv: ["PATH"],
      env: {},
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: {
      primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" },
      guardrails: [{ name: "complexity", direction: "minimize", aggregation: "max", max: 3 }],
    },
    budget: { maxExperiments: 2, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 3,
      maxBranchDepth: 3,
      maxTemporaryRegressionRatio: 0.5,
      recentExperiments: 12,
      maxContextLessons: 40,
      supportThreshold: 2,
      contradictionThreshold: 1,
      strategy: { explorationRate: 0.25, backtrackRate: 0.1, replicationRate: 0.1, falsificationRate: 0.1 },
      humanLessons: [],
    },
    outputDir: path.join(sourceDir, "runs"),
    researchInstructions: "test",
  };

  let proposalIndex = 0;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      proposalIndex += 1;
      const value = proposalIndex === 1 ? 2 : 2.05;
      await writeFile(path.join(workspacePath, "model.json"), `${JSON.stringify({ value })}\n`, "utf8");
      return { narrative: `Set value to ${value}` };
    },
    getUsage() {
      return { requests: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 130, costUsd: 0.02 };
    },
  });

  const progress: string[] = [];
  const snapshots: string[] = [];
  const state = await new AutoresearchHarness(config, factory).run({
    configPath: path.join(root, "config.json"),
    onProgress: (message) => progress.push(message),
    onState: (snapshot) => snapshots.push(`${snapshot.status}:${snapshot.experiments.length}`),
  });
  assert.equal(state.status, "completed");
  assert.equal(state.stopReason, "Reached experiment budget of 2");
  assert.deepEqual(state.experiments.map((experiment) => experiment.decision.status), ["promote", "retain"]);
  assert.equal(state.acceptedMetrics.score, 2);
  assert.equal(state.bestObserved?.experimentId, "exp-0002");
  assert.equal(state.bestObserved?.metrics.score, 2.05);
  assert.deepEqual(JSON.parse(await readFile(path.join(state.acceptedWorkspacePath, "model.json"), "utf8")), { value: 2 });
  const report = await readFile(path.join(state.runDir, "REPORT.md"), "utf8");
  assert.match(report, /exp-0001.*promote/);
  assert.match(report, /Best observed result: `exp-0002` \(not promoted by policy\)/);
  assert.match(report, /```mermaid/);
  assert.match(report, /Total agent cost estimate \(SDK\): \$0\.0400/);
  assert.match(report, /Cost \/ relative improvement: \$0\.0002 per \+1 percentage point/);
  assert.equal(JSON.parse(await readFile(path.join(state.runDir, "accepted.json"), "utf8")).experimentId, "exp-0001");
  assert.equal(JSON.parse(await readFile(path.join(state.runDir, "best-observed.json"), "utf8")).experimentId, "exp-0002");
  assert.ok((await readFile(path.join(state.runDir, "events.jsonl"), "utf8")).includes("experiment_decided"));
  assert.equal(state.researchGraph?.leaderId, "exp-0001");
  assert.equal(state.researchMemory?.facts.length, 3);
  assert.equal(state.experiments[0]?.accounting.agentUsage.costUsd, 0.02);
  assert.equal(state.experiments[0]?.accounting.costPerImprovementUsd, 0.0002);
  assert.equal(state.experiments[0]?.accounting.agentUsage.totalTokens, 130);
  assert.ok((state.experiments[0]?.accounting.durationMs ?? -1) >= 0);
  assert.equal(JSON.parse(await readFile(path.join(state.runDir, "experiments", "exp-0001", "accounting.json"), "utf8")).agentUsage.costUsd, 0.02);
  assert.ok((await readFile(path.join(state.runDir, "RESEARCH_MEMORY.md"), "utf8")).includes("Harness facts"));
  const liveLog = progress.join("\n");
  assert.match(liveLog, /Run configuration: model=Pi default, reasoning=off/);
  assert.match(liveLog, /Baseline result: aggregate \{score=1, complexity=1\}; primary attempts/);
  assert.match(liveLog, /exp-0001 PROPOSAL \[other\]: Set value to 2/);
  assert.match(liveLog, /exp-0001 RESULT: aggregate \{score=2, complexity=2\}/);
  assert.match(liveLog, /exp-0001 NEW LEADER: baseline \(score=1\) -> exp-0001 \(score=2\)/);
  assert.match(liveLog, /exp-0002 NEW BEST-OBSERVED: exp-0001 \(score=2\) -> exp-0002 \(score=2\.05\)/);
  assert.match(liveLog, /exp-0002 MEMORY: stored fact-exp-0002/);
  assert.match(liveLog, /exp-0001 EFFICIENCY: .*agent cost=\$0\.02.*cost\/\+1%=\$0\.0002/);
  assert.deepEqual(snapshots, ["running:0", "running:1", "running:2", "completed:2"]);
});

test("harness requires canonical and paired fresh-seed comparisons to agree before promotion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-paired-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "model.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const model = JSON.parse(await readFile("model.json", "utf8"));
const seed = Number(process.env.AUTORESEARCH_SEED);
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: model.value + seed * 0 } }));
`, "utf8");

  const config: HarnessConfig = {
    version: 2,
    name: "paired-test",
    project: { sourceDir, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], hiddenPaths: [], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 2, seeds: [1, 2], inheritEnv: ["PATH"], env: {},
      agentRequests: { allowPairedComparison: true, maxSeeds: 3 },
      statistics: { enabled: true, confidenceLevel: 0.95, equivalenceMargin: 0.1, minimumSeeds: 2, maximumSeeds: 2, seedStep: 1 },
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.5, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 1, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 2, maxBranchDepth: 2, maxTemporaryRegressionRatio: 0.1, recentExperiments: 10, maxContextLessons: 10,
      supportThreshold: 2, contradictionThreshold: 1, maxFrontierPerCategory: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 }, humanLessons: [],
    },
    outputDir: path.join(sourceDir, "runs"),
    researchInstructions: "paired confirmation",
  };
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      await writeFile(path.join(workspacePath, "model.json"), "{\"value\":2}\n", "utf8");
      return {
        narrative: "Confirm value 2",
        plan: {
          hypothesis: "Value 2 improves score on canonical and fresh seeds",
          changeCategory: "other",
          expectedEffect: "higher score",
          notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
          evaluationRequest: { mode: "paired", seeds: [11, 13], rationale: "Independent confirmation" },
        },
      };
    },
  });
  const progress: string[] = [];
  const state = await new AutoresearchHarness(config, factory).run({
    configPath: path.join(root, "config.json"),
    onProgress: (message) => progress.push(message),
  });
  const experiment = state.experiments[0]!;
  assert.equal(experiment.decision.status, "promote");
  assert.deepEqual(experiment.evaluation.attempts.map((attempt) => attempt.seed), [1, 2]);
  assert.deepEqual(experiment.pairedEvaluation?.candidate.attempts.map((attempt) => attempt.seed), [11, 13]);
  assert.deepEqual(experiment.pairedEvaluation?.reference.attempts.map((attempt) => attempt.seed), [11, 13]);
  assert.equal(experiment.pairedEvaluation?.decision.status, "promote");
  assert.equal(experiment.pairedEvaluation?.candidate.statisticalComparison?.status, "improvement");
  assert.equal(experiment.pairedEvaluation?.decision.statisticalStatus, "improvement");
  assert.equal(state.researchGraph?.leaderId, "exp-0001");
  assert.match(progress.join("\n"), /PAIRED CHECK: promote/);
  assert.match(await readFile(path.join(state.runDir, "REPORT.md"), "utf8"), /Fresh-seed confirmation/);
});

test("harness consolidates agent notes and promotes repeated evidence to a supported lesson", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-learning-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "model.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const model = JSON.parse(await readFile("model.json", "utf8"));
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: model.value } }));
`, "utf8");

  const config: HarnessConfig = {
    version: 2,
    name: "learning-test",
    project: { sourceDir, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 1, seeds: [7], inheritEnv: ["PATH"], env: {},
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 2, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 2, maxBranchDepth: 2, maxTemporaryRegressionRatio: 1, recentExperiments: 10, maxContextLessons: 10,
      supportThreshold: 2, contradictionThreshold: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 },
      humanLessons: [],
    },
    outputDir: path.join(sourceDir, "runs"),
    researchInstructions: "test learning",
  };

  let iteration = 0;
  const receivedContexts: ResearchContext[] = [];
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose(context) {
      receivedContexts.push(context);
      iteration += 1;
      await writeFile(path.join(workspacePath, "model.json"), `${JSON.stringify({ value: iteration + 1 })}\n`, "utf8");
      return {
        narrative: `Try value ${iteration + 1}`,
        plan: {
          hypothesis: `Value ${iteration + 1} improves score`,
          changeCategory: "value",
          expectedEffect: "higher score",
          notes: [`Proposal observation ${iteration}`],
          lessonsUsed: [],
          contradictedLessons: [],
          lessonTests: iteration > 1 ? ["lesson-0001"] : [],
          questionsAddressed: iteration > 1 ? ["question-0001"] : [],
        },
      };
    },
    async reflect() {
      return {
        narrative: `Iteration ${iteration} supports increasing value.`,
        summary: "Increasing value improved score.",
        notes: [`Observed a monotonic gain in iteration ${iteration}.`],
        lessonUpdates: [{
          ...(iteration > 1 ? { lessonId: "lesson-0001" } : {}),
          claim: "Increasing value improves score in this evaluator.",
          relation: iteration > 1 ? "supports" : "new",
          guidance: "consider",
          confidence: 0.9,
          evidenceKind: "direct",
          evidenceRationale: "The value change directly tests the monotonic claim.",
        }],
        questionUpdates: iteration > 1
          ? [{ questionId: "question-0001", status: "resolved", resolution: "The second experiment tested continuation of the gain." }]
          : [],
        nextHypotheses: ["Test whether the gain continues."],
      };
    },
  });

  const state = await new AutoresearchHarness(config, factory).run({ configPath: path.join(root, "config.json") });
  assert.equal(state.researchMemory?.facts.length, 3);
  assert.equal(state.researchMemory?.notes.length, 6);
  assert.equal(state.researchMemory?.lessons[0]?.status, "supported");
  assert.deepEqual(state.researchMemory?.lessons[0]?.evidenceFor, ["exp-0001", "exp-0002"]);
  assert.equal(state.researchMemory?.questions[0]?.status, "resolved");
  assert.equal(state.researchGraph?.leaderId, "exp-0002");
  assert.equal(receivedContexts[1]?.memory.facts.length, 2);
  assert.deepEqual(receivedContexts[1]?.memory.notes.map((note) => note.phase), ["proposal", "conclusion", "conclusion"]);
  assert.equal(receivedContexts[1]?.memory.lessons[0]?.status, "tentative");
  assert.match(receivedContexts[1]?.previousExperiments[0]?.conclusion ?? "", /Increasing value/);

  const persisted = JSON.parse(await readFile(path.join(state.runDir, "research-memory.json"), "utf8"));
  assert.equal(persisted.facts.length, 3);
  assert.equal(persisted.notes.length, 6);
  assert.equal(persisted.lessons[0].status, "supported");
  assert.match(await readFile(path.join(state.runDir, "RESEARCH_MEMORY.md"), "utf8"), /agent interpretation/);
});

test("harness skips an already evaluated workspace instead of spending evaluator budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-dedup-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "model.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const model = JSON.parse(await readFile("model.json", "utf8"));
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: model.value } }));
`, "utf8");
  const config: HarnessConfig = {
    version: 2,
    name: "dedup-test",
    project: { sourceDir, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 1, seeds: [1], inheritEnv: ["PATH"], env: {},
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 2, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 2, maxBranchDepth: 2, maxTemporaryRegressionRatio: 1, recentExperiments: 10, maxContextLessons: 10,
      supportThreshold: 2, contradictionThreshold: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 }, humanLessons: [],
    },
    outputDir: path.join(sourceDir, "runs"),
    researchInstructions: "test deduplication",
  };
  let iteration = 0;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      iteration += 1;
      const value = iteration === 1 ? 2 : 1;
      await writeFile(path.join(workspacePath, "model.json"), `${JSON.stringify({ value })}\n`, "utf8");
      return {
        narrative: `Candidate ${iteration}`,
        plan: { hypothesis: `Unique hypothesis ${iteration}`, changeCategory: "other", expectedEffect: "test", notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [] },
      };
    },
  });

  const state = await new AutoresearchHarness(config, factory).run({ configPath: path.join(root, "config.json") });
  assert.equal(state.experiments[1]?.decision.status, "discard");
  assert.equal(state.experiments[1]?.duplicateOf, "baseline");
  assert.equal(state.experiments[1]?.evaluation.skipped, true);
  assert.equal(state.experiments[1]?.evaluation.attempts.length, 0);
  assert.equal(state.researchMemory?.facts[2]?.kind, "duplicate");
});

test("harness can cross a temporary regression and promote a deeper branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-valley-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "model.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const model = JSON.parse(await readFile("model.json", "utf8"));
const scores = { 1: 10, 2: 9.5, 3: 12 };
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: scores[model.value] } }));
`, "utf8");
  const config: HarnessConfig = {
    version: 2,
    name: "valley-test",
    project: { sourceDir, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 1, seeds: [1], inheritEnv: ["PATH"], env: {},
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 2, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 2, maxBranchDepth: 2, maxTemporaryRegressionRatio: 0.1, recentExperiments: 10, maxContextLessons: 10,
      supportThreshold: 2, contradictionThreshold: 1,
      strategy: { explorationRate: 1, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 }, humanLessons: [],
    },
    outputDir: path.join(sourceDir, "runs"),
    researchInstructions: "cross the valley",
  };
  let value = 1;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      value += 1;
      await writeFile(path.join(workspacePath, "model.json"), `${JSON.stringify({ value })}\n`, "utf8");
      return {
        narrative: `Try value ${value}`,
        plan: { hypothesis: `Value ${value} tests the alternative path`, changeCategory: "model-architecture", expectedEffect: "eventual gain", notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [] },
      };
    },
  });

  const state = await new AutoresearchHarness(config, factory).run({ configPath: path.join(root, "config.json") });
  assert.deepEqual(state.experiments.map((experiment) => experiment.decision.status), ["retain", "promote"]);
  assert.equal(state.experiments[1]?.parentId, "exp-0001");
  assert.equal(state.researchGraph?.leaderId, "exp-0002");
  assert.equal(state.acceptedMetrics.score, 12);
});

test("replication evaluates an unchanged checkpoint without changing graph topology", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-replicate-"));
  const sourceDir = path.join(root, "project");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "model.json"), "{\"value\":1}\n", "utf8");
  await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const model = JSON.parse(await readFile("model.json", "utf8"));
await writeFile(process.env.AUTORESEARCH_METRICS_PATH, JSON.stringify({ metrics: { score: model.value } }));
`, "utf8");
  const config: HarnessConfig = {
    version: 2,
    name: "replicate-test",
    project: { sourceDir, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 10, repetitions: 1, seeds: [1], inheritEnv: ["PATH"], env: {},
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 2, maxWallTimeMinutes: 0, maxConsecutiveFailures: 2 },
    learning: {
      beamWidth: 2, maxBranchDepth: 2, maxTemporaryRegressionRatio: 0.1, recentExperiments: 10, maxContextLessons: 10,
      supportThreshold: 2, contradictionThreshold: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 1, falsificationRate: 0 }, humanLessons: [],
    },
    outputDir: path.join(sourceDir, "runs"),
    researchInstructions: "replicate",
  };
  let iteration = 0;
  const factory: ResearcherFactory = async (workspacePath) => ({
    async propose() {
      iteration += 1;
      if (iteration === 1) await writeFile(path.join(workspacePath, "model.json"), "{\"value\":2}\n", "utf8");
      return {
        narrative: iteration === 1 ? "Improve" : "Replicate without changes",
        plan: { hypothesis: `Iteration ${iteration}`, changeCategory: "evaluation", expectedEffect: "measure stability", notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [] },
      };
    },
  });

  const state = await new AutoresearchHarness(config, factory).run({ configPath: path.join(root, "config.json") });
  assert.equal(state.experiments[1]?.strategy, "replicate");
  assert.equal(state.experiments[1]?.evaluation.ok, true);
  assert.equal(state.experiments[1]?.decision.status, "retain");
  assert.equal(state.researchGraph?.leaderId, "exp-0001");
  assert.equal(state.researchGraph?.nodes.some((node) => node.id === "exp-0002"), false);
});
