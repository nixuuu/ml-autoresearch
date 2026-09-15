import type { DashboardConfig, DashboardMetricConfig, RunState } from "./types.js";

export function parseDashboardConfig(value: unknown): DashboardConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("dashboard must be an object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.metrics)) throw new Error("dashboard.metrics must be an array");
  const names = new Set<string>();
  const metrics = raw.metrics.map((item, index): DashboardMetricConfig => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`dashboard.metrics[${index}] must be an object`);
    const metric = item as Record<string, unknown>;
    if (typeof metric.name !== "string" || !metric.name.trim()) throw new Error(`dashboard.metrics[${index}].name is required`);
    if (names.has(metric.name)) throw new Error("dashboard.metrics names must be unique");
    names.add(metric.name);
    if (metric.label !== undefined && (typeof metric.label !== "string" || !metric.label.trim())) throw new Error(`dashboard.metrics[${index}].label must be nonempty text`);
    if (metric.format !== undefined && metric.format !== "number" && metric.format !== "percentage") throw new Error(`dashboard.metrics[${index}].format must be number or percentage`);
    return { name: metric.name,
      ...(typeof metric.label === "string" ? { label: metric.label } : {}),
      ...(metric.format !== undefined ? { format: metric.format } : {}) };
  });
  return { metrics };
}

/** Format overrides affect the API view only; raw state and metrics stay intact. */
export function presentDashboardRun(run: RunState | null, dashboard: DashboardConfig | undefined): RunState | null {
  if (!run || !dashboard) return run;
  const formats = new Map(dashboard.metrics.map((metric) => [metric.name, metric.format]));
  const present = <T extends { name: string }>(metric: T): T => {
    const format = formats.get(metric.name);
    return format ? { ...metric, format } : metric;
  };
  return { ...run, dashboard,
    ...(run.primaryMetric ? { primaryMetric: present(run.primaryMetric) } : {}),
    ...(run.guardrails ? { guardrails: run.guardrails.map(present) } : {}),
    ...(run.objectives ? { objectives: run.objectives.map(present) } : {}) };
}
