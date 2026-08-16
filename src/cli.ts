#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { AutoresearchHarness } from "./harness.js";
import { PiResearcher, resolveAgentSelection } from "./pi-researcher.js";
import { regenerateReport } from "./report.js";
import { getAgentSkill, listAgentSkills, renderAllAgentSkills } from "./skills.js";
import { isExecutableAvailable } from "./workspace.js";
import { LiveDashboardServer } from "./live-server.js";
import { appendControlCommand, readRunControl, setRunControl, writeRunControl } from "./control.js";
import { calculateCampaignPriority } from "./campaign.js";
import { writeJsonAtomic } from "./io.js";
import { resolveDashboardLifecycle } from "./dashboard-lifecycle.js";
import { relativePercentEfficiency } from "./experiment-accounting.js";
import { createTwoStageShutdownHandler } from "./shutdown.js";
import { killActiveSubprocesses } from "./subprocess-registry.js";
import type { CampaignTicket, RunState } from "./types.js";

function usage(): never {
  console.error(`Usage:
  ml-autoresearch run [config.json] [--max-experiments N] [--max-wall-time-minutes N] [--model PROVIDER/MODEL] [--thinking-level LEVEL] [--ui-port PORT] [--open-ui] [--no-ui]
  ml-autoresearch resume <run-directory> [--max-experiments N] [--max-wall-time-minutes N] [--model PROVIDER/MODEL] [--thinking-level LEVEL] [UI options]
  ml-autoresearch pause <run-directory> [--reason TEXT]
  ml-autoresearch stop <run-directory> [--reason TEXT]
  ml-autoresearch enqueue <run-directory> <hypothesis> [--expected-gain N] [--probability N] [--information-gain N] [--estimated-cost N]
  ml-autoresearch validate [config.json] [--max-experiments N] [--max-wall-time-minutes N] [--model PROVIDER/MODEL] [--thinking-level LEVEL]
  ml-autoresearch status <run-directory>
  ml-autoresearch report <run-directory>
  ml-autoresearch serve <run-directory> [--port PORT] [--open]
  ml-autoresearch skill [list]
  ml-autoresearch skill show <name|all>`);
  process.exit(2);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function configPathArgument(args: string[]): string | undefined {
  const flagsWithValues = new Set(["--max-experiments", "--max-wall-time-minutes", "--model", "--thinking-level", "--reasoning", "--ui-port"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (flagsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return argument;
  }
  return undefined;
}

function positionalArgument(args: string[], flagsWithValues: Set<string>): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (flagsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return argument;
  }
  return undefined;
}

function portValue(raw: string | undefined, flag: string): number {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${flag} must be an integer between 0 and 65535 (0 selects a random free port)`);
  }
  return parsed;
}

function openUrl(url: string): void {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch (error) {
    console.error(`Could not open the dashboard automatically: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stopActiveSegmentForDeadRun(state: RunState, activeUntil: string): void {
  if (!state.activeSegmentStartedAt) return;
  const elapsed = Date.parse(activeUntil) - Date.parse(state.activeSegmentStartedAt);
  state.activeDurationMs = (state.activeDurationMs ?? 0) + Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  delete state.activeSegmentStartedAt;
}

async function finalizeDeadRunControl(
  runDir: string,
  state: RunState,
  desiredState: "paused" | "stopped",
  control: Awaited<ReturnType<typeof setRunControl>>,
  reason: string | undefined,
): Promise<Awaited<ReturnType<typeof writeRunControl>>> {
  const now = new Date().toISOString();
  const lastKnownActiveAt = control.heartbeatAt ?? now;
  delete control.ownerPid;
  delete control.heartbeatAt;
  const terminalControl = await writeRunControl(runDir, control);
  state.control = terminalControl;
  if (desiredState === "stopped") {
    if (state.status !== "completed" && state.status !== "failed") state.status = "stopped";
    state.stopReason = reason ?? state.stopReason ?? "Stopped by user command";
    stopActiveSegmentForDeadRun(state, lastKnownActiveAt);
    state.finishedAt ??= now;
  } else if (state.status === "running" || state.status === "interrupted") {
    state.status = "paused";
    delete state.stopReason;
    stopActiveSegmentForDeadRun(state, lastKnownActiveAt);
  }
  await writeJsonAtomic(path.join(runDir, "state.json"), state);
  return terminalControl;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") usage();

  if (command === "report") {
    const runDir = args[0];
    if (!runDir) usage();
    console.log(await regenerateReport(runDir));
    return;
  }

  if (command === "status") {
    const runDir = args[0];
    if (!runDir) usage();
    const state = JSON.parse(await readFile(path.join(path.resolve(runDir), "state.json"), "utf8")) as RunState;
    const memory = state.researchMemory;
    const improved = state.experiments
      .map((experiment) => ({ experiment, efficiency: relativePercentEfficiency(experiment.accounting) }))
      .filter((entry) => entry.efficiency.costPerImprovementUsd !== null && entry.efficiency.timePerImprovementMs !== null);
    const bestCostEfficiency = [...improved].sort((left, right) => left.efficiency.costPerImprovementUsd! - right.efficiency.costPerImprovementUsd!)[0];
    const bestTimeEfficiency = [...improved].sort((left, right) => left.efficiency.timePerImprovementMs! - right.efficiency.timePerImprovementMs!)[0];
    console.log(JSON.stringify({
      runId: state.runId,
      status: state.status,
      experiments: state.experiments.length,
      acceptedMetrics: state.acceptedMetrics,
      acceptedWorkspacePath: state.acceptedWorkspacePath,
      bestObserved: state.bestObserved ?? null,
      agent: state.agent ?? null,
      leaderId: state.researchGraph?.leaderId ?? null,
      frontierIds: state.researchGraph?.frontierIds ?? [],
      paretoFrontierIds: state.researchGraph?.paretoFrontierIds ?? [],
      bestByObjective: state.bestByObjective ?? {},
      control: state.control ?? null,
      campaign: state.campaign ? Object.fromEntries(["queued", "running", "completed", "cancelled", "blocked"].map((status) => [status, state.campaign!.tickets.filter((ticket) => ticket.status === status).length])) : null,
      activeDurationMs: state.activeDurationMs ?? null,
      pairedEvaluations: state.experiments.filter((experiment) => experiment.pairedEvaluation).length,
      economics: {
        totalAgentCostUsd: state.experiments.reduce((total, experiment) => total + experiment.accounting.agentUsage.costUsd, 0),
        totalAgentTokens: state.experiments.reduce((total, experiment) => total + experiment.accounting.agentUsage.totalTokens, 0),
        totalExperimentDurationMs: state.experiments.reduce((total, experiment) => total + experiment.accounting.durationMs, 0),
        bestCostPerRelativePercent: bestCostEfficiency
          ? { experimentId: bestCostEfficiency.experiment.id, usdPerRelativePercentagePoint: bestCostEfficiency.efficiency.costPerImprovementUsd }
          : null,
        bestTimePerRelativePercent: bestTimeEfficiency
          ? { experimentId: bestTimeEfficiency.experiment.id, millisecondsPerRelativePercentagePoint: bestTimeEfficiency.efficiency.timePerImprovementMs }
          : null,
      },
      researchMemory: memory ? {
        facts: memory.facts.length,
        notes: memory.notes.length,
        lessons: memory.lessons.length,
        questions: Object.fromEntries(["open", "resolved", "invalidated"].map((status) => [status, memory.questions.filter((question) => question.status === status).length])),
        evidenceReviews: memory.evidenceReviews.length,
      } : null,
      stopReason: state.stopReason ?? null,
    }, null, 2));
    return;
  }

  if (command === "pause" || command === "stop") {
    const runDir = positionalArgument(args, new Set(["--reason"]));
    if (!runDir) usage();
    const reason = valueAfter(args, "--reason");
    const resolvedRunDir = path.resolve(runDir);
    const state = JSON.parse(await readFile(path.join(resolvedRunDir, "state.json"), "utf8")) as RunState;
    if (state.schemaVersion !== 6) throw new Error("Only future schemaVersion 6 runs support pause/stop control");
    if (["completed", "failed", "stopped"].includes(state.status)) {
      throw new Error(`Cannot ${command} terminal ${state.status} run ${state.runId}`);
    }
    const previous = await readRunControl(resolvedRunDir);
    const ownerAlive = processIsAlive(previous.ownerPid);
    const control = await setRunControl(resolvedRunDir, command === "pause" ? "paused" : "stopped", reason);
    const effectiveControl = ownerAlive
      ? control
      : await finalizeDeadRunControl(resolvedRunDir, state, command === "pause" ? "paused" : "stopped", control, reason);
    console.log(`${command === "pause" ? "Pause" : "Stop"} ${ownerAlive ? "requested at the next safe experiment boundary" : "recorded for the inactive run"}: ${resolvedRunDir}`);
    console.log(JSON.stringify(effectiveControl, null, 2));
    return;
  }

  if (command === "enqueue") {
    const runDir = args[0];
    const hypothesis = args[1];
    if (!runDir || !hypothesis || hypothesis.startsWith("--")) usage();
    const resolvedRunDir = path.resolve(runDir);
    const state = JSON.parse(await readFile(path.join(resolvedRunDir, "state.json"), "utf8")) as RunState;
    if (["completed", "stopped"].includes(state.status)) throw new Error(`Cannot enqueue work into ${state.status} run ${state.runId}`);
    const numeric = (flag: string, fallback: number): number => {
      const raw = valueAfter(args, flag);
      if (raw === undefined) return fallback;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a finite number >= 0`);
      return value;
    };
    const expectedGain = numeric("--expected-gain", 0);
    const probabilityOfSuccess = numeric("--probability", 0.5);
    const informationGain = numeric("--information-gain", 0.5);
    const estimatedCost = numeric("--estimated-cost", 1);
    if (probabilityOfSuccess > 1 || informationGain > 1) throw new Error("--probability and --information-gain must be between 0 and 1");
    const now = new Date().toISOString();
    const ticket: CampaignTicket = {
      id: `human-${randomUUID()}`,
      kind: "hypothesis",
      hypothesis,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      createdBy: "human",
      dependencies: [],
      expectedGain,
      probabilityOfSuccess,
      informationGain,
      estimatedCost,
      priority: calculateCampaignPriority({ expectedGain, probability: probabilityOfSuccess, informationGain, estimatedCost }),
    };
    await appendControlCommand(resolvedRunDir, { id: randomUUID(), type: "enqueue", createdAt: now, ticket });
    console.log(`Queued human hypothesis ${ticket.id}: ${ticket.hypothesis}`);
    return;
  }

  if (command === "resume") {
    const runDir = positionalArgument(args, new Set(["--max-experiments", "--max-wall-time-minutes", "--model", "--thinking-level", "--reasoning", "--ui-port"]));
    if (!runDir) usage();
    const resolvedRunDir = path.resolve(runDir);
    const state = JSON.parse(await readFile(path.join(resolvedRunDir, "state.json"), "utf8")) as RunState;
    const control = await readRunControl(resolvedRunDir);
    if (state.status === "stopped" || (control.desiredState === "stopped" && !["interrupted", "failed", "paused"].includes(state.status))) {
      throw new Error(`Run ${state.runId} was stopped and cannot be resumed`);
    }
    if (processIsAlive(control.ownerPid)) {
      if (state.status === "paused" || control.desiredState === "paused") {
        await setRunControl(resolvedRunDir, "running", "Resumed by CLI");
        console.log(`Resume signal delivered to active run ${state.runId} (pid ${control.ownerPid})`);
        return;
      }
      throw new Error(`Run ${state.runId} already has an active harness process (pid ${control.ownerPid})`);
    }
  }

  if (command === "serve") {
    const runDir = positionalArgument(args, new Set(["--port"]));
    if (!runDir) usage();
    const dashboard = new LiveDashboardServer({
      runDir: path.resolve(runDir),
      watchRunDir: true,
      port: portValue(valueAfter(args, "--port"), "--port"),
    });
    await dashboard.start();
    console.log(`Dashboard: ${dashboard.url}`);
    console.log("Press Ctrl+C to stop the dashboard server.");
    if (args.includes("--open")) openUrl(dashboard.url);
    try {
      await waitForShutdownSignal();
    } finally {
      dashboard.stop();
    }
    return;
  }

  if (command === "skill") {
    const action = args[0] ?? "list";
    if (action === "list") {
      console.log("Available agent skills:\n");
      for (const skill of listAgentSkills()) {
        console.log(`${skill.name}\n  ${skill.summary}`);
      }
      console.log("\nShow one with: ml-autoresearch skill show <name>");
      return;
    }
    if (action !== "show") usage();
    const name = args[1];
    if (!name) throw new Error("skill show requires a skill name or all");
    if (name === "all") {
      console.log(renderAllAgentSkills());
      return;
    }
    const skill = getAgentSkill(name);
    if (!skill) {
      throw new Error(`Unknown skill: ${name}. Run 'ml-autoresearch skill list' to see available skills.`);
    }
    console.log(skill.content.trim());
    return;
  }

  if (command !== "run" && command !== "resume" && command !== "validate") usage();
  const positional = configPathArgument(args);
  const resumeRunDir = command === "resume" ? path.resolve(positional ?? "") : undefined;
  if (command === "resume" && !positional) usage();
  const configPath = command === "resume"
    ? path.join(resumeRunDir!, "config.resolved.json")
    : path.resolve(positional ?? "autoresearch.config.json");
  const config = await loadConfig(configPath);
  const maxExperimentsRaw = valueAfter(args, "--max-experiments");
  if (maxExperimentsRaw !== undefined) {
    const parsed = Number(maxExperimentsRaw);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--max-experiments must be a positive integer");
    config.budget.maxExperiments = parsed;
  }
  const maxWallTimeRaw = valueAfter(args, "--max-wall-time-minutes");
  if (maxWallTimeRaw !== undefined) {
    const parsed = Number(maxWallTimeRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error("--max-wall-time-minutes must be a finite number >= 0 (0 means unlimited)");
    }
    config.budget.maxWallTimeMinutes = parsed;
  }
  const modelRaw = valueAfter(args, "--model");
  if (modelRaw !== undefined) config.agent.model = modelRaw;
  const thinkingRaw = valueAfter(args, "--thinking-level");
  const reasoningRaw = valueAfter(args, "--reasoning");
  if (thinkingRaw !== undefined && reasoningRaw !== undefined) {
    throw new Error("Use either --thinking-level or --reasoning, not both");
  }
  const thinkingOverride = thinkingRaw ?? reasoningRaw;
  if (thinkingOverride !== undefined) {
    const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!levels.has(thinkingOverride)) throw new Error("--thinking-level/--reasoning must be off, minimal, low, medium, high, xhigh, or max");
    config.agent.thinkingLevel = thinkingOverride as typeof config.agent.thinkingLevel;
  }
  if (modelRaw !== undefined || thinkingOverride !== undefined) {
    config.agent.pool = [{
      id: "cli-override",
      ...(config.agent.model ? { model: config.agent.model } : {}),
      thinkingLevel: config.agent.thinkingLevel,
    }];
  }
  const agentSelection = await resolveAgentSelection(config.agent);
  if (agentSelection.resolvedModel) config.agent.model = agentSelection.resolvedModel;
  config.agent.thinkingLevel = agentSelection.thinkingLevel;
  if (config.agent.pool?.length) {
    config.agent.pool = await Promise.all(config.agent.pool.map(async (profile) => {
      const resolved = await resolveAgentSelection(profile);
      return { ...profile, ...(resolved.resolvedModel ? { model: resolved.resolvedModel } : {}), thinkingLevel: resolved.thinkingLevel };
    }));
  }
  if (config.agent.roles) {
    for (const [role, profile] of Object.entries(config.agent.roles)) {
      if (!profile) continue;
      const resolved = await resolveAgentSelection(profile);
      config.agent.roles[role as keyof typeof config.agent.roles] = {
        ...profile,
        ...(resolved.resolvedModel ? { model: resolved.resolvedModel } : {}),
        thinkingLevel: resolved.thinkingLevel,
      };
    }
  }
  const runnerExecutable = config.evaluator.runner.mode === "docker" ? "docker" : config.evaluator.command[0]!;
  if (!await isExecutableAvailable(runnerExecutable)) {
    throw new Error(`Evaluator runner is not available on PATH: ${runnerExecutable}`);
  }
  if (command === "validate") {
    console.log(`Configuration is valid: ${configPath}`);
    console.log(`Project: ${config.project.sourceDir}`);
    console.log(`Mutable paths: ${config.project.mutablePaths.join(", ")}`);
    console.log(`Evaluator: ${config.evaluator.command.join(" ")}`);
    console.log(`Runner: ${config.evaluator.runner.mode}${config.evaluator.runner.image ? ` (${config.evaluator.runner.image})` : ""}`);
    console.log(`Primary metric: ${config.metrics.primary.name} (${config.metrics.primary.direction}, ${config.metrics.primary.format ?? "number"})`);
    console.log(`Experiment budget: ${config.budget.maxExperiments}`);
    console.log(`Wall-time budget: ${config.budget.maxWallTimeMinutes === 0 ? "unlimited" : `${config.budget.maxWallTimeMinutes} minutes`}`);
    console.log(`Agent model: ${agentSelection.resolvedModel ?? "Pi default"}`);
    console.log(`Agent reasoning/thinking level: ${agentSelection.thinkingLevel}`);
    console.log(`Implementer pool: ${config.agent.pool?.length ? config.agent.pool.map((profile) => `${profile.id}=${profile.model ?? "Pi default"}/${profile.thinkingLevel}`).join(", ") : "default agent"}`);
    console.log(`Independent reviewer: ${config.agent.roles?.reviewer ? `${config.agent.roles.reviewer.model ?? "Pi default"}/${config.agent.roles.reviewer.thinkingLevel}` : "disabled"}`);
    console.log(`Agent paired comparisons: ${config.evaluator.agentRequests?.allowPairedComparison ? `enabled (max ${config.evaluator.agentRequests.maxSeeds} fresh seeds)` : "disabled"}`);
    console.log(`Evaluation stages: ${(config.evaluator.stages ?? []).map((stage) => `${stage.name}@${stage.budgetRatio}`).join(", ") || "canonical@1"}`);
    console.log(`Adaptive statistics: ${config.evaluator.statistics?.enabled ? `enabled (${config.evaluator.statistics.minimumSeeds}-${config.evaluator.statistics.maximumSeeds} seeds, confidence=${config.evaluator.statistics.confidenceLevel})` : "disabled"}`);
    console.log(`Objectives/Pareto: ${config.metrics.pareto?.enabled ? (config.metrics.objectives ?? []).map((objective) => objective.name).join(", ") || config.metrics.primary.name : "disabled"}`);
    console.log(`Campaign: ${config.learning.campaign?.enabled ? "enabled" : "disabled"}; meta-research: ${config.learning.meta?.enabled ? "enabled" : "disabled"}; project knowledge: ${config.knowledge?.enabled ? config.knowledge.path : "disabled"}`);
    console.log(`Search space: ${config.search?.enabled ? `${config.search.parameters.length} parameters` : "disabled"}; experiment concurrency: ${config.execution?.experimentConcurrency ?? 1}`);
    console.log(`Learning frontier: beam=${config.learning.beamWidth}, per-category=${config.learning.maxFrontierPerCategory}, depth=${config.learning.maxBranchDepth}, temporary regression=${config.learning.maxTemporaryRegressionRatio}`);
    console.log(`Learning strategy: ${JSON.stringify(config.learning.strategy)}`);
    console.log(`Human-approved lessons: ${config.learning.humanLessons.length}`);
    return;
  }

  const dashboardLifecycle = resolveDashboardLifecycle(args);
  const dashboard = dashboardLifecycle.enabled
    ? new LiveDashboardServer({ port: portValue(valueAfter(args, "--ui-port"), "--ui-port"), watchRunDir: true })
    : undefined;
  const abortController = new AbortController();
  const shutdown = createTwoStageShutdownHandler({
    onInterrupt: () => {
      console.error("\nInterruption requested; the harness will stop at the next safe boundary. Press Ctrl+C again to force shutdown.");
      abortController.abort();
    },
    onForce: (signal) => {
      const killed = killActiveSubprocesses("SIGKILL");
      console.error(`\nForced shutdown requested; killed ${killed} active subprocess group${killed === 1 ? "" : "s"}.`);
      dashboard?.stop();
      process.exit(signal === "SIGINT" ? 130 : 143);
    },
  });
  const interrupt = () => shutdown("SIGINT");
  const terminate = () => shutdown("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (dashboard) {
      await dashboard.start();
      console.log(`Dashboard: ${dashboard.url}`);
      if (args.includes("--open-ui")) openUrl(dashboard.url);
    }
    const harness = new AutoresearchHarness(
      config,
      async (workspacePath, experimentDir, profile) => new PiResearcher(config, workspacePath, experimentDir, profile),
    );
    const state = await harness.run({
      configPath,
      ...(resumeRunDir ? { resumeRunDir } : {}),
      signal: abortController.signal,
      onProgress: (message) => {
        dashboard?.publishProgress(message);
        if (!dashboard) console.log(`[autoresearch] ${message}`);
      },
      onState: (nextState) => dashboard?.publishState(nextState),
    });
    console.log(`Report: ${path.join(state.runDir, "REPORT.md")}`);
    if (state.status === "failed") {
      process.exitCode = 1;
    }
    if (dashboard && dashboardLifecycle.keepOpenAfterRun) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      console.log(`Research ${state.status}; dashboard remains available at ${dashboard.url}. Press Ctrl+C to close the application.`);
      await waitForShutdownSignal();
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    dashboard?.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
