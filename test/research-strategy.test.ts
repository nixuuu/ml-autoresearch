import assert from "node:assert/strict";
import { test } from "bun:test";
import { applyGraphDecision, chooseResearchAssignment, createResearchGraph } from "../src/research-strategy.js";
import type { HarnessConfig, ResearchNode, RunState } from "../src/types.js";

test("backtrack strategy selects an older retained checkpoint instead of the leader", () => {
  const config = {
    learning: {
      beamWidth: 2,
      maxBranchDepth: 3,
      maxTemporaryRegressionRatio: 0.5,
      maxFrontierPerCategory: 1,
      strategy: { explorationRate: 0, backtrackRate: 1, replicationRate: 0, falsificationRate: 0 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" } },
  } as HarnessConfig;
  const graph = createResearchGraph("/baseline", "base", { score: 1 });
  const promoted: ResearchNode = {
    id: "exp-0001", parentId: "baseline", workspacePath: "/leader", workspaceFingerprint: "leader", metrics: { score: 2 },
    branchDepth: 1, status: "frontier", wasLeader: false, strategy: "exploit", changeCategory: "model-architecture", selectedCount: 0,
  };
  applyGraphDecision(graph, promoted, { status: "promote", primaryDelta: 1, reasons: [] }, config, config.metrics.primary);
  const state = {
    researchGraph: graph,
    researchMemory: { schemaVersion: 3, updatedAt: "now", facts: [], notes: [], lessons: [], questions: [], evidenceReviews: [] },
    experiments: [{ strategy: "exploit" }],
  } as unknown as RunState;

  const assignment = chooseResearchAssignment(state, config);
  assert.equal(assignment.strategy, "backtrack");
  assert.equal(assignment.parentId, "baseline");
  assert.match(assignment.reason, /Backtrack/);
});

test("falsification strategy targets a supported lesson", () => {
  const config = {
    learning: {
      beamWidth: 2, maxBranchDepth: 3, maxTemporaryRegressionRatio: 0.5, maxFrontierPerCategory: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 1 },
    },
  } as HarnessConfig;
  const state = {
    researchGraph: createResearchGraph("/baseline", "base", { score: 1 }),
    researchMemory: {
      schemaVersion: 3, updatedAt: "now", facts: [], notes: [], questions: [], evidenceReviews: [],
      lessons: [{
        id: "lesson-0001", claim: "Depth helps", normalizedClaim: "depth helps", status: "supported", guidance: "verify", confidence: 0.8,
        evidenceFor: ["exp-a", "exp-b"], evidenceAgainst: [], createdAt: "now", updatedAt: "now",
      }],
    },
    experiments: [{ strategy: "exploit" }],
  } as unknown as RunState;

  const assignment = chooseResearchAssignment(state, config);
  assert.equal(assignment.strategy, "falsify");
  assert.equal(assignment.targetLessonId, "lesson-0001");
});

test("frontier enforces a per-category cap while keeping different research families", () => {
  const config = {
    learning: {
      beamWidth: 3, maxFrontierPerCategory: 1, maxBranchDepth: 3, maxTemporaryRegressionRatio: 0.5,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 1, aggregation: "mean" } },
  } as HarnessConfig;
  const graph = createResearchGraph("/baseline", "base", { score: 10 });
  const node = (id: string, score: number, changeCategory: ResearchNode["changeCategory"]): ResearchNode => ({
    id, parentId: "baseline", workspacePath: `/${id}`, workspaceFingerprint: id, metrics: { score },
    branchDepth: 1, status: "frontier", wasLeader: false, strategy: "explore", changeCategory, selectedCount: 0,
  });
  applyGraphDecision(graph, node("exp-0001", 9.8, "regularization"), { status: "retain", primaryDelta: -0.2, reasons: [] }, config, config.metrics.primary);
  applyGraphDecision(graph, node("exp-0002", 9.9, "regularization"), { status: "retain", primaryDelta: -0.1, reasons: [] }, config, config.metrics.primary);
  applyGraphDecision(graph, node("exp-0003", 9.7, "model-architecture"), { status: "retain", primaryDelta: -0.3, reasons: [] }, config, config.metrics.primary);
  assert.deepEqual(graph.frontierIds, ["exp-0002", "exp-0003"]);
  assert.equal(graph.nodes.find((candidate) => candidate.id === "exp-0001")?.status, "retired");
});

test("optimizer selects a checkpoint that declares the required parameter capability", () => {
  const config = {
    search: {
      enabled: true, seed: 1, exploitationRatio: 1,
      parameters: [{ name: "weight", file: "candidate.json", path: "weight", type: "float", min: 0, max: 1, requiresCapability: "weighted-model" }],
    },
    learning: {
      beamWidth: 2, maxBranchDepth: 3, maxTemporaryRegressionRatio: 1, maxFrontierPerCategory: 2,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0, optimizeRate: 1, mergeRate: 0, ablationRate: 0 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" } },
  } as HarnessConfig;
  const graph = createResearchGraph("/baseline", "base", { score: 2 });
  graph.nodes.push({
    id: "exp-0001", parentId: "baseline", workspacePath: "/compatible", workspaceFingerprint: "compatible", metrics: { score: 1.9 },
    branchDepth: 1, status: "frontier", wasLeader: false, strategy: "explore", changeCategory: "model-architecture", selectedCount: 0,
  });
  graph.frontierIds = ["exp-0001"];
  const state = {
    baseline: { ok: true, attempts: [], aggregatedMetrics: { score: 2 }, semantic: { predictionHashes: {}, candidateCapabilities: [], consumedSearchParameters: [], reportedCandidateCapabilities: true, reportedConsumedSearchParameters: false } },
    researchGraph: graph,
    researchMemory: { schemaVersion: 3, updatedAt: "now", facts: [], notes: [], lessons: [], questions: [{ id: "question-0001", text: "Unrelated question", normalizedText: "unrelated question", status: "open", createdBy: "test", createdAt: "now", updatedAt: "now" }], evidenceReviews: [] },
    experiments: [{
      id: "exp-0001", strategy: "explore",
      evaluation: { ok: true, attempts: [], aggregatedMetrics: { score: 1.9 }, semantic: { predictionHashes: {}, candidateCapabilities: ["weighted-model"], consumedSearchParameters: [], reportedCandidateCapabilities: true, reportedConsumedSearchParameters: false } },
    }],
  } as unknown as RunState;
  const assignment = chooseResearchAssignment(state, config);
  assert.equal(assignment.strategy, "optimize");
  assert.equal(assignment.parentId, "exp-0001");
  assert.equal(assignment.targetQuestionId, undefined);
  assert.match(assignment.reason, /capability-compatible checkpoint exp-0001/);
});
