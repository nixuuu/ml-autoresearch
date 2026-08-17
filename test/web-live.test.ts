import assert from "node:assert/strict";
import { test } from "bun:test";
import { applyProgressEvent, normalizeDashboardSnapshot } from "../web/src/lib/live.js";
import type { DashboardSnapshot, LiveProgressEvent } from "../web/src/lib/types.js";

function progress(sequence: number, message: string): LiveProgressEvent {
  return { sequence, message, timestamp: `2026-08-17T00:00:0${sequence}.000Z` };
}

function snapshot(): DashboardSnapshot {
  const experiment = {
    id: "exp-0001",
    index: 1,
    startedAt: "2026-08-17T00:00:00.000Z",
    finishedAt: "2026-08-17T00:00:01.000Z",
    workspacePath: "/tmp/workspace",
    proposalPath: "/tmp/proposal.md",
    conclusionPath: "/tmp/conclusion.md",
    parentId: "baseline",
    strategy: "exploit" as const,
    branchDepth: 1,
    changedPaths: [],
    forbiddenChanges: [],
    evaluation: { ok: true, attempts: [], aggregatedMetrics: { score: 1 } },
    decision: { status: "promote" as const, primaryDelta: 1, reasons: [] },
  };
  const ticket = {
    id: "ticket-0001",
    hypothesis: "test",
    status: "queued" as const,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    dependencies: [],
    expectedGain: 0,
    informationGain: 0,
    estimatedCost: 0,
  };
  return {
    schemaVersion: 2,
    updatedAt: "2026-08-17T00:00:02.000Z",
    phase: progress(2, "latest"),
    progress: [progress(1, "first"), progress(2, "stale"), progress(2, "latest")],
    activeExperiments: [
      { id: "exp-0002", startedAt: "a", latestActivityAt: "a", transcriptEntries: 1 },
      { id: "exp-0002", startedAt: "a", latestActivityAt: "b", transcriptEntries: 2 },
    ],
    run: {
      runId: "run",
      name: "run",
      status: "running",
      startedAt: "2026-08-17T00:00:00.000Z",
      baseline: { ok: true, attempts: [], aggregatedMetrics: { score: 0 } },
      acceptedMetrics: { score: 1 },
      experiments: [experiment, { ...experiment, finishedAt: "2026-08-17T00:00:02.000Z" }],
      campaign: {
        schemaVersion: 1,
        id: "campaign",
        goal: "goal",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:01.000Z",
        tickets: [ticket, { ...ticket, status: "completed" }],
      },
      metaResearch: {
        schemaVersion: 1,
        agentPerformance: [
          { profileId: "default", trials: 1, totalReward: 0, meanReward: 0, promotions: 0, failures: 0 },
          { profileId: "default", trials: 2, totalReward: 1, meanReward: 0.5, promotions: 1, failures: 0 },
        ],
        strategyPerformance: [
          { strategy: "exploit", trials: 1, totalReward: 0, meanReward: 0 },
          { strategy: "exploit", trials: 2, totalReward: 1, meanReward: 0.5 },
        ],
        policyUpdates: [],
      },
    },
  };
}

test("dashboard normalization removes duplicate keyed entities and keeps their freshest value", () => {
  const normalized = normalizeDashboardSnapshot(snapshot());
  assert.deepEqual(normalized.progress.map((event) => event.message), ["first", "latest"]);
  assert.equal(normalized.activeExperiments.length, 1);
  assert.equal(normalized.activeExperiments[0]?.transcriptEntries, 2);
  assert.equal(normalized.run?.experiments.length, 1);
  assert.equal(normalized.run?.experiments[0]?.finishedAt, "2026-08-17T00:00:02.000Z");
  assert.equal(normalized.run?.campaign?.tickets.length, 1);
  assert.equal(normalized.run?.campaign?.tickets[0]?.status, "completed");
  assert.equal(normalized.run?.metaResearch?.agentPerformance[0]?.trials, 2);
  assert.equal(normalized.run?.metaResearch?.strategyPerformance[0]?.trials, 2);
});

test("an SSE progress event replaces the matching snapshot event instead of duplicating its key", () => {
  const initial = normalizeDashboardSnapshot(snapshot());
  const updated = applyProgressEvent(initial, progress(2, "from SSE"));
  assert.deepEqual(updated.progress.map((event) => event.sequence), [1, 2]);
  assert.equal(updated.progress.at(-1)?.message, "from SSE");
  assert.equal(updated.phase?.message, "from SSE");
});
