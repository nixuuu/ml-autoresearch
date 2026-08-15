import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadConfig } from "../src/config.js";

function minimalConfig(learning?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    name: "config-test",
    project: { sourceDir: ".", mutablePaths: ["model.py"] },
    evaluator: { command: ["python3", "evaluate.py"] },
    metrics: { primary: { name: "loss", direction: "minimize" } },
    budget: {},
    ...(learning ? { learning } : {}),
    researchInstructions: "test",
  };
}

async function configFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-config-"));
  const file = path.join(directory, "autoresearch.config.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

test("config supplies the full learning policy by default", async () => {
  const config = await loadConfig(await configFile(minimalConfig()));
  assert.equal(config.learning.beamWidth, 3);
  assert.equal(config.learning.maxTemporaryRegressionRatio, 0.05);
  assert.equal(config.learning.maxFrontierPerCategory, 1);
  assert.deepEqual(config.project.hiddenPaths, []);
  assert.deepEqual(config.evaluator.agentRequests, { allowPairedComparison: false, maxSeeds: 5 });
  assert.equal(config.learning.strategy.explorationRate, 0.25);
  assert.deepEqual(config.learning.humanLessons, []);
});

test("config loads bounded agent evaluation requests", async () => {
  const value = minimalConfig();
  value.evaluator = {
    command: ["python3", "evaluate.py"],
    agentRequests: { allowPairedComparison: true, maxSeeds: 7 },
  };
  const config = await loadConfig(await configFile(value));
  assert.deepEqual(config.evaluator.agentRequests, { allowPairedComparison: true, maxSeeds: 7 });
});

test("config rejects strategy rates above the complete experiment budget", async () => {
  const file = await configFile(minimalConfig({
    strategy: { explorationRate: 0.5, backtrackRate: 0.3, replicationRate: 0.2, falsificationRate: 0.1 },
  }));
  await assert.rejects(loadConfig(file), /must sum to <= 1/);
});

test("config loads human-approved lessons and requires unique ids", async () => {
  const learning = {
    humanLessons: [
      { id: "fixed-budget", claim: "Keep the training budget fixed", guidance: "avoid" },
      { id: "fixed-budget", claim: "Do not add epochs", guidance: "avoid" },
    ],
  };
  await assert.rejects(loadConfig(await configFile(minimalConfig(learning))), /ids must be unique/);
});

test("config keeps hidden evaluator files read-only", async () => {
  const value = minimalConfig();
  value.project = { sourceDir: ".", mutablePaths: ["model.py", "holdout.py"], hiddenPaths: ["holdout.py"] };
  await assert.rejects(loadConfig(await configFile(value)), /hiddenPaths cannot also be mutable/);
});
