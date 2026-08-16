import assert from "node:assert/strict";
import { test } from "bun:test";
import { createResearchCampaign, enqueueMergeCandidate } from "../src/research-campaign.js";
import { applyGraphDecision, chooseResearchAssignment, createResearchGraph } from "../src/research-strategy.js";
import type { HarnessConfig, ResearchNode, RunState } from "../src/types.js";

const config = {
  metrics: {
    primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" },
    objectives: [{ name: "cost", direction: "minimize", aggregation: "mean", weight: 1 }],
    pareto: { enabled: true },
  },
  learning: {
    beamWidth: 1,
    maxBranchDepth: 6,
    maxTemporaryRegressionRatio: 1,
    maxFrontierPerCategory: 1,
    campaign: { enabled: true, queueRate: 1, maxQueued: 10, hypothesesPerProposal: 1, autoAblations: false, maxAblationsPerPromotion: 1, autoMerge: true },
    strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0, optimizeRate: 0, mergeRate: 0, ablationRate: 0 },
    humanLessons: [],
  },
} as HarnessConfig;

function node(id: string, parentId: string | undefined, branchDepth: number, score = 1, cost = 1): ResearchNode {
  return {
    id,
    ...(parentId ? { parentId } : {}),
    workspacePath: `/${id}`,
    workspaceFingerprint: id,
    metrics: { score, cost },
    branchDepth,
    status: id === "baseline" ? "leader" : "frontier",
    wasLeader: id === "baseline",
    strategy: id === "baseline" ? "exploit" : "explore",
    changeCategory: id === "baseline" ? "baseline" : "other",
    selectedCount: 0,
  };
}

function experiment(id: string, parentId: string, changedPaths: string[], branchDepth = 1) {
  return {
    id,
    index: Number(id.slice(-1)),
    startedAt: "now",
    finishedAt: "now",
    workspacePath: `/${id}`,
    parentId,
    strategy: "explore" as const,
    branchDepth,
    changedPaths,
    forbiddenChanges: [],
    evaluation: { ok: true, attempts: [], aggregatedMetrics: { score: 1, cost: 1 } },
    decision: { status: "retain" as const, primaryDelta: 0, reasons: [] },
  };
}

test("merge paths include the complete second branch diff from the LCA", () => {
  const graph = {
    schemaVersion: 3 as const,
    leaderId: "baseline",
    frontierIds: ["branch-b", "branch-c"],
    paretoFrontierIds: ["baseline"],
    nodes: [node("baseline", undefined, 0), node("branch-a", "baseline", 1), node("branch-b", "baseline", 1), node("branch-c", "branch-a", 2)],
  };
  const experiments = [
    experiment("branch-a", "baseline", ["a.json"]),
    experiment("branch-b", "baseline", ["b.json"]),
    experiment("branch-c", "branch-a", ["c.json"], 2),
  ];
  const campaign = createResearchCampaign("merge", "run");
  const ticket = enqueueMergeCandidate(campaign, graph, experiments, config);
  assert.deepEqual(ticket?.merge, { sourceExperimentIds: ["branch-b", "branch-c"], pathsFromSecond: ["a.json", "c.json"] });
});

test("merge assignment depth accounts for both source branches", () => {
  const graph = {
    schemaVersion: 3 as const,
    leaderId: "baseline",
    frontierIds: ["branch-b", "branch-c"],
    paretoFrontierIds: ["baseline"],
    nodes: [node("baseline", undefined, 0), node("branch-b", "baseline", 1), node("branch-c", "baseline", 4)],
  };
  const experiments = [experiment("branch-b", "baseline", ["b.json"]), experiment("branch-c", "baseline", ["c.json"], 4)];
  const campaign = createResearchCampaign("merge", "run");
  const ticket = enqueueMergeCandidate(campaign, graph, experiments, config);
  const state = {
    researchGraph: graph,
    researchMemory: { schemaVersion: 3, updatedAt: "now", facts: [], notes: [], lessons: [], questions: [], evidenceReviews: [] },
    campaign,
    experiments,
  } as unknown as RunState;
  const assignment = chooseResearchAssignment(state, config);
  assert.equal(assignment.ticketId, ticket?.id);
  assert.equal(assignment.branchDepth, 5);
});

test("Pareto-retained checkpoints survive the primary beam and remain reachable", () => {
  const graph = createResearchGraph("/baseline", "baseline", { score: 10, cost: 10 });
  const paretoNode = node("exp-pareto", "baseline", 1, 9, 1);
  applyGraphDecision(graph, paretoNode, { status: "retain", primaryDelta: -1, reasons: [], paretoOptimal: true }, config, config.metrics.primary);
  assert.deepEqual(graph.frontierIds, ["exp-pareto"]);
  assert.ok(graph.paretoFrontierIds.includes("exp-pareto"));

  const newLeader = node("exp-leader", "baseline", 1, 11, 11);
  applyGraphDecision(graph, newLeader, { status: "promote", primaryDelta: 1, reasons: [] }, config, config.metrics.primary);
  assert.ok(graph.frontierIds.includes("exp-pareto"));
  assert.equal(graph.nodes.find((candidate) => candidate.id === "exp-pareto")?.status, "frontier");
});
