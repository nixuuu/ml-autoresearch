import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  EvaluationAttempt,
  EvaluationResult,
  EvaluationStageConfig,
  EvaluationStageResult,
  HarnessConfig,
  MetricPayload,
  MetricStatistics,
  StatisticalComparison,
} from "./types.js";
import { aggregateAttempts } from "./metrics.js";
import { ensureDir } from "./io.js";
import { comparePairedSamples, confidenceInterval, summarize } from "./statistics.js";
import { killSubprocessTree, trackSubprocess } from "./subprocess-registry.js";

function evaluatorEnvironment(
  config: HarnessConfig,
  metricsPath: string,
  seed: number,
  experimentId: string,
  stage: EvaluationStageConfig,
): NodeJS.ProcessEnv {
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
    AUTORESEARCH_STAGE: stage.name,
    AUTORESEARCH_BUDGET_RATIO: String(stage.budgetRatio),
  };
}

function spawnSpec(
  config: HarnessConfig,
  workspacePath: string,
  artifactDir: string,
  metricsPath: string,
  seed: number,
  experimentId: string,
  stage: EvaluationStageConfig,
): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const evaluatorEnv = evaluatorEnvironment(config, metricsPath, seed, experimentId, stage);
  if (config.evaluator.runner.mode === "local") {
    return {
      command: config.evaluator.command[0]!,
      args: config.evaluator.command.slice(1),
      cwd: workspacePath,
      env: evaluatorEnv,
    };
  }

  const containerMetricsPath = `/artifacts/${path.basename(metricsPath)}`;
  const containerEnv = evaluatorEnvironment(config, containerMetricsPath, seed, experimentId, stage);
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
  stage: EvaluationStageConfig,
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

  const spec = spawnSpec(config, workspacePath, artifactDir, metricsPath, seed, experimentId, stage);
  const detached = process.platform !== "win32";
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackSubprocess(child, detached);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const killTree = (signal: NodeJS.Signals) => killSubprocessTree(child, detached, signal);
  let hardKill: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    hardKill = setTimeout(() => killTree("SIGKILL"), 5_000);
    hardKill.unref();
  }, (stage.timeoutSeconds ?? config.evaluator.timeoutSeconds) * 1_000);

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
    stage: stage.name,
    budgetRatio: stage.budgetRatio,
  };
  if (result.spawnError) return { ...base, error: `Could not start evaluator: ${result.spawnError}` };
  if (timedOut) return { ...base, error: `Evaluator exceeded ${stage.timeoutSeconds ?? config.evaluator.timeoutSeconds}s timeout in stage ${stage.name}` };
  if (result.exitCode !== 0) return { ...base, error: `Evaluator exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}` };

  try {
    const payload = validateMetricPayload(JSON.parse(await readFile(metricsPath, "utf8")) as unknown);
    return { ...base, metrics: payload.metrics, ...(payload.metadata ? { metadata: payload.metadata } : {}) };
  } catch (error) {
    return { ...base, error: `Invalid evaluator metrics: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function statisticsForAttempts(attempts: EvaluationAttempt[], confidenceLevel: number): Record<string, MetricStatistics> {
  const metricNames = new Set(attempts.flatMap((attempt) => Object.keys(attempt.metrics ?? {})));
  return Object.fromEntries([...metricNames].map((name) => {
    const values = attempts.map((attempt) => attempt.metrics?.[name]).filter((value): value is number => value !== undefined);
    const summary = summarize(values);
    const interval = confidenceInterval(values, confidenceLevel);
    return [name, {
      count: summary.n,
      mean: summary.mean,
      median: summary.median,
      variance: summary.variance,
      standardDeviation: summary.stddev,
      standardError: summary.stderr,
      minimum: summary.min,
      maximum: summary.max,
      confidenceLevel,
      confidenceInterval: { lower: interval.lower, upper: interval.upper },
    }];
  }));
}

function comparisonForAttempts(
  config: HarnessConfig,
  referenceAttempts: EvaluationAttempt[],
  candidateAttempts: EvaluationAttempt[],
): StatisticalComparison | undefined {
  const primary = config.metrics.primary;
  const referenceBySeed = new Map(referenceAttempts.map((attempt) => [attempt.seed, attempt.metrics?.[primary.name]]));
  const paired = candidateAttempts.flatMap((attempt) => {
    const reference = referenceBySeed.get(attempt.seed);
    const candidate = attempt.metrics?.[primary.name];
    return reference === undefined || candidate === undefined ? [] : [{ reference, candidate }];
  });
  if (paired.length === 0) return undefined;
  const policy = config.evaluator.statistics ?? {
    enabled: false,
    confidenceLevel: 0.95,
    equivalenceMargin: primary.minimumDelta,
    minimumSeeds: config.evaluator.repetitions,
    maximumSeeds: config.evaluator.repetitions,
    seedStep: 1,
  };
  const comparison = comparePairedSamples(
    paired.map((entry) => entry.reference),
    paired.map((entry) => entry.candidate),
    {
      direction: primary.direction,
      minimumDelta: primary.minimumDelta,
      equivalenceMargin: policy.equivalenceMargin,
      confidenceLevel: policy.confidenceLevel,
    },
  );
  return {
    status: comparison.status,
    direction: primary.direction,
    confidenceLevel: policy.confidenceLevel,
    sampleCount: comparison.n,
    improvement: comparison.primaryDelta,
    confidenceInterval: { lower: comparison.confidenceInterval.lower, upper: comparison.confidenceInterval.upper },
    minimumDelta: primary.minimumDelta,
    equivalenceMargin: policy.equivalenceMargin,
  };
}

function metricDefinitions(config: HarnessConfig, attempts: EvaluationAttempt[]): Array<{ name: string; aggregation: HarnessConfig["metrics"]["primary"]["aggregation"] }> {
  const configured = [config.metrics.primary, ...config.metrics.guardrails, ...(config.metrics.objectives ?? [])];
  const aggregations = new Map(configured.map((metric) => [metric.name, metric.aggregation]));
  for (const attempt of attempts) for (const name of Object.keys(attempt.metrics ?? {})) aggregations.set(name, aggregations.get(name) ?? "mean");
  return [...aggregations].map(([name, aggregation]) => ({ name, aggregation }));
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, task: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await task(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function weightedEvaluationWork(stages: EvaluationStageConfig[], evaluation: EvaluationResult): number {
  const stageResults = new Map((evaluation.stages ?? []).map((stage) => [stage.name, stage]));
  return stages.reduce((sum, stage, index) => {
    const matchingStage = stageResults.get(stage.name);
    const attempts = matchingStage?.attempts.length ?? (index === stages.length - 1 ? evaluation.attempts.length : 0);
    return sum + stage.budgetRatio * attempts;
  }, 0);
}

interface ReferenceEvaluationOptions {
  evaluation: EvaluationResult;
  workspacePath: string;
  artifactDir: string;
  experimentId: string;
}

export interface EvaluateWorkspaceOptions {
  seeds?: number[];
  reference?: ReferenceEvaluationOptions;
  onStage?: (stage: EvaluationStageResult) => void | Promise<void>;
}

export async function evaluateWorkspace(
  config: HarnessConfig,
  workspacePath: string,
  artifactDir: string,
  experimentId: string,
  options: EvaluateWorkspaceOptions = {},
): Promise<EvaluationResult> {
  const startedAt = Date.now();
  const stages = config.evaluator.stages?.length
    ? config.evaluator.stages
    : [{ name: "canonical", budgetRatio: 1, pruneIfClearlyWorse: false }];
  const statisticalPolicy = config.evaluator.statistics ?? {
    enabled: false,
    confidenceLevel: 0.95,
    equivalenceMargin: config.metrics.primary.minimumDelta,
    minimumSeeds: config.evaluator.repetitions,
    maximumSeeds: config.evaluator.repetitions,
    seedStep: 1,
  };
  const allSeeds = options.seeds ?? config.evaluator.seeds;
  const stageResults: EvaluationStageResult[] = [];
  const plannedCandidateWork = stages.reduce((sum, item, index) => {
    const repetitions = options.seeds
      ? options.seeds.length
      : index === stages.length - 1 && statisticalPolicy.enabled && options.reference
        ? statisticalPolicy.maximumSeeds
        : item.repetitions ?? config.evaluator.repetitions;
    return sum + item.budgetRatio * Math.min(repetitions, allSeeds.length);
  }, 0);
  const accountsForReference = Boolean(options.reference && statisticalPolicy.enabled);
  const plannedWork = plannedCandidateWork * (accountsForReference ? 2 : 1);
  let referenceWorkUsed = accountsForReference ? weightedEvaluationWork(stages, options.reference!.evaluation) : 0;

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex]!;
    const stageArtifactDir = path.join(artifactDir, stage.name);
    const referenceStage = options.reference?.evaluation.stages?.find((entry) => entry.name === stage.name)
      ?? (stageIndex === stages.length - 1 ? options.reference?.evaluation : undefined);
    const configuredMinimum = stage.repetitions ?? config.evaluator.repetitions;
    const isFinalStage = stageIndex === stages.length - 1;
    const minimumSeeds = options.seeds
      ? options.seeds.length
      : isFinalStage && statisticalPolicy.enabled && options.reference ? Math.max(configuredMinimum, statisticalPolicy.minimumSeeds) : configuredMinimum;
    const maximumSeeds = options.seeds
      ? options.seeds.length
      : isFinalStage && statisticalPolicy.enabled && options.reference ? statisticalPolicy.maximumSeeds : minimumSeeds;
    const attempts: EvaluationAttempt[] = [];
    const adaptiveReferenceAttempts = [...(referenceStage?.attempts ?? [])];
    let targetCount = Math.min(minimumSeeds, maximumSeeds, allSeeds.length);
    let comparison: StatisticalComparison | undefined;

    while (attempts.length < targetCount) {
      const batchSeeds = allSeeds.slice(attempts.length, targetCount);
      const batch = await mapConcurrent(batchSeeds, config.evaluator.repetitionConcurrency ?? 1, (seed, offset) =>
        runAttempt(config, workspacePath, stageArtifactDir, experimentId, attempts.length + offset, seed, stage));
      attempts.push(...batch);
      const failed = attempts.find((attempt) => attempt.error);
      if (failed) {
        const failedStage: EvaluationStageResult = {
          name: stage.name,
          budgetRatio: stage.budgetRatio,
          ok: false,
          attempts,
          aggregatedMetrics: {},
          statistics: {},
          pruned: false,
          error: failed.error!,
        };
        stageResults.push(failedStage);
        await options.onStage?.(failedStage);
        return { ok: false, attempts, stages: stageResults, aggregatedMetrics: {}, error: failed.error!, totalDurationMs: Date.now() - startedAt };
      }

      if (options.reference && statisticalPolicy.enabled) {
        const present = new Set(adaptiveReferenceAttempts.map((attempt) => attempt.seed));
        const missingSeeds = batchSeeds.filter((seed) => !present.has(seed));
        if (missingSeeds.length > 0) {
          const referenceBatch = await mapConcurrent(missingSeeds, config.evaluator.repetitionConcurrency ?? 1, (seed, offset) =>
            runAttempt(
              config,
              options.reference!.workspacePath,
              path.join(options.reference!.artifactDir, stage.name),
              options.reference!.experimentId,
              adaptiveReferenceAttempts.length + offset,
              seed,
              stage,
            ));
          adaptiveReferenceAttempts.push(...referenceBatch);
          referenceWorkUsed += stage.budgetRatio * referenceBatch.length;
          const referenceFailure = referenceBatch.find((attempt) => attempt.error);
          if (referenceFailure) {
            return { ok: false, attempts, stages: stageResults, aggregatedMetrics: {}, error: `Adaptive reference evaluation failed: ${referenceFailure.error}`, totalDurationMs: Date.now() - startedAt };
          }
        }
        comparison = comparisonForAttempts(config, adaptiveReferenceAttempts, attempts);
      }

      if (!statisticalPolicy.enabled || !options.reference || comparison?.status !== "inconclusive" || attempts.length >= maximumSeeds) break;
      targetCount = Math.min(maximumSeeds, attempts.length + statisticalPolicy.seedStep, allSeeds.length);
      if (targetCount === attempts.length) break;
    }

    try {
      const aggregatedMetrics = aggregateAttempts(metricDefinitions(config, attempts), attempts);
      const statistics = statisticsForAttempts(attempts, statisticalPolicy.confidenceLevel);
      const isIntermediate = stageIndex < stages.length - 1;
      const pruned = Boolean(isIntermediate && stage.pruneIfClearlyWorse && comparison?.status === "regression");
      const stageResult: EvaluationStageResult = {
        name: stage.name,
        budgetRatio: stage.budgetRatio,
        ok: true,
        attempts,
        aggregatedMetrics,
        statistics,
        ...(comparison ? { comparison } : {}),
        pruned,
      };
      stageResults.push(stageResult);
      await options.onStage?.(stageResult);
      if (pruned) {
        const used = stageResults.reduce((sum, item) => sum + item.budgetRatio * item.attempts.length, 0) + referenceWorkUsed;
        return {
          ok: true,
          pruned: true,
          attempts,
          stages: stageResults,
          aggregatedMetrics,
          statistics,
          ...(comparison ? { statisticalComparison: comparison } : {}),
          totalDurationMs: Date.now() - startedAt,
          computeSavedRatio: Math.max(0, 1 - used / Math.max(plannedWork, Number.EPSILON)),
        };
      }
    } catch (error) {
      return { ok: false, attempts, stages: stageResults, aggregatedMetrics: {}, error: error instanceof Error ? error.message : String(error), totalDurationMs: Date.now() - startedAt };
    }
  }

  const finalStage = stageResults.at(-1)!;
  const inconclusive = finalStage.comparison?.status === "inconclusive";
  const usedWork = stageResults.reduce((sum, item) => sum + item.budgetRatio * item.attempts.length, 0) + referenceWorkUsed;
  return {
    ok: true,
    attempts: finalStage.attempts,
    stages: stageResults,
    aggregatedMetrics: finalStage.aggregatedMetrics,
    statistics: finalStage.statistics,
    ...(finalStage.comparison ? { statisticalComparison: finalStage.comparison } : {}),
    ...(inconclusive ? { inconclusive: true } : {}),
    totalDurationMs: Date.now() - startedAt,
    computeSavedRatio: Math.max(0, 1 - usedWork / Math.max(plannedWork, Number.EPSILON)),
  };
}
