const request = JSON.parse((await Bun.stdin.text()).trim()) as { jobId: string; evaluator: { seed: number; stage: { name: string } } };
console.log(JSON.stringify({
  schemaVersion: 1,
  jobId: request.jobId,
  status: "completed",
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 12,
  stdout: "remote evaluator output\n",
  stderr: "",
  metrics: { metrics: { score: request.evaluator.seed + 1 }, metadata: { provider: "fake" } },
  phaseEvents: [{ timestamp: "2026-01-01T00:00:00.000Z", phase: request.evaluator.stage.name, status: "completed", durationMs: 12 }],
}));
