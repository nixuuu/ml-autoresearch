import { describe, expect, test } from "bun:test";
import { calculateExperimentAccounting } from "../src/experiment-accounting";

const usage = {
  requests: 3,
  inputTokens: 1_000,
  outputTokens: 250,
  cacheReadTokens: 500,
  cacheWriteTokens: 100,
  totalTokens: 1_850,
  costUsd: 0.12,
};

describe("experiment accounting", () => {
  test("calculates wall time, evaluator time, and efficiency for a positive improvement", () => {
    const accounting = calculateExperimentAccounting({
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:12.000Z",
      primaryDelta: 0.02,
      parentPrimaryValue: 0.4,
      agentUsage: usage,
      evaluation: { ok: true, attempts: [], aggregatedMetrics: {}, totalDurationMs: 4_000 },
      pairedEvaluation: {
        referenceId: "baseline", seeds: [1], rationale: "confirm",
        reference: { ok: true, attempts: [], aggregatedMetrics: {}, totalDurationMs: 2_000 },
        candidate: { ok: true, attempts: [], aggregatedMetrics: {}, totalDurationMs: 3_000 },
        decision: { status: "promote", primaryDelta: 0.02, reasons: [] },
      },
    });

    expect(accounting.durationMs).toBe(12_000);
    expect(accounting.evaluatorDurationMs).toBe(9_000);
    expect(accounting.agentUsage).toEqual(usage);
    expect(accounting.primaryImprovement).toBe(0.02);
    expect(accounting.relativePrimaryImprovement).toBeCloseTo(0.05);
    expect(accounting.costPerImprovementUsd).toBeCloseTo(6);
    expect(accounting.timePerImprovementMs).toBeCloseTo(600_000);
  });

  test("does not produce misleading ratios for zero, regressive, or missing deltas", () => {
    for (const primaryDelta of [0, -0.1, null]) {
      const accounting = calculateExperimentAccounting({
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        primaryDelta,
        parentPrimaryValue: 1,
        agentUsage: usage,
        evaluation: { ok: false, attempts: [], aggregatedMetrics: {} },
      });
      expect(accounting.primaryImprovement).toBeNull();
      expect(accounting.costPerImprovementUsd).toBeNull();
      expect(accounting.timePerImprovementMs).toBeNull();
    }
  });
});
