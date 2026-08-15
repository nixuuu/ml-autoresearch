import assert from "node:assert/strict";
import { test } from "bun:test";
import { aggregate, decideCandidate, decideResearchCandidate } from "../src/metrics.js";
import type { EvaluationResult } from "../src/types.js";

test("aggregate computes a median for odd and even series", () => {
  assert.equal(aggregate([3, 1, 2], "median"), 2);
  assert.equal(aggregate([4, 1, 3, 2], "median"), 2.5);
});

test("research decision retains a controlled temporary regression for branch exploration", () => {
  const evaluation: EvaluationResult = { ok: true, attempts: [], aggregatedMetrics: { accuracy: 0.78 } };
  const decision = decideResearchCandidate(
    { accuracy: 0.8 },
    evaluation,
    { name: "accuracy", direction: "maximize", minimumDelta: 0.01, aggregation: "mean" },
    [],
    1,
    3,
    0.05,
  );
  assert.equal(decision.status, "retain");
});

test("research decision discards a branch outside temporary regression budget", () => {
  const evaluation: EvaluationResult = { ok: true, attempts: [], aggregatedMetrics: { accuracy: 0.7 } };
  const decision = decideResearchCandidate(
    { accuracy: 0.8 },
    evaluation,
    { name: "accuracy", direction: "maximize", minimumDelta: 0.01, aggregation: "mean" },
    [],
    1,
    3,
    0.05,
  );
  assert.equal(decision.status, "discard");
});

test("decision keeps a real improvement within guardrails", () => {
  const evaluation: EvaluationResult = { ok: true, attempts: [], aggregatedMetrics: { accuracy: 0.84, latency_ms: 102 } };
  const decision = decideCandidate(
    { accuracy: 0.8, latency_ms: 100 },
    evaluation,
    { name: "accuracy", direction: "maximize", minimumDelta: 0.02, aggregation: "mean" },
    [{ name: "latency_ms", direction: "minimize", aggregation: "mean", maxRegression: 5 }],
  );
  assert.equal(decision.status, "keep");
  assert.ok(decision.primaryDelta! > 0.039);
});

test("decision rejects a primary win that violates a guardrail", () => {
  const evaluation: EvaluationResult = { ok: true, attempts: [], aggregatedMetrics: { accuracy: 0.84, latency_ms: 110 } };
  const decision = decideCandidate(
    { accuracy: 0.8, latency_ms: 100 },
    evaluation,
    { name: "accuracy", direction: "maximize", minimumDelta: 0.02, aggregation: "mean" },
    [{ name: "latency_ms", direction: "minimize", aggregation: "mean", maxRegression: 5 }],
  );
  assert.equal(decision.status, "reject");
  assert.match(decision.reasons.join(" "), /over limit/);
});
