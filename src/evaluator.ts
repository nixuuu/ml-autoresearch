import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { EvaluationAttempt, EvaluationResult, HarnessConfig, MetricPayload } from "./types.js";
import { aggregateAttempts } from "./metrics.js";
import { ensureDir } from "./io.js";

function evaluatorEnvironment(config: HarnessConfig, metricsPath: string, seed: number, experimentId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of config.evaluator.inheritEnv) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    PYTHONDONTWRITEBYTECODE: "1",
    ...config.evaluator.env,
    AUTORESEARCH_METRICS_PATH: metricsPath,
    AUTORESEARCH_ARTIFACT_DIR: path.dirname(metricsPath),
    AUTORESEARCH_SEED: String(seed),
    AUTORESEARCH_EXPERIMENT_ID: experimentId,
  };
}

function spawnSpec(
  config: HarnessConfig,
  workspacePath: string,
  artifactDir: string,
  metricsPath: string,
  seed: number,
  experimentId: string,
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const evaluatorEnv = evaluatorEnvironment(config, metricsPath, seed, experimentId);
  if (config.evaluator.runner.mode === "local") {
    return {
      command: config.evaluator.command[0]!,
      args: config.evaluator.command.slice(1),
      cwd: workspacePath,
      env: evaluatorEnv,
    };
  }

  const containerMetricsPath = `/artifacts/${path.basename(metricsPath)}`;
  const containerEnv = evaluatorEnvironment(config, containerMetricsPath, seed, experimentId);
  for (const hostSpecific of ["PATH", "HOME", "TMPDIR", "VIRTUAL_ENV"]) delete containerEnv[hostSpecific];
  containerEnv.HOME = "/artifacts/home";
  containerEnv.TMPDIR = "/artifacts/tmp";
  containerEnv.XDG_CACHE_HOME = "/artifacts/cache";
  const args = [
    "run", "--rm", "--init",
    "--network", config.evaluator.runner.network,
    "--pids-limit", String(config.evaluator.runner.pidsLimit),
    "--mount", `type=bind,src=${path.resolve(workspacePath)},dst=/workspace,readonly`,
    "--mount", `type=bind,src=${path.resolve(artifactDir)},dst=/artifacts`,
    "--workdir", "/workspace",
  ];
  if (config.evaluator.runner.readOnlyRoot) args.push("--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g");
  if (config.evaluator.runner.cpus !== undefined) args.push("--cpus", String(config.evaluator.runner.cpus));
  if (config.evaluator.runner.memory) args.push("--memory", config.evaluator.runner.memory);
  if (config.evaluator.runner.gpus) args.push("--gpus", config.evaluator.runner.gpus);
  for (const [key, value] of Object.entries(containerEnv)) {
    if (value !== undefined) args.push("--env", `${key}=${value}`);
  }
  args.push(config.evaluator.runner.image!, ...config.evaluator.command);
  return {
    command: "docker",
    args,
    cwd: workspacePath,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  };
}

function validateMetricPayload(value: unknown): MetricPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metrics file must contain a JSON object");
  const raw = value as Record<string, unknown>;
  if (!raw.metrics || typeof raw.metrics !== "object" || Array.isArray(raw.metrics)) throw new Error("metrics file must contain a metrics object");
  const metrics = Object.fromEntries(Object.entries(raw.metrics as Record<string, unknown>).map(([name, metric]) => {
    if (typeof metric !== "number" || !Number.isFinite(metric)) throw new Error(`metric ${name} must be a finite number`);
    return [name, metric];
  }));
  return {
    metrics,
    ...(raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  };
}

async function runAttempt(
  config: HarnessConfig,
  workspacePath: string,
  artifactDir: string,
  experimentId: string,
  repetition: number,
  seed: number,
): Promise<EvaluationAttempt> {
  await ensureDir(artifactDir);
  if (config.evaluator.runner.mode === "docker") {
    await Promise.all(["home", "tmp", "cache"].map((directory) => ensureDir(path.join(artifactDir, directory))));
  }
  const stdoutPath = path.join(artifactDir, `stdout-${repetition}.log`);
  const stderrPath = path.join(artifactDir, `stderr-${repetition}.log`);
  const metricsPath = path.join(artifactDir, `metrics-${repetition}.json`);
  const stdout = createWriteStream(stdoutPath, { flags: "wx" });
  const stderr = createWriteStream(stderrPath, { flags: "wx" });
  const stdoutClosed = new Promise<void>((resolve, reject) => {
    stdout.once("close", resolve);
    stdout.once("error", reject);
  });
  const stderrClosed = new Promise<void>((resolve, reject) => {
    stderr.once("close", resolve);
    stderr.once("error", reject);
  });
  const started = Date.now();
  let timedOut = false;

  const spec = spawnSpec(config, workspacePath, artifactDir, metricsPath, seed, experimentId);
  const detached = process.platform !== "win32";
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const killTree = (signal: NodeJS.Signals) => {
    if (detached && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process may already have exited; fall back to ChildProcess.kill().
      }
    }
    child.kill(signal);
  };
  let hardKill: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    hardKill = setTimeout(() => killTree("SIGKILL"), 5_000);
    hardKill.unref();
  }, config.evaluator.timeoutSeconds * 1_000);

  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: string }>((resolve) => {
    child.once("error", (error) => resolve({ exitCode: null, signal: null, spawnError: error.message }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout);
  if (hardKill) clearTimeout(hardKill);
  await Promise.all([stdoutClosed, stderrClosed]);

  const base = {
    repetition,
    seed,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    durationMs: Date.now() - started,
    stdoutPath,
    stderrPath,
    metricsPath,
  };
  if (result.spawnError) return { ...base, error: `Could not start evaluator: ${result.spawnError}` };
  if (timedOut) return { ...base, error: `Evaluator exceeded ${config.evaluator.timeoutSeconds}s timeout` };
  if (result.exitCode !== 0) return { ...base, error: `Evaluator exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}` };

  try {
    const payload = validateMetricPayload(JSON.parse(await readFile(metricsPath, "utf8")) as unknown);
    return { ...base, metrics: payload.metrics, ...(payload.metadata ? { metadata: payload.metadata } : {}) };
  } catch (error) {
    return { ...base, error: `Invalid evaluator metrics: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function evaluateWorkspace(
  config: HarnessConfig,
  workspacePath: string,
  artifactDir: string,
  experimentId: string,
  options: { seeds?: number[] } = {},
): Promise<EvaluationResult> {
  const seeds = options.seeds ?? config.evaluator.seeds.slice(0, config.evaluator.repetitions);
  const attempts: EvaluationAttempt[] = [];
  for (let repetition = 0; repetition < seeds.length; repetition += 1) {
    attempts.push(await runAttempt(config, workspacePath, artifactDir, experimentId, repetition, seeds[repetition]!));
  }
  const failed = attempts.find((attempt) => attempt.error);
  if (failed) return { ok: false, attempts, aggregatedMetrics: {}, error: failed.error! };
  try {
    const aggregatedMetrics = aggregateAttempts([config.metrics.primary, ...config.metrics.guardrails], attempts);
    return { ok: true, attempts, aggregatedMetrics };
  } catch (error) {
    return { ok: false, attempts, aggregatedMetrics: {}, error: error instanceof Error ? error.message : String(error) };
  }
}
