import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ResearchLabPool } from "../src/research-lab.js";
import type { ResearchLabConfig } from "../src/types.js";

function config(root: string): ResearchLabConfig {
  return {
    enabled: true,
    engine: "python",
    path: root,
    timeoutSeconds: 5,
    maxCalls: 20,
    maxOutputBytes: 8_192,
    inheritEnv: ["PATH"],
    env: {},
    runner: {
      mode: "local",
      allowHostExecution: true,
      network: "none",
      readOnlyRoot: true,
      pidsLimit: 64,
    },
  };
}

test("persistent research lab shares kernel state and durable files across experiments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-lab-"));
  const runDir = path.join(root, "runs", "run-1");
  const firstExperiment = path.join(runDir, "experiments", "exp-0001");
  const secondExperiment = path.join(runDir, "experiments", "exp-0002");
  const pool = new ResearchLabPool(config(path.join(root, "labs")));
  const first = pool.forExperiment(firstExperiment)!;
  const second = pool.forExperiment(secondExperiment)!;
  assert.equal(first, second);

  assert.equal((await first.execute("value = 41")).ok, true);
  assert.equal((await second.execute("value + 1")).result, "42");
  await first.write("recipes/screen.py", "def screen(x): return x > 0\n");
  assert.equal(await second.read("recipes/screen.py"), "def screen(x): return x > 0\n");
  await first.execute("def reusable(x):\n    return x * 2", { persist: true });
  await pool.dispose();

  const restoredPool = new ResearchLabPool(config(path.join(root, "labs")));
  const restored = restoredPool.forExperiment(firstExperiment)!;
  const restoredResult = await restored.execute("reusable(6)");
  assert.equal(restoredResult.result, "12");
  assert.equal(restoredResult.id, "cell-00004");
  await restoredPool.dispose();
});

test("persistent research lab bounds output and rejects escaping file paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoresearch-lab-bounds-"));
  const policy = { ...config(path.join(root, "labs")), maxOutputBytes: 1_024 };
  const pool = new ResearchLabPool(policy);
  const lab = pool.forExperiment(path.join(root, "run", "experiments", "exp-0001"))!;
  const result = await lab.execute("print('x' * 5000)");
  assert.equal(result.outputTruncated, true);
  const expression = await lab.execute("'y' * 5000");
  assert.equal(expression.outputTruncated, true);
  assert.ok((expression.result?.length ?? 0) < 1_024);
  await assert.rejects(lab.write("../escape.txt", "no"), /escapes the experiment workspace/);
  await pool.dispose();
});
