import assert from "node:assert/strict";
import { test } from "bun:test";
import { normalizeChangeCategory } from "../src/change-category.js";

test("semantic category normalization collapses ridge naming variants", () => {
  assert.equal(normalizeChangeCategory("ridge_tuning_degree3"), "regularization");
  assert.equal(normalizeChangeCategory("degree3-ridge-tuning"), "regularization");
  assert.equal(normalizeChangeCategory("ridge regularization tuning"), "regularization");
});

test("category normalization recognizes architecture and replication families", () => {
  assert.equal(normalizeChangeCategory("increase-polynomial-degree"), "model-architecture");
  assert.equal(normalizeChangeCategory("exact checkpoint replication"), "evaluation");
});
