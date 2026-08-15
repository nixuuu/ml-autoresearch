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
    researchMemory: { schemaVersion: 2, updatedAt: "now", facts: [], notes: [], lessons: [], questions: [], evidenceReviews: [] },
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
      schemaVersion: 2, updatedAt: "now", facts: [], notes: [], questions: [], evidenceReviews: [],
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
