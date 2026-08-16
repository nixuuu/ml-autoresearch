import type { CampaignTicket, ComparisonStatus, DecisionStatus, Direction, ExperimentAccounting, MetricFormat, RunStatus } from "$lib/types";

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 0.0001 || absolute >= 10_000)) return value.toExponential(4);
  return Number(value.toPrecision(6)).toString();
}

export function formatMetric(value: number | undefined, format: MetricFormat = "number"): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return format === "percentage" ? `${formatNumber(value * 100)}%` : formatNumber(value);
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

export function formatRateDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 60_000) {
    const seconds = milliseconds / 1_000;
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  return formatDuration(milliseconds);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  const absolute = Math.abs(value);
  if (absolute < 0.0001) return `$${value.toExponential(3)}`;
  return `$${value.toFixed(absolute < 1 ? 4 : 2)}`;
}

export function relativePercentEfficiency(accounting: ExperimentAccounting | null | undefined): {
  costUsd: number | null;
  timeMs: number | null;
} {
  const relativePercentagePoints = accounting?.relativePrimaryImprovement === null
    || accounting?.relativePrimaryImprovement === undefined
    ? null
    : accounting.relativePrimaryImprovement * 100;
  if (!accounting || relativePercentagePoints === null || !Number.isFinite(relativePercentagePoints) || relativePercentagePoints <= 0) {
    return { costUsd: null, timeMs: null };
  }
  return {
    costUsd: accounting.agentUsage.costUsd / relativePercentagePoints,
    timeMs: accounting.durationMs / relativePercentagePoints,
  };
}

export function improvementClass(delta: number | null | undefined): "improvement" | "regression" | "neutral" {
  if (delta === null || delta === undefined || delta === 0) return "neutral";
  return delta > 0 ? "improvement" : "regression";
}

export function formatMetricDelta(delta: number | null | undefined, format: MetricFormat = "number"): string {
  if (delta === null || delta === undefined) return "—";
  return format === "percentage" ? `${formatNumber(delta * 100)} pp` : formatMetric(delta);
}

export function signedMetric(delta: number | null | undefined, format: MetricFormat = "number"): string {
  if (delta === null || delta === undefined) return "—";
  return `${delta > 0 ? "+" : ""}${formatMetricDelta(delta, format)}`;
}

export function statusTone(status: DecisionStatus | "baseline"): string {
  if (status === "promote" || status === "keep") return "improvement";
  if (status === "discard" || status === "reject" || status === "failure" || status === "pruned") return "regression";
  return status === "retain" || status === "inconclusive" ? "warning" : "neutral";
}

export function runStatusTone(status: RunStatus): string {
  if (status === "running" || status === "completed") return "improvement";
  if (status === "failed" || status === "interrupted") return "regression";
  if (status === "paused") return "warning";
  return "neutral";
}

export function campaignStatusTone(status: CampaignTicket["status"]): string {
  if (status === "running") return "improvement";
  if (status === "blocked") return "regression";
  if (status === "queued") return "warning";
  return "neutral";
}

export function comparisonTone(status: ComparisonStatus | undefined): string {
  if (status === "improvement") return "improvement";
  if (status === "regression") return "regression";
  if (status === "inconclusive") return "warning";
  return "neutral";
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatConfidence(interval: { lower: number; upper: number } | undefined, level?: number, format: MetricFormat = "number"): string {
  if (!interval || !Number.isFinite(interval.lower) || !Number.isFinite(interval.upper)) return "—";
  const suffix = level === undefined || !Number.isFinite(level) ? "" : ` @ ${(level * 100).toFixed(0)}%`;
  return `[${formatMetric(interval.lower, format)}, ${formatMetric(interval.upper, format)}]${suffix}`;
}

export function relativeImprovement(baseline: number, current: number, direction: Direction): number | null {
  if (!Number.isFinite(baseline) || !Number.isFinite(current) || baseline === 0) return null;
  const gain = direction === "minimize" ? baseline - current : current - baseline;
  return gain / Math.abs(baseline);
}
