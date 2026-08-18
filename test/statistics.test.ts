import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  aggregateMetricSamples,
  comparePairedSamples,
  confidenceInterval,
  summarize,
} from "../src/statistics.js";

test("summarize reports sample statistics", () => {
  const summary = summarize([1, 2, 3, 4]);
  assert.equal(summary.n, 4);
  assert.equal(summary.mean, 2.5);
  assert.equal(summary.median, 2.5);
  assert.equal(summary.variance, 5 / 3);
  assert.equal(summary.stddev, Math.sqrt(5 / 3));
  assert.equal(summary.stderr, Math.sqrt(5 / 3) / 2);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 4);
});

test("single-observation summary and interval are well-defined", () => {
  const summary = summarize([7]);
  assert.deepEqual(summary, {
    n: 1,
    mean: 7,
    median: 7,
    variance: 0,
    stddev: 0,
    stderr: 0,
    min: 7,
    max: 7,
  });
  const interval = confidenceInterval([7]);
  assert.equal(interval.lower, 7);
  assert.equal(interval.upper, 7);
  assert.equal(interval.marginOfError, 0);
  assert.equal(interval.method, "degenerate");
});

test("student-t confidence interval is wider for smaller samples", () => {
  const small = confidenceInterval([1, 2, 3]);
  const large = confidenceInterval(Array.from({ length: 30 }, () => 2));
  assert.equal(small.method, "student-t");
  assert.ok(small.criticalValue! > 1.9);
  assert.ok(small.marginOfError > large.marginOfError);
});

test("bootstrap intervals are deterministic for a seed", () => {
  const options = { method: "bootstrap" as const, bootstrapIterations: 500, bootstrapSeed: 42 };
  const first = confidenceInterval([1, 2, 3, 4, 5], options);
  const second = confidenceInterval([1, 2, 3, 4, 5], options);
  assert.deepEqual(first, second);
  assert.equal(first.method, "bootstrap");
  assert.equal(first.criticalValue, null);
});

test("paired minimize comparison detects a clear improvement", () => {
  const result = comparePairedSamples(
    [1, 1.1, 0.9, 1.05],
    [0.7, 0.8, 0.6, 0.75],
    { direction: "minimize", minimumDelta: 0.1, equivalenceMargin: 0.01 },
  );
  assert.equal(result.status, "improvement");
  assert.ok(result.primaryDelta > 0.29);
  assert.ok(result.confidenceInterval.lower > 0.1);
});

test("paired maximize comparison detects a clear regression", () => {
  const result = comparePairedSamples(
    [0.9, 0.91, 0.89, 0.92],
    [0.7, 0.71, 0.69, 0.72],
    { direction: "maximize", minimumDelta: 0.01, equivalenceMargin: 0.01 },
  );
  assert.equal(result.status, "regression");
  assert.ok(result.primaryDelta < -0.19);
  assert.match(result.reason, /regression margin/);
});

test("paired noisy differences inside the practical margin are equivalent", () => {
  const result = comparePairedSamples(
    [1, 1, 1, 1, 1, 1],
    [1.0002, 0.9998, 1.0001, 0.9999, 1.00015, 0.99985],
    { direction: "maximize", minimumDelta: 0.01, equivalenceMargin: 0.001 },
  );
  assert.equal(result.status, "equivalent");
  assert.ok(result.confidenceInterval.lower >= -0.001);
  assert.ok(result.confidenceInterval.upper <= 0.001);
});

test("paired noisy evidence crossing thresholds is inconclusive", () => {
  const result = comparePairedSamples(
    [0, 0, 0, 0],
    [0, 0.2, -0.1, 0.1],
    { direction: "maximize", minimumDelta: 0.05, equivalenceMargin: 0.01 },
  );
  assert.equal(result.status, "inconclusive");
});

test("single paired observation remains inconclusive without independent evidence", () => {
  const result = comparePairedSamples(
    [10],
    [9.5],
    { direction: "minimize", minimumDelta: 0.1, equivalenceMargin: 0.01 },
  );
  assert.equal(result.status, "inconclusive");
  assert.match(result.reason, /At least two independent paired observations/);
  assert.equal(result.n, 1);
  assert.deepEqual(result.differences, [0.5]);
});

test("metrics are aggregated independently with per-metric methods", () => {
  const result = aggregateMetricSamples(
    {
      loss: [3, 1, 2],
      accuracy: [0.8, 0.9, 0.7],
      latency: [20, 10, 30],
    },
    { loss: "median", accuracy: "max", latency: "min" },
  );
  assert.deepEqual(result, { loss: 2, accuracy: 0.9, latency: 10 });
});

test("invalid and mismatched samples fail early", () => {
  assert.throws(() => summarize([]), /at least one observation/);
  assert.throws(() => summarize([1, Number.NaN]), /non-finite/);
  assert.throws(() => comparePairedSamples([1], [1, 2], { direction: "maximize" }), /same length/);
});
