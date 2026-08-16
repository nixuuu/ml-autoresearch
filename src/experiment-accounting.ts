import type { AgentUsage, EvaluationResult, ExperimentAccounting, PairedEvaluationResult } from "./types.js";

export function emptyAgentUsage(): AgentUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export function addAgentUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

function finiteDuration(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function relativePercentEfficiency(input: Pick<ExperimentAccounting, "durationMs" | "agentUsage" | "relativePrimaryImprovement">): {
  costPerImprovementUsd: number | null;
  timePerImprovementMs: number | null;
} {
  const relativePercentagePoints = input.relativePrimaryImprovement === null
    ? null
    : input.relativePrimaryImprovement * 100;
  if (relativePercentagePoints === null || !Number.isFinite(relativePercentagePoints) || relativePercentagePoints <= 0) {
    return { costPerImprovementUsd: null, timePerImprovementMs: null };
  }
  return {
    costPerImprovementUsd: input.agentUsage.costUsd / relativePercentagePoints,
    timePerImprovementMs: input.durationMs / relativePercentagePoints,
  };
}

export function calculateExperimentAccounting(input: {
  startedAt: string;
  finishedAt: string;
  primaryDelta: number | null;
  parentPrimaryValue: number | undefined;
  agentUsage: AgentUsage;
  evaluation: EvaluationResult;
  pairedEvaluation?: PairedEvaluationResult;
}): ExperimentAccounting {
  const startedAtMs = Date.parse(input.startedAt);
  const finishedAtMs = Date.parse(input.finishedAt);
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : 0;
  const evaluatorDurationMs = finiteDuration(input.evaluation.totalDurationMs)
    + finiteDuration(input.pairedEvaluation?.reference.totalDurationMs)
    + finiteDuration(input.pairedEvaluation?.candidate.totalDurationMs);
  const primaryImprovement = input.primaryDelta !== null && Number.isFinite(input.primaryDelta) && input.primaryDelta > 0
    ? input.primaryDelta
    : null;
  const relativePrimaryImprovement = primaryImprovement !== null
    && input.parentPrimaryValue !== undefined
    && Number.isFinite(input.parentPrimaryValue)
    && input.parentPrimaryValue !== 0
    ? primaryImprovement / Math.abs(input.parentPrimaryValue)
    : null;
  const efficiency = relativePercentEfficiency({ durationMs, agentUsage: input.agentUsage, relativePrimaryImprovement });

  return {
    durationMs,
    evaluatorDurationMs,
    agentUsage: input.agentUsage,
    primaryImprovement,
    relativePrimaryImprovement,
    costPerImprovementUsd: efficiency.costPerImprovementUsd,
    timePerImprovementMs: efficiency.timePerImprovementMs,
  };
}
