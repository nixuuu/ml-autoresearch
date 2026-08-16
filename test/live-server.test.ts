import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { LiveDashboardServer } from "../src/live-server.js";
import type { RunState } from "../src/types.js";

function evaluation(score: number) {
  return {
    ok: true,
    attempts: [],
    aggregatedMetrics: { score },
  };
}

test("live dashboard serves embedded SPA routes, state, experiment details, and SSE progress", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-dashboard-"));
  const experimentDir = path.join(runDir, "experiments", "exp-0001");
  await mkdir(experimentDir, { recursive: true });
  const proposalPath = path.join(experimentDir, "proposal.md");
  const conclusionPath = path.join(experimentDir, "conclusion.md");
  await writeFile(proposalPath, "Try score two.\n", "utf8");
  await writeFile(conclusionPath, "Score two worked.\n", "utf8");
  const state: RunState = {
    schemaVersion: 3,
    runId: "test-run",
    name: "dashboard-test",
    status: "running",
    startedAt: new Date().toISOString(),
    configPath: path.join(runDir, "config.json"),
    runDir,
    sourceDir: runDir,
    primaryMetric: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" },
    acceptedWorkspacePath: runDir,
    baseline: evaluation(1),
    acceptedMetrics: { score: 2 },
    experiments: [{
      id: "exp-0001",
      index: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      workspacePath: experimentDir,
      proposalPath,
      conclusionPath,
      parentId: "baseline",
      strategy: "exploit",
      branchDepth: 1,
      changedPaths: ["model.json"],
      forbiddenChanges: [],
      evaluation: evaluation(2),
      decision: { status: "promote", primaryDelta: 1, reasons: ["improved"] },
    }],
  };
  await writeFile(path.join(runDir, "state.json"), `${JSON.stringify(state)}\n`, "utf8");
  const html = "<!doctype html><title>Dashboard test</title>";
  const server = new LiveDashboardServer({
    runDir,
    assets: { "/index.html": { contentType: "text/html; charset=utf-8", base64: Buffer.from(html).toString("base64") } },
  });
  await server.start();
  try {
    assert.equal(await (await fetch(`${server.url}/`)).text(), html);
    assert.equal(await (await fetch(`${server.url}/experiments/exp-0001`)).text(), html);
    const head = await fetch(`${server.url}/experiments/exp-0001`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /text\/html/);

    const snapshot = await (await fetch(`${server.url}/api/state`)).json() as { run: RunState };
    assert.equal(snapshot.run.runId, "test-run");
    const detail = await (await fetch(`${server.url}/api/experiments/exp-0001`)).json() as { proposal: string; conclusion: string };
    assert.equal(detail.proposal, "Try score two.\n");
    assert.equal(detail.conclusion, "Score two worked.\n");

    const abort = new AbortController();
    const response = await fetch(`${server.url}/api/events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: snapshot/);
    server.publishProgress("exp-0002 EVALUATION: running");
    const progress = new TextDecoder().decode((await reader.read()).value);
    assert.match(progress, /event: progress/);
    assert.match(progress, /exp-0002 EVALUATION/);
    abort.abort();
  } finally {
    server.stop();
  }
});
