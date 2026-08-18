import assert from "node:assert/strict";
import { test } from "bun:test";
import { allocateResourceLeases } from "../src/resource-scheduler.js";
import { selectSurrogateSuggestion } from "../src/surrogate-search.js";
import { refreshLearnedCampaignPriorities } from "../src/learned-acquisition.js";
import { claimRelatedCampaignTicket, createResearchCampaign, enqueueCampaignTicket, enqueueEnsembleCandidate, enqueueSliceDiscoveries } from "../src/research-campaign.js";
import type { ExperimentRecord, HarnessConfig, ResearchGraph } from "../src/types.js";

const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };

function config(): HarnessConfig {
  return {
    version: 2,
    name: "optimization-test",
    project: { sourceDir: ".", mutablePaths: ["config.json"], protectedPaths: [], hiddenPaths: [], copyIgnore: [] },
    agent: { thinkingLevel: "off" },
    evaluator: {
      command: ["true"], timeoutSeconds: 1, repetitions: 1, seeds: [1], inheritEnv: [], env: {},
      runner: { mode: "local", network: "none", readOnlyRoot: true, pidsLimit: 8 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.01, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 10, maxWallTimeMinutes: 0, maxConsecutiveFailures: 3 },
    learning: {
      beamWidth: 3, maxBranchDepth: 3, maxTemporaryRegressionRatio: 1, recentExperiments: 5, maxContextLessons: 5,
      supportThreshold: 2, contradictionThreshold: 1, maxFrontierPerCategory: 2,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 },
      humanLessons: [],
      campaign: { enabled: true, queueRate: 1, maxQueued: 20, hypothesesPerProposal: 2, autoAblations: true, maxAblationsPerPromotion: 2, autoMerge: true },
      acquisition: { enabled: true, minimumObservations: 2, explorationFloor: 0.1 },
      ensemble: { enabled: true, minimumMembers: 2, maximumMembers: 3, interval: 2 },
      sliceDiscovery: { enabled: true, minimumSamples: 10, maximumTickets: 2, regressionThreshold: 0.1 },
    },
    search: {
      enabled: true, seed: 7, exploitationRatio: 0,
      parameters: [{ name: "depth", file: "config.json", path: "depth", type: "integer", min: 1, max: 10 }],
      surrogate: { enabled: true, minimumObservations: 2, candidatePoolSize: 16, explorationWeight: 0.2 },
    },
    execution: {
      experimentConcurrency: 2, resourceSlots: [],
      resources: [
        { id: "cpu", cpu: 4, memoryGb: 8, gpu: 0, vramGb: 0, maxConcurrent: 1 },
        { id: "gpu", cpu: 8, memoryGb: 32, gpu: 1, vramGb: 24, maxConcurrent: 1 },
      ],
    },
    outputDir: "runs", researchInstructions: "test",
  };
}

function experiment(id: string, depth: number, improvement: number, durationMs = 1_000): ExperimentRecord {
  return {
    id, index: Number(id.slice(-1)), startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z",
    workspacePath: `/tmp/${id}`, parentId: "baseline", strategy: "optimize", branchDepth: 1,
    plan: {
      hypothesis: "search", changeCategory: "optimization", expectedEffect: "gain", notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
      searchSuggestion: { "config.json:depth": depth },
    },
    changedPaths: ["config.json"], forbiddenChanges: [],
    evaluation: { ok: true, attempts: [], aggregatedMetrics: { score: 1 + improvement } },
    decision: { status: improvement > 0 ? "promote" : "discard", primaryDelta: improvement, reasons: [] },
    accounting: { durationMs, evaluatorDurationMs: durationMs, agentUsage: usage, primaryImprovement: improvement, relativePrimaryImprovement: improvement, costPerImprovementUsd: null, timePerImprovementMs: null },
  };
}

