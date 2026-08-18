import assert from "node:assert/strict";
import { test } from "bun:test";
import { applyResearchMethodUpdates, createResearchMethodState } from "../src/research-methods.js";
import type { ExperimentRecord, ResearchMethodRefinementConfig, ResearchMethodUpdate } from "../src/types.js";

const config: ResearchMethodRefinementConfig = {
  enabled: true,
  minimumEvidence: 2,
  contradictionThreshold: 1,
  maxEntries: 10,
  allowedKinds: ["analysis-recipe", "prompt-note"],
};

function experiment(id: string, update: ResearchMethodUpdate, methodTests: string[] = [], ok = true): ExperimentRecord {
  return {
    id,
    index: Number(id.slice(-1)),
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    workspacePath: `/workspace/${id}`,
    parentId: "baseline",
    strategy: "exploit",
    workspaceFingerprint: id,
    plan: {
      hypothesis: "Test a bounded research procedure",
      changeCategory: "other",
      expectedEffect: "better experiment selection",
      notes: [], lessonsUsed: [], contradictedLessons: [], lessonTests: [], methodTests, questionsAddressed: [],
    },
    conclusion: {
      narrative: "done", summary: "done", notes: [], lessonUpdates: [], methodUpdates: [update], nextHypotheses: [], questionUpdates: [],
    },
    changedPaths: [], forbiddenChanges: [],
    evaluation: { ok, attempts: [], aggregatedMetrics: {}, ...(ok ? {} : { error: "failed" }) },
    decision: { status: ok ? "retain" : "failure", primaryDelta: 0, reasons: [] },
    accounting: {
      durationMs: 1, evaluatorDurationMs: 1,
      agentUsage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 },
      primaryImprovement: null, relativePrimaryImprovement: null, costPerImprovementUsd: null, timePerImprovementMs: null,
    },
  };
}

test("research methods require valid evidence and pre-registration before promotion", () => {
  let state = applyResearchMethodUpdates(createResearchMethodState(), experiment("exp-1", {
    kind: "analysis-recipe", content: "Inspect residual slices before choosing a feature change.", relation: "new", rationale: "Found a useful failure mode.",
  }), config);
  assert.equal(state.entries[0]?.status, "trial");
  const id = state.entries[0]!.id;

  state = applyResearchMethodUpdates(state, experiment("exp-2", {
    methodId: id, kind: "analysis-recipe", content: state.entries[0]!.content, relation: "supports", rationale: "Used again.",
  }), config);
  assert.equal(state.entries[0]?.status, "trial");
  assert.equal(state.reviews.at(-1)?.accepted, false);

  state = applyResearchMethodUpdates(state, experiment("exp-3", {
    methodId: id, kind: "analysis-recipe", content: state.entries[0]!.content, relation: "supports", rationale: "Pre-registered follow-up.",
  }, [id]), config);
  assert.equal(state.entries[0]?.status, "supported");

  state = applyResearchMethodUpdates(state, experiment("exp-4", {
    methodId: id, kind: "analysis-recipe", content: state.entries[0]!.content, relation: "contradicts", rationale: "Pre-registered counterexample.",
  }, [id]), config);
  assert.equal(state.entries[0]?.status, "contradicted");
});

test("research methods reject failed experiments and disallowed policy kinds", () => {
  let state = applyResearchMethodUpdates(undefined, experiment("exp-1", {
    kind: "screening-policy", content: "Change the evaluation threshold.", relation: "new", rationale: "unsafe",
  }), config);
  assert.equal(state.entries.length, 0);
  state = applyResearchMethodUpdates(state, experiment("exp-2", {
    kind: "prompt-note", content: "Ask for one falsifiable hypothesis.", relation: "new", rationale: "no evidence",
  }, [], false), config);
  assert.equal(state.entries.length, 0);
});
