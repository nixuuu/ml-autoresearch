import type { DecisionStatus, Direction } from "$lib/types";

export function formatMetric(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 0.0001 || absolute >= 10_000)) return value.toExponential(4);
  return Number(value.toPrecision(6)).toString();
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

export function improvementClass(delta: number | null | undefined): "improvement" | "regression" | "neutral" {
  if (delta === null || delta === undefined || delta === 0) return "neutral";
  return delta > 0 ? "improvement" : "regression";
}

export function signedMetric(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return "—";
  return `${delta > 0 ? "+" : ""}${formatMetric(delta)}`;
}

export function statusTone(status: DecisionStatus | "baseline"): string {
  if (status === "promote" || status === "keep") return "improvement";
  if (status === "discard" || status === "reject" || status === "failure") return "regression";
  return status === "retain" ? "warning" : "neutral";
}

export function relativeImprovement(baseline: number, current: number, direction: Direction): number | null {
  if (!Number.isFinite(baseline) || !Number.isFinite(current) || baseline === 0) return null;
  const gain = direction === "minimize" ? baseline - current : current - baseline;
  return gain / Math.abs(baseline);
}
