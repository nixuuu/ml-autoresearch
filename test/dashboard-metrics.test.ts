import assert from "node:assert/strict";
import { test } from "bun:test";
import { checkpointMetric, dashboardMetrics, metricImprovement } from "../web/src/lib/metrics.js";
import type { RunState } from "../web/src/lib/types.js";

test("secondary metrics compare their own values against the actual parent and respect direction", () => {
  const run = {
    primaryMetric: { name: "loss", direction: "minimize", format: "number" },
    guardrails: [{ name: "coverage", direction: "maximize", format: "percentage" }],
    dashboard: { metrics: [{ name: "loss", label: "Relative loss", format: "percentage" }, { name: "coverage" }, { name: "diagnostic" }] },
    baseline: { aggregatedMetrics: { loss: 0.2, coverage: 0.5 } }, acceptedMetrics: { loss: 0.1, coverage: 0.6 },
    experiments: [{ id: "exp-0001", parentId: "baseline", evaluation: { aggregatedMetrics: { loss: 0.1, coverage: 0.6 } }, decision: { primaryDelta: 0.1 } }],
  } as unknown as RunState;
  const metrics = dashboardMetrics(run);
  assert.equal(metrics[0]?.format, "percentage");
  assert.equal(metrics[0]?.label, "Relative loss");
  assert.equal(metrics[1]?.direction, "maximize");
  assert.equal(metrics[2]?.direction, undefined);
  assert.equal(checkpointMetric(run, "baseline", "coverage"), 0.5);
  const parent = checkpointMetric(run, "exp-0001", "coverage");
  assert.equal(parent, 0.6);
  assert.ok(metricImprovement(parent, 0.55, metrics[1]?.direction)! < 0);
  assert.ok(metricImprovement(0.1, 0.08, metrics[0]?.direction)! > 0);
  assert.equal(checkpointMetric(run, "missing", "coverage"), undefined);
  assert.equal(metricImprovement(undefined, 0.5, "maximize"), null);
  assert.equal(metricImprovement(0, 0, "minimize"), 0);
  assert.equal(metricImprovement(0.2, Number.NaN, "minimize"), null);
});
