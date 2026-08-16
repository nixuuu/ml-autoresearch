import assert from "node:assert/strict";
import { test } from "bun:test";
import { formatConfidence, formatMetric, formatMetricDelta, relativeImprovement, signedMetric } from "../web/src/lib/format.js";

test("percentage metrics distinguish values, percentage points, and relative improvement", () => {
  assert.equal(formatMetric(0.347015, "percentage"), "34.7015%");
  assert.equal(signedMetric(0.00611845, "percentage"), "+0.611845 pp");
  assert.equal(signedMetric(-0.002, "percentage"), "-0.2 pp");
  assert.equal(formatMetricDelta(0.002, "percentage"), "0.2 pp");
  assert.ok(Math.abs((relativeImprovement(0.4, 0.42, "maximize") ?? 0) - 0.05) < Number.EPSILON);
  assert.equal(formatConfidence({ lower: 0.39, upper: 0.43 }, 0.95, "percentage"), "[39%, 43%] @ 95%");
});

test("number metrics preserve existing numeric presentation", () => {
  assert.equal(formatMetric(0.347015), "0.347015");
  assert.equal(signedMetric(0.00611845), "+0.00611845");
});
