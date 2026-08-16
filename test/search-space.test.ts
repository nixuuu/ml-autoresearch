import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  applySearchSuggestion,
  generateSearchSuggestions,
  inspectSearchSpace,
  isValidSearchSpace,
  suggestLocalSearchSpace,
  suggestSearchSpace,
  validateSearchSpace,
} from "../src/search-space.js";

const space = {
  parameters: {
    "model.learningRate": { type: "float", min: 0.001, max: 0.1, scale: "log" as const },
    "model.depth": { type: "int", min: 2, max: 8 },
    "model.activation": { type: "categorical", values: ["relu", "gelu", "silu"] as const },
    "model.bias": { type: "bool" as const },
  },
};

test("search-space validation enforces ranges and paths", () => {
  const normalized = validateSearchSpace(space);
  assert.deepEqual(Object.keys(normalized), ["model.learningRate", "model.depth", "model.activation", "model.bias"]);
  assert.equal(isValidSearchSpace(space), true);
  assert.equal(inspectSearchSpace({ bad: { type: "float", min: 4, max: 1 } }).valid, false);
  assert.throws(() => validateSearchSpace({ bad: { type: "float", min: 4, max: 1 } }), /min must be at most max/);
  assert.throws(() => validateSearchSpace({ "__proto__.polluted": { type: "bool" } }), /unsafe/);
});

test("search suggestions are deterministic, bounded, and quasi-random by index", () => {
  const first = suggestSearchSpace(space, 42, 0);
  const same = suggestSearchSpace(space, 42, 0);
  const next = suggestSearchSpace(space, 42, 1);
  assert.deepEqual(first, same);
  assert.notDeepEqual(first, next);
  assert.ok((first["model.learningRate"] as number) >= 0.001 && (first["model.learningRate"] as number) <= 0.1);
  assert.ok((first["model.depth"] as number) >= 2 && (first["model.depth"] as number) <= 8);
  assert.ok(["relu", "gelu", "silu"].includes(first["model.activation"] as string));
  assert.equal(typeof first["model.bias"], "boolean");
  assert.equal(generateSearchSuggestions(space, 42, 3).length, 3);
});

test("local search starts at the leader and explores a bounded neighborhood", () => {
  const leader = { model: { learningRate: 0.02, depth: 5, activation: "gelu", bias: true } } as const;
  const localFirst = suggestLocalSearchSpace(space, leader, 7, 0, 0.15);
  assert.equal(localFirst["model.learningRate"], leader.model.learningRate);
  assert.equal(localFirst["model.depth"], leader.model.depth);
  assert.equal(localFirst["model.activation"], leader.model.activation);
  assert.equal(localFirst["model.bias"], leader.model.bias);

  const localNext = suggestLocalSearchSpace(space, leader, 7, 1, 0.15);
  assert.ok((localNext["model.learningRate"] as number) >= 0.001 && (localNext["model.learningRate"] as number) <= 0.1);
  assert.ok((localNext["model.depth"] as number) >= 2 && (localNext["model.depth"] as number) <= 8);
});

test("applySearchSuggestion is immutable, supports dotted paths, and rejects unsafe paths", () => {
  const original = { model: { learningRate: 0.01 }, layers: [{ width: 8 }] } as const;
  const updated = applySearchSuggestion(original, {
    "model.learningRate": 0.02,
    "layers.0.width": 16,
    "model.dropout": 0.1,
  });
  assert.equal(original.model.learningRate, 0.01);
  assert.equal(original.layers[0]?.width, 8);
  assert.deepEqual(updated, { model: { learningRate: 0.02, dropout: 0.1 }, layers: [{ width: 16 }] });
  assert.throws(() => applySearchSuggestion(original, { "__proto__.polluted": true }), /unsafe/);
});
