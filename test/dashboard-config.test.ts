import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { parseDashboardConfig, presentDashboardRun } from "../src/dashboard-config.js";
import { LiveDashboardServer } from "../src/live-server.js";
import type { RunState } from "../src/types.js";

const presentation = { metrics: [
  { name: "loss", label: "Relative loss", format: "percentage" as const },
  { name: "coverage", label: "Coverage", format: "percentage" as const },
] };

function state(runDir = "."): RunState {
  return { runId: "display-test", runDir, name: "Display test", status: "failed", startedAt: new Date().toISOString(),
    primaryMetric: { name: "loss", direction: "minimize", format: "number", aggregation: "mean", minimumDelta: 0.01 },
    guardrails: [{ name: "coverage", direction: "maximize", format: "number", aggregation: "mean", min: 0.5 }],
    baseline: { ok: true, attempts: [], aggregatedMetrics: { loss: 0.125, coverage: 0.75 } },
    acceptedMetrics: { loss: 0.125, coverage: 0.75 }, experiments: [],
  } as unknown as RunState;
}

test("dashboard presentation changes labels and formatting without changing evaluation policy or values", () => {
  const raw = state();
  const before = structuredClone(raw);
  const display = presentDashboardRun(raw, parseDashboardConfig(presentation))!;
  assert.equal(display.primaryMetric?.format, "percentage");
  assert.equal(display.guardrails?.[0]?.format, "percentage");
  assert.equal(display.primaryMetric?.minimumDelta, 0.01);
  assert.deepEqual(display.acceptedMetrics, before.acceptedMetrics);
  assert.deepEqual(display.baseline, before.baseline);
  assert.deepEqual(raw, before);
  assert.equal(presentDashboardRun(raw, undefined), raw);
  assert.throws(() => parseDashboardConfig({ metrics: [{ name: "loss" }, { name: "loss" }] }), /unique/);
  assert.throws(() => parseDashboardConfig({ metrics: [{ name: "loss", format: "guess" }] }), /format/);
});

test("dashboard can format an existing run from presentation config without rewriting its ledger", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "dashboard-presentation-"));
  const rawState = JSON.stringify(state(runDir));
  await writeFile(path.join(runDir, "state.json"), rawState);
  await writeFile(path.join(runDir, "config.resolved.json"), JSON.stringify({ dashboard: presentation, privateValue: "do-not-publish" }));
  const server = new LiveDashboardServer({ runDir, assets: { "/index.html": { contentType: "text/html", base64: Buffer.from("test").toString("base64") } } });
  try {
    await server.start();
    const response = await fetch(server.url+"/api/state");
    const text = await response.text();
    const snapshot = JSON.parse(text);
    assert.equal(snapshot.run.primaryMetric.format, "percentage");
    assert.equal(snapshot.run.acceptedMetrics.loss, 0.125);
    assert.deepEqual(snapshot.run.dashboard, presentation);
    assert.ok(!text.includes("do-not-publish"));
    assert.equal(await readFile(path.join(runDir, "state.json"), "utf8"), rawState);
  } finally {
    server.stop();
    await rm(runDir, { recursive: true, force: true });
  }
});
