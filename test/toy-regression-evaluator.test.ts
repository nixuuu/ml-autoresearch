import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const exampleDir = path.resolve(import.meta.dir, "../examples/toy-regression");
const python = Bun.which("python3");

async function runEvaluator(
  artifactDir: string,
  output: string,
  stage: string,
  budgetRatio: number,
  checkpoint: string,
  previousCheckpoint?: string,
): Promise<Record<string, unknown>> {
  assert.ok(python, "python3 is required for the toy evaluator test");
  const child = Bun.spawn([python, "evaluate.py"], {
    cwd: exampleDir,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      AUTORESEARCH_METRICS_PATH: output,
      AUTORESEARCH_ARTIFACT_DIR: artifactDir,
      AUTORESEARCH_SEED: "17",
      AUTORESEARCH_STAGE: stage,
      AUTORESEARCH_BUDGET_RATIO: String(budgetRatio),
      AUTORESEARCH_CHECKPOINT_MANIFEST_PATH: checkpoint,
      AUTORESEARCH_PHASE_EVENTS_PATH: path.join(artifactDir, `${stage}-phases.jsonl`),
      ...(previousCheckpoint ? { AUTORESEARCH_PREVIOUS_CHECKPOINT_MANIFEST_PATH: previousCheckpoint } : {}),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr).text();
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
}

test("toy evaluator resumes nested stage checkpoints without changing canonical metrics", async () => {
  const artifacts = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-toy-checkpoint-"));
  const smokeCheckpoint = path.join(artifacts, "smoke-checkpoint.json");
  const screeningCheckpoint = path.join(artifacts, "screening-checkpoint.json");

  await runEvaluator(artifacts, path.join(artifacts, "smoke.json"), "smoke", 0.15, smokeCheckpoint);
  await runEvaluator(artifacts, path.join(artifacts, "screening.json"), "screening", 0.35, screeningCheckpoint, smokeCheckpoint);
  const resumed = await runEvaluator(
    artifacts,
    path.join(artifacts, "resumed.json"),
    "canonical",
    1,
    path.join(artifacts, "resumed-checkpoint.json"),
    screeningCheckpoint,
  );
  const cold = await runEvaluator(
    artifacts,
    path.join(artifacts, "cold.json"),
    "canonical-cold",
    1,
    path.join(artifacts, "cold-checkpoint.json"),
  );

  assert.deepEqual(resumed.metrics, cold.metrics);
  const metadata = resumed.metadata as Record<string, unknown>;
  assert.equal(metadata.checkpoint_resumed_examples, 28);
  assert.equal((metadata.sliceMetrics as unknown[]).length, 4);
  assert.ok(Object.keys(metadata.timings as Record<string, number>).includes("training"));
  assert.equal((await readFile(path.join(artifacts, "canonical-phases.jsonl"), "utf8")).trim().split("\n").length, 10);
});
