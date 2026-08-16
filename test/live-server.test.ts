import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

test("live dashboard serves embedded SPA routes, active transcripts, experiment details, and SSE progress", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-dashboard-"));
  const experimentDir = path.join(runDir, "experiments", "exp-0001");
  await mkdir(experimentDir, { recursive: true });
  const proposalPath = path.join(experimentDir, "proposal.md");
  const conclusionPath = path.join(experimentDir, "conclusion.md");
  await writeFile(proposalPath, "Try score two.\n", "utf8");
  await writeFile(conclusionPath, "Score two worked.\n", "utf8");
  const activeExperimentDir = path.join(runDir, "experiments", "exp-0002");
  await mkdir(activeExperimentDir, { recursive: true });
  const transcriptPath = path.join(activeExperimentDir, "agent-transcript.jsonl");
  const transcriptTimestamp = new Date().toISOString();
  const eventOnlyTimestamp = new Date(Date.parse(transcriptTimestamp) + 1).toISOString();
  await writeFile(transcriptPath, `${JSON.stringify({
    timestamp: transcriptTimestamp,
    type: "agent_transcript",
    entryId: "implementer:proposal:1:thinking:0",
    operation: "append",
    phase: "proposal",
    actor: "implementer",
    kind: "thinking",
    title: "Thinking",
    content: "Inspecting the model",
  })}\n`, "utf8");
  const legacyExperimentDir = path.join(runDir, "experiments", "exp-0003");
  await mkdir(legacyExperimentDir, { recursive: true });
  await writeFile(path.join(legacyExperimentDir, "pi-events.jsonl"), [
    { timestamp: transcriptTimestamp, type: "agent_session_configured", requestedModel: "openai-codex/gpt-5.6-sol", resolvedModel: "openai-codex/gpt-5.6-sol", effectiveThinkingLevel: "xhigh" },
    { timestamp: transcriptTimestamp, type: "pi_event", event: { type: "turn_start" } },
    { timestamp: transcriptTimestamp, type: "pi_event", event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Recovered from the legacy Pi log" } } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  const state: RunState = {
    schemaVersion: 5,
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
      accounting: {
        durationMs: 1_000,
        evaluatorDurationMs: 500,
        agentUsage: { requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, costUsd: 0.01 },
        primaryImprovement: 1,
        relativePrimaryImprovement: 1,
        costPerImprovementUsd: 0.01,
        timePerImprovementMs: 1_000,
      },
    }],
  };
  await writeFile(path.join(runDir, "state.json"), `${JSON.stringify(state)}\n`, "utf8");
  await writeFile(path.join(runDir, "events.jsonl"), [
    { timestamp: transcriptTimestamp, type: "run_started", runId: "test-run" },
    {
      timestamp: transcriptTimestamp,
      type: "experiment_started",
      id: "exp-0099",
      assignment: { parentId: "baseline", strategy: "exploit", branchDepth: 1 },
    },
    { timestamp: transcriptTimestamp, type: "run_resumed", runId: "test-run" },
    {
      timestamp: transcriptTimestamp,
      type: "experiment_started",
      id: "exp-0002",
      assignment: { parentId: "exp-0001", strategy: "explore", branchDepth: 2 },
    },
    {
      timestamp: eventOnlyTimestamp,
      type: "experiment_started",
      id: "exp-0004",
      assignment: { parentId: "exp-0001", strategy: "optimize", branchDepth: 2 },
    },
    { timestamp: new Date().toISOString(), type: "progress", message: "historical-1" },
    { timestamp: new Date().toISOString(), type: "progress", message: "historical-2" },
    { timestamp: new Date().toISOString(), type: "progress", message: "historical-3" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n{not-json}\n", "utf8");
  const html = "<!doctype html><title>Dashboard test</title>";
  const server = new LiveDashboardServer({
    runDir,
    maxProgressEvents: 2,
    assets: { "/index.html": { contentType: "text/html; charset=utf-8", base64: Buffer.from(html).toString("base64") } },
  });
  await server.start();
  try {
    assert.equal(await (await fetch(`${server.url}/`)).text(), html);
    assert.equal(await (await fetch(`${server.url}/experiments/exp-0001`)).text(), html);
    const head = await fetch(`${server.url}/experiments/exp-0001`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") ?? "", /text\/html/);

    const detail = await (await fetch(`${server.url}/api/experiments/exp-0001`)).json() as { proposal: string; conclusion: string };
    assert.equal(detail.proposal, "Try score two.\n");
    assert.equal(detail.conclusion, "Score two worked.\n");
    const activeDetail = await (await fetch(`${server.url}/api/experiments/exp-0002`)).json() as { experiment: null; active: boolean };
    assert.equal(activeDetail.experiment, null);
    assert.equal(activeDetail.active, true);
    const transcript = await (await fetch(`${server.url}/api/experiments/exp-0002/transcript`)).json() as { active: boolean; entries: Array<{ content?: string }> };
    assert.equal(transcript.active, true);
    assert.equal(transcript.entries[0]?.content, "Inspecting the model");
    const eventOnlyDetail = await (await fetch(`${server.url}/api/experiments/exp-0004`)).json() as { experiment: null; active: boolean };
    assert.equal(eventOnlyDetail.experiment, null);
    assert.equal(eventOnlyDetail.active, true);
    const eventOnlyTranscript = await (await fetch(`${server.url}/api/experiments/exp-0004/transcript`)).json() as { active: boolean; entries: unknown[] };
    assert.equal(eventOnlyTranscript.active, true);
    assert.deepEqual(eventOnlyTranscript.entries, []);
    const legacyTranscript = await (await fetch(`${server.url}/api/experiments/exp-0003/transcript`)).json() as { entries: Array<{ content?: string }> };
    assert.ok(legacyTranscript.entries.some((entry) => entry.content === "Recovered from the legacy Pi log"));
    const snapshot = await (await fetch(`${server.url}/api/state`)).json() as {
      run: RunState;
      activeExperiments: Array<{ id: string; parentId?: string; strategy?: string; branchDepth?: number }>;
    };
    assert.equal(snapshot.run.runId, "test-run");
    assert.deepEqual(snapshot.activeExperiments.map((experiment) => experiment.id), ["exp-0002", "exp-0003", "exp-0004"]);
    assert.deepEqual(snapshot.activeExperiments[0], {
      id: "exp-0002",
      startedAt: transcriptTimestamp,
      transcriptEntries: 1,
      latestActivityAt: transcriptTimestamp,
      parentId: "exp-0001",
      strategy: "explore",
      branchDepth: 2,
    });

    const transcriptAbort = new AbortController();
    const transcriptResponse = await fetch(`${server.url}/api/experiments/exp-0002/transcript/events`, { signal: transcriptAbort.signal });
    const transcriptReader = transcriptResponse.body!.getReader();
    const transcriptInitial = new TextDecoder().decode((await transcriptReader.read()).value);
    assert.match(transcriptInitial, /event: snapshot/);
    assert.match(transcriptInitial, /Inspecting the model/);
    await appendFile(transcriptPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "agent_transcript",
      entryId: "implementer:proposal:1:tool:call-1",
      operation: "set",
      phase: "proposal",
      actor: "implementer",
      kind: "tool",
      title: "Using research_write",
      toolName: "research_write",
      toolCallId: "call-1",
      data: { path: "model.py" },
    })}\n`, "utf8");
    await fetch(`${server.url}/api/experiments/exp-0002/transcript`);
    const transcriptUpdate = new TextDecoder().decode((await transcriptReader.read()).value);
    assert.match(transcriptUpdate, /event: entry/);
    assert.match(transcriptUpdate, /research_write/);
    transcriptAbort.abort();

    const abort = new AbortController();
    const response = await fetch(`${server.url}/api/events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: snapshot/);
    assert.match(initial, /historical-2/);
    assert.match(initial, /historical-3/);
    assert.doesNotMatch(initial, /historical-1/);
    server.publishProgress("exp-0002 EVALUATION: running");
    const progress = new TextDecoder().decode((await reader.read()).value);
    assert.match(progress, /event: progress/);
    assert.match(progress, /exp-0002 EVALUATION/);
    abort.abort();
  } finally {
    server.stop();
  }
});