test("resource scheduler honors declared GPU requirements", () => {
  const leases = allocateResourceLeases(config(), [{ gpu: 1, vramGb: 16 }, { cpu: 2 }]);
  assert.equal(leases[0]?.resource.id, "gpu");
  assert.equal(leases[1]?.resource.id, "cpu");
});

test("surrogate search returns an unseen cost-aware suggestion", () => {
  const suggestion = selectSurrogateSuggestion(config(), [experiment("exp-0001", 2, 0.1), experiment("exp-0002", 8, -0.1)], 3);
  assert.ok(suggestion);
  assert.notEqual(suggestion?.["config.json:depth"], undefined);
  assert.ok(![2, 8].includes(suggestion?.["config.json:depth"] as number));
});

test("learned acquisition reprioritizes campaign tickets from outcomes", () => {
  const cfg = config();
  const campaign = createResearchCampaign("goal", "run");
  const ticket = enqueueCampaignTicket(campaign, { kind: "search", hypothesis: "search next", createdBy: "harness" }, cfg);
  const declared = ticket.priority;
  refreshLearnedCampaignPriorities(campaign, [experiment("exp-0001", 2, 0.1, 500), experiment("exp-0002", 3, 0.2, 500)], cfg);
  assert.ok(ticket.learnedPriority !== undefined);
  assert.ok(ticket.priority > declared);
  assert.equal(ticket.predictedDurationMs, 500);
});

test("campaign semantically claims related queued work selected outside the queue", () => {
  const cfg = config();
  const campaign = createResearchCampaign("goal", "run");
  const ticket = enqueueCampaignTicket(campaign, {
    kind: "hypothesis",
    hypothesis: "Use train only pooled state residual with fold agreement shrinkage",
    createdBy: "harness",
  }, cfg);
  const claimed = claimRelatedCampaignTicket(
    campaign,
    "exp-0007",
    "Test a train only pooled state residual using fold agreement shrinkage",
    0.6,
  );
  assert.equal(claimed?.id, ticket.id);
  assert.equal(ticket.status, "running");
  assert.equal(ticket.claimedBy, "exp-0007");
});

test("campaign creates ensemble and weak-slice tickets", () => {
  const cfg = config();
  const experiments = [experiment("exp-0001", 2, 0.1), experiment("exp-0002", 3, 0.2)];
  experiments[1]!.evaluation.attempts = [{
    repetition: 0, seed: 1, exitCode: 0, signal: null, timedOut: false, durationMs: 1,
    metrics: { score: 1.2 }, metadata: { sliceMetrics: [{ name: "rare", count: 12, metrics: { score: 0.8 } }] },
    stdoutPath: "", stderrPath: "", metricsPath: "",
  }, {
    repetition: 1, seed: 2, exitCode: 0, signal: null, timedOut: false, durationMs: 1,
    metrics: { score: 1.2 }, metadata: { sliceMetrics: [{ name: "rare", count: 12, metrics: { score: 0.9 } }] },
    stdoutPath: "", stderrPath: "", metricsPath: "",
  }];
  const graph: ResearchGraph = {
    schemaVersion: 3, leaderId: "exp-0002", frontierIds: ["exp-0001"], paretoFrontierIds: ["exp-0001", "exp-0002"],
    nodes: experiments.map((entry) => ({
      id: entry.id, workspacePath: entry.workspacePath, workspaceFingerprint: entry.id, metrics: entry.evaluation.aggregatedMetrics,
      parentId: "baseline", branchDepth: 1, strategy: "optimize", changeCategory: "optimization", status: "frontier", selectedCount: 0, createdAt: entry.finishedAt,
    })),
  };
  const campaign = createResearchCampaign("goal", "run");
  assert.equal(enqueueEnsembleCandidate(campaign, graph, experiments, cfg)?.kind, "ensemble");
  const sliceTickets = enqueueSliceDiscoveries(campaign, experiments[1]!, cfg);
  assert.equal(sliceTickets[0]?.kind, "slice");
  assert.equal(sliceTickets.length, 1);
});
