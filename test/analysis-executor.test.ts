import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { OpenResearchExecutor } from "../src/analysis-executor.js";
import type { AgentAnalysisConfig } from "../src/types.js";

test("open research commands use a persistent mirror without hidden files or candidate-side writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-analysis-"));
  const candidate = path.join(root, "candidate-workspace");
  const experimentDir = path.join(root, "experiment");
  await Promise.all([
    mkdir(path.join(candidate, "candidate"), { recursive: true }),
    mkdir(path.join(candidate, "data"), { recursive: true }),
    mkdir(path.join(candidate, "private"), { recursive: true }),
  ]);
  await writeFile(path.join(candidate, "candidate", "config.json"), JSON.stringify({ window: 30 }), "utf8");
  await writeFile(path.join(candidate, "data", "train.csv"), "x,y\n1,2\n", "utf8");
  await writeFile(path.join(candidate, "private", "holdout.csv"), "secret\n", "utf8");
  const policy: AgentAnalysisConfig = {
    enabled: true,
    timeoutSeconds: 10,
    maxCalls: 3,
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
  const executor = new OpenResearchExecutor(policy, candidate, experimentDir, ["private"]);
  const first = await executor.run({
    command: [process.execPath, "-e", [
      "const fs=require('fs');",
      "const hidden=fs.existsSync('private/holdout.csv');",
      "fs.writeFileSync('candidate/config.json', JSON.stringify({window: 999}));",
      "fs.writeFileSync('.autoresearch-analysis/diagnostic.json', JSON.stringify({hidden}));",
      "console.log(JSON.stringify({hidden,train:fs.existsSync('data/train.csv')}));",
    ].join("")],
  });
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /"hidden":false/);
  assert.match(first.stdout, /"train":true/);
  assert.deepEqual(JSON.parse(await readFile(path.join(candidate, "candidate", "config.json"), "utf8")), { window: 30 });
  assert.deepEqual(JSON.parse(await readFile(path.join(executor.scratchPath, "diagnostic.json"), "utf8")), { hidden: false });

  await writeFile(path.join(candidate, "candidate", "config.json"), JSON.stringify({ window: 60 }), "utf8");
  await executor.syncCandidateFile("candidate/config.json");
  const second = await executor.run({ command: [process.execPath, "-e", "console.log(require('./candidate/config.json').window)"] });
  assert.equal(second.stdout.trim(), "60");
  assert.match(await readFile(path.join(experimentDir, "analysis", "commands.jsonl"), "utf8"), /analysis_command_completed/);
  assert.equal(await readFile(second.stdoutPath, "utf8"), "60\n");
});

test("analysis evidence is fingerprinted, invalidated by candidate edits, and background jobs are observable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-analysis-evidence-"));
  const candidate = path.join(root, "candidate-workspace");
  const experimentDir = path.join(root, "experiment");
  await mkdir(path.join(candidate, "candidate"), { recursive: true });
  await writeFile(path.join(candidate, "candidate", "value.txt"), "before\n", "utf8");
  const published: string[] = [];
  const policy: AgentAnalysisConfig = {
    enabled: true,
    timeoutSeconds: 10,
    maxCalls: 5,
    maxOutputBytes: 8_192,
    inheritEnv: ["PATH"],
    env: {},
    runtime: { pythonCommand: [process.execPath], testCommand: [process.execPath, "-e", "process.exit(0)"], projectPathEntries: ["."] },
    jobs: { enabled: true, maxConcurrent: 1 },
    evidence: { requireFreshAfterMutation: true, autoPublishToLab: true },
    runner: { mode: "local", allowHostExecution: true, network: "none", readOnlyRoot: true, pidsLimit: 64 },
  };
  const executor = new OpenResearchExecutor(policy, candidate, experimentDir, [], undefined, async (evidence) => {
    published.push(evidence.evidenceId);
  });
  const runtime = await executor.runtimeInfo();
  assert.deepEqual(runtime.pythonCommand, [process.execPath]);
  assert.ok(runtime.environmentFingerprint.length >= 32);

  const first = await executor.run({ command: [process.execPath, "-e", "console.log(process.env.PYTHONPATH)"] });
  assert.equal(first.evidenceId, "evidence-0001");
  assert.deepEqual(executor.freshSuccessfulEvidenceIds(), ["evidence-0001"]);
  assert.deepEqual(published, ["evidence-0001"]);

  await writeFile(path.join(candidate, "candidate", "value.txt"), "after\n", "utf8");
  await executor.syncCandidateFile("candidate/value.txt");
  assert.equal(executor.evidence()[0]?.stale, true);
  assert.deepEqual(executor.freshSuccessfulEvidenceIds(), []);

  const started = await executor.start({ command: [process.execPath, "-e", "console.log('job complete')"] });
  assert.equal(started.status, "running");
  for (let index = 0; index < 50 && executor.job(started.jobId).status === "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const completed = executor.job(started.jobId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.evidenceId, "evidence-0002");
  assert.deepEqual(executor.freshSuccessfulEvidenceIds(), ["evidence-0002"]);

  executor.invalidateRuntimeEvidence("test runtime change");
  assert.deepEqual(executor.freshSuccessfulEvidenceIds(), []);

  const delayed = await executor.start({ command: [process.execPath, "-e", "setTimeout(() => console.log('late'), 100)"] });
  await writeFile(path.join(candidate, "candidate", "value.txt"), "during-job\n", "utf8");
  await executor.syncCandidateFile("candidate/value.txt");
  for (let index = 0; index < 50 && executor.job(delayed.jobId).status === "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(executor.job(delayed.jobId).status, "completed");
  assert.equal(executor.evidence().at(-1)?.stale, true);
  assert.deepEqual(executor.freshSuccessfulEvidenceIds(), []);
});
