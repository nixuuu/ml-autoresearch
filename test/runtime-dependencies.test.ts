import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { DependencyBroker, resolveRuntimeEnvironment } from "../src/dependency-broker.js";
import { spawnSpec } from "../src/evaluator.js";
import type { HarnessConfig, RuntimeEnvironmentManifest } from "../src/types.js";

function config(root: string, workspace: string): HarnessConfig {
  return {
    version: 2,
    name: "runtime-dependency-test",
    project: { sourceDir: workspace, mutablePaths: ["candidate"], protectedPaths: [], hiddenPaths: [], copyIgnore: [] },
    agent: {
      thinkingLevel: "off",
      analysis: {
        enabled: true, timeoutSeconds: 30, maxCalls: 3, maxOutputBytes: 8_192, inheritEnv: [], env: {},
        runner: { mode: "docker", allowHostExecution: false, image: "research-runtime:test", network: "none", readOnlyRoot: true, pidsLimit: 64 },
      },
    },
    runtimeDependencies: {
      enabled: true,
      strategy: "locked-overlay",
      manifestPath: "candidate/autoresearch.dependencies.json",
      allowedManagers: ["python", "bun"],
      registries: {},
      allow: [{ manager: "python", package: "allowed-package" }],
      deny: [{ manager: "python", package: "blocked-package" }],
      maxDirectDependencies: 4,
      maxInstallSeconds: 30,
      maxEnvironmentBytes: 10_000_000,
      requireLockedVersions: true,
      cachePath: path.join(root, "dependency-cache"),
      python: { installer: "pip", onlyBinary: true },
      bun: { ignoreScripts: true },
      environmentProfiles: {},
    },
    evaluator: {
      command: ["python3", "evaluate.py"], timeoutSeconds: 30, repetitions: 1, seeds: [1], inheritEnv: [], env: {},
      runner: { mode: "docker", image: "research-runtime:test", network: "none", readOnlyRoot: true, pidsLimit: 64 },
    },
    metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0, aggregation: "mean" }, guardrails: [] },
    budget: { maxExperiments: 1, maxWallTimeMinutes: 0, maxConsecutiveFailures: 1 },
    learning: {
      beamWidth: 1, maxBranchDepth: 1, maxTemporaryRegressionRatio: 1, recentExperiments: 1, maxContextLessons: 1,
      supportThreshold: 1, contradictionThreshold: 1, maxFrontierPerCategory: 1,
      strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0, optimizeRate: 0, mergeRate: 0, ablationRate: 0 },
      humanLessons: [], campaign: { enabled: false, queueRate: 0, maxQueued: 1, hypothesesPerProposal: 1, autoAblations: false, maxAblationsPerPromotion: 1, autoMerge: false },
      meta: { enabled: false, updateInterval: 1, warmupExperiments: 1, explorationFloor: 0 },
    },
    outputDir: path.join(root, "runs"),
    researchInstructions: "test",
  };
}

test("locked candidate overlays are mounted identically into evaluator Docker runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-runtime-deps-"));
  const workspace = path.join(root, "workspace");
  const direct: RuntimeEnvironmentManifest["direct"] = {
    python: [{ name: "allowed-package", version: "==1.2.3" }],
    bun: [{ name: "zod", version: "4.1.5" }],
  };
  const resolved: RuntimeEnvironmentManifest["resolved"] = {
    python: [{ name: "allowed-package", version: "1.2.3" }],
    bun: [{ name: "zod", version: "4.1.5" }],
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, imageId: "sha256:locked-image", selectedProfile: null, resources: {}, direct, resolved })).digest("hex");
  const environmentRoot = path.join(root, "dependency-cache", "environments", fingerprint);
  await Promise.all([
    mkdir(path.join(workspace, "candidate"), { recursive: true }),
    mkdir(path.join(environmentRoot, "python"), { recursive: true }),
    mkdir(path.join(environmentRoot, "bun", "node_modules"), { recursive: true }),
  ]);
  const manifest: RuntimeEnvironmentManifest = {
    version: 1,
    baseImage: "research-runtime:test",
    baseImageId: "sha256:locked-image",
    direct,
    resolved,
    environmentFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(workspace, "candidate", "autoresearch.dependencies.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(environmentRoot, "environment.json"), JSON.stringify(manifest), "utf8");
  const cfg = config(root, workspace);
  const runtime = await resolveRuntimeEnvironment(cfg, workspace);
  assert.equal(runtime?.image, "sha256:locked-image");

  const artifactDir = path.join(root, "artifacts");
  const spec = spawnSpec(
    cfg,
    workspace,
    artifactDir,
    path.join(artifactDir, "metrics.json"),
    1,
    "exp-0001",
    { name: "canonical", budgetRatio: 1, pruneIfClearlyWorse: false },
    { runtimeEnvironment: runtime! },
  );
  assert.equal(spec.args.at(-1), "evaluate.py");
  assert.ok(spec.args.includes("sha256:locked-image"));
  assert.ok(spec.args.includes(`type=bind,src=${path.join(environmentRoot, "python")},dst=/autoresearch-deps/python,readonly`));
  assert.ok(spec.args.includes(`type=bind,src=${path.join(environmentRoot, "bun", "node_modules")},dst=/workspace/node_modules,readonly`));
  assert.ok(spec.args.includes("PYTHONPATH=/autoresearch-deps/python"));
  assert.ok(spec.args.includes("NODE_PATH=/workspace/node_modules"));

  await writeFile(
    path.join(workspace, "candidate", "autoresearch.dependencies.json"),
    JSON.stringify({ ...manifest, baseImageId: "sha256:agent-edited-image" }),
    "utf8",
  );
  await assert.rejects(resolveRuntimeEnvironment(cfg, workspace), /fingerprint does not match|does not match the broker-owned/);
});

test("dependency policy rejects denied packages before invoking an installer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-runtime-policy-"));
  const workspace = path.join(root, "workspace");
  const experiment = path.join(root, "experiment");
  await mkdir(path.join(workspace, "candidate"), { recursive: true });
  const broker = new DependencyBroker(config(root, workspace), workspace, experiment);
  await assert.rejects(
    broker.add({ manager: "python", package: "blocked-package", version: "1.0.0", scope: "candidate", reason: "test" }),
    /denied by policy/,
  );
});
