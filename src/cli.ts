#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { AutoresearchHarness } from "./harness.js";
import { PiResearcher, resolveAgentSelection } from "./pi-researcher.js";
import { regenerateReport } from "./report.js";
import { migrateResearchMemory } from "./research-memory.js";
import { getAgentSkill, listAgentSkills, renderAllAgentSkills } from "./skills.js";
import { isExecutableAvailable } from "./workspace.js";
import type { RunState } from "./types.js";

function usage(): never {
  console.error(`Usage:
  ml-autoresearch run [config.json] [--max-experiments N] [--max-wall-time-minutes N] [--model PROVIDER/MODEL] [--thinking-level LEVEL]
  ml-autoresearch validate [config.json] [--max-experiments N] [--max-wall-time-minutes N] [--model PROVIDER/MODEL] [--thinking-level LEVEL]
  ml-autoresearch status <run-directory>
  ml-autoresearch report <run-directory>
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
  const flagsWithValues = new Set(["--max-experiments", "--max-wall-time-minutes", "--model", "--thinking-level", "--reasoning"]);
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
    const memory = state.researchMemory ? migrateResearchMemory(state.researchMemory) : undefined;
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
      pairedEvaluations: state.experiments.filter((experiment) => experiment.pairedEvaluation).length,
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

  if (command !== "run" && command !== "validate") usage();
  const positional = configPathArgument(args);
  const configPath = path.resolve(positional ?? "autoresearch.config.json");
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
  const agentSelection = await resolveAgentSelection(config.agent);
  if (agentSelection.resolvedModel) config.agent.model = agentSelection.resolvedModel;
  config.agent.thinkingLevel = agentSelection.thinkingLevel;
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
    console.log(`Primary metric: ${config.metrics.primary.name} (${config.metrics.primary.direction})`);
    console.log(`Experiment budget: ${config.budget.maxExperiments}`);
    console.log(`Wall-time budget: ${config.budget.maxWallTimeMinutes === 0 ? "unlimited" : `${config.budget.maxWallTimeMinutes} minutes`}`);
    console.log(`Agent model: ${agentSelection.resolvedModel ?? "Pi default"}`);
    console.log(`Agent reasoning/thinking level: ${agentSelection.thinkingLevel}`);
    console.log(`Agent paired comparisons: ${config.evaluator.agentRequests?.allowPairedComparison ? `enabled (max ${config.evaluator.agentRequests.maxSeeds} fresh seeds)` : "disabled"}`);
    console.log(`Learning frontier: beam=${config.learning.beamWidth}, per-category=${config.learning.maxFrontierPerCategory}, depth=${config.learning.maxBranchDepth}, temporary regression=${config.learning.maxTemporaryRegressionRatio}`);
    console.log(`Learning strategy: ${JSON.stringify(config.learning.strategy)}`);
    console.log(`Human-approved lessons: ${config.learning.humanLessons.length}`);
    return;
  }

  const abortController = new AbortController();
  const interrupt = () => {
    console.error("\nInterruption requested; the harness will stop at the next safe boundary.");
    abortController.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const harness = new AutoresearchHarness(
      config,
      async (workspacePath, experimentDir) => new PiResearcher(config, workspacePath, experimentDir),
    );
    const state = await harness.run({
      configPath,
      signal: abortController.signal,
      onProgress: (message) => console.log(`[autoresearch] ${message}`),
    });
    console.log(`Report: ${path.join(state.runDir, "REPORT.md")}`);
    if (state.status === "failed") {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
