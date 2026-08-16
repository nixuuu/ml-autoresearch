import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { readRunControl, runningControl, setRunControl, writeRunControl } from "../src/control.js";
import { writeJsonAtomic } from "../src/io.js";

async function runCli(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function state(runDir: string, status: "running" | "stopped" = "running") {
  const now = new Date().toISOString();
  return {
    schemaVersion: 6,
    runId: "control-test",
    name: "control-test",
    status,
    startedAt: now,
    configPath: path.join(runDir, "config.resolved.json"),
    runDir,
    sourceDir: runDir,
    acceptedWorkspacePath: runDir,
    baseline: { ok: true, attempts: [], aggregatedMetrics: { score: 1 } },
    acceptedMetrics: { score: 1 },
    activeDurationMs: 0,
    activeSegmentStartedAt: now,
    experiments: [],
  };
}

test("a stale heartbeat preserves the newer operator pause revision", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-control-race-"));
  const initial = { ...runningControl(), ownerPid: process.pid, heartbeatAt: new Date().toISOString() };
  await writeRunControl(runDir, initial);
  const stale = await readRunControl(runDir);
  const paused = await setRunControl(runDir, "paused", "operator pause");

  const staleHeartbeat = { ...stale, heartbeatAt: new Date().toISOString() };
  const result = await writeRunControl(runDir, staleHeartbeat);
  const current = await readRunControl(runDir);
  assert.equal(result.desiredState, "paused");
  assert.equal(current.desiredState, "paused");
  assert.ok(current.revision > paused.revision);
  assert.equal(current.reason, "operator pause");
});

test("stop and pause persist state for an inactive run", async () => {
  const stopDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-dead-stop-"));
  await writeJsonAtomic(path.join(stopDir, "state.json"), state(stopDir));
  const stopped = await runCli("stop", stopDir, "--reason", "dead process");
  assert.equal(stopped.exitCode, 0, stopped.stderr);
  const stoppedState = JSON.parse(await readFile(path.join(stopDir, "state.json"), "utf8")) as ReturnType<typeof state>;
  assert.equal(stoppedState.status, "stopped");
  assert.equal(stoppedState.stopReason, "dead process");
  assert.ok(stoppedState.finishedAt);
  assert.equal(stoppedState.activeSegmentStartedAt, undefined);
  assert.equal((await readRunControl(stopDir)).desiredState, "stopped");

  const pauseDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-dead-pause-"));
  await writeJsonAtomic(path.join(pauseDir, "state.json"), state(pauseDir));
  const paused = await runCli("pause", pauseDir, "--reason", "inspect");
  assert.equal(paused.exitCode, 0, paused.stderr);
  const pausedState = JSON.parse(await readFile(path.join(pauseDir, "state.json"), "utf8")) as ReturnType<typeof state>;
  assert.equal(pausedState.status, "paused");
  assert.equal(pausedState.finishedAt, undefined);
  assert.equal(pausedState.activeSegmentStartedAt, undefined);
  assert.equal((await readRunControl(pauseDir)).desiredState, "paused");
});

test("resume refuses a terminal stopped run", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-resume-stopped-"));
  await writeJsonAtomic(path.join(runDir, "state.json"), state(runDir, "stopped"));
  await setRunControl(runDir, "stopped", "operator stop");
  const result = await runCli("resume", runDir);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /was stopped and cannot be resumed/);
});
