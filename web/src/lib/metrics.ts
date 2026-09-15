import type { Direction, MetricFormat, RunState } from "$lib/types";

export interface DisplayMetric {
  name: string;
  label: string;
  format: MetricFormat;
  direction?: Direction;
}

export function dashboardMetrics(run: RunState): DisplayMetric[] {
  const policies = new Map([...(run.guardrails ?? []), ...(run.objectives ?? []), ...(run.primaryMetric ? [run.primaryMetric] : [])]
    .map((metric) => [metric.name, metric]));
  const configured = run.dashboard?.metrics ?? (run.primaryMetric ? [{ name: run.primaryMetric.name }] : []);
  return configured.map((metric) => {
    const policy = policies.get(metric.name);
    return { name: metric.name, label: metric.label ?? metric.name,
      format: metric.format ?? policy?.format ?? "number",
      ...(policy?.direction ? { direction: policy.direction } : {}) };
  });
}

export function checkpointMetric(run: RunState, id: string, name: string): number | undefined {
  if (id === "baseline") return run.baseline.aggregatedMetrics[name];
  return run.experiments.find((experiment) => experiment.id === id)?.evaluation.aggregatedMetrics[name]
    ?? run.researchGraph?.nodes.find((node) => node.id === id)?.metrics[name];
}

/** Positive means better for this metric, independently of the promotion metric. */
export function metricImprovement(before: number | undefined, after: number | undefined, direction?: Direction): number | null {
  if (before === undefined || after === undefined || !Number.isFinite(before) || !Number.isFinite(after) || !direction) return null;
  return direction === "minimize" ? before - after : after - before;
}
