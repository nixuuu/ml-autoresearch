import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Aggregation, Direction, HarnessConfig, LessonGuidance, ThinkingLevel } from "./types.js";
import { isPathMatched } from "./workspace.js";

const DIRECTIONS = new Set<Direction>(["minimize", "maximize"]);
const AGGREGATIONS = new Set<Aggregation>(["mean", "median", "min", "max"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const LESSON_GUIDANCE = new Set<LessonGuidance>(["consider", "avoid", "verify"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} must be a finite number >= ${minimum}`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  const parsed = number(value, label, minimum);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function rate(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (parsed > 1) throw new Error(`${label} must be <= 1`);
  return parsed;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function direction(value: unknown, label: string): Direction {
  if (!DIRECTIONS.has(value as Direction)) throw new Error(`${label} must be minimize or maximize`);
  return value as Direction;
}

function aggregation(value: unknown, label: string): Aggregation {
  if (!AGGREGATIONS.has(value as Aggregation)) throw new Error(`${label} must be mean, median, min, or max`);
  return value as Aggregation;
}

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const raw = object(JSON.parse(await readFile(absoluteConfigPath, "utf8")) as unknown, "config");
  if (raw.version !== 1) throw new Error("config.version must be 1");

  const project = object(raw.project, "project");
  const agent = object(raw.agent ?? {}, "agent");
  const evaluator = object(raw.evaluator, "evaluator");
  const agentRequests = object(evaluator.agentRequests ?? {}, "evaluator.agentRequests");
  const runner = object(evaluator.runner ?? { mode: "local" }, "evaluator.runner");
  const metrics = object(raw.metrics, "metrics");
  const primary = object(metrics.primary, "metrics.primary");
  const budget = object(raw.budget, "budget");
  const learning = object(raw.learning ?? {}, "learning");
  const strategy = object(learning.strategy ?? {}, "learning.strategy");

  const command = strings(evaluator.command, "evaluator.command");
  if (command.length === 0) throw new Error("evaluator.command cannot be empty");

  const guardrailsRaw = metrics.guardrails ?? [];
  if (!Array.isArray(guardrailsRaw)) throw new Error("metrics.guardrails must be an array");
  const humanLessonsRaw = learning.humanLessons ?? [];
  if (!Array.isArray(humanLessonsRaw)) throw new Error("learning.humanLessons must be an array");

  const explorationRate = rate(strategy.explorationRate ?? 0.25, "learning.strategy.explorationRate");
  const backtrackRate = rate(strategy.backtrackRate ?? 0.1, "learning.strategy.backtrackRate");
  const replicationRate = rate(strategy.replicationRate ?? 0.1, "learning.strategy.replicationRate");
  const falsificationRate = rate(strategy.falsificationRate ?? 0.1, "learning.strategy.falsificationRate");
  if (explorationRate + backtrackRate + replicationRate + falsificationRate > 1) {
    throw new Error("learning strategy rates must sum to <= 1");
  }

  const config: HarnessConfig = {
    version: 1,
    name: string(raw.name, "name"),
    project: {
      sourceDir: path.resolve(configDir, string(project.sourceDir, "project.sourceDir")),
      mutablePaths: strings(project.mutablePaths, "project.mutablePaths"),
      protectedPaths: strings(project.protectedPaths ?? [], "project.protectedPaths"),
      hiddenPaths: strings(project.hiddenPaths ?? [], "project.hiddenPaths"),
      copyIgnore: strings(project.copyIgnore ?? [], "project.copyIgnore"),
    },
    agent: {
      thinkingLevel: (agent.thinkingLevel ?? "high") as ThinkingLevel,
      ...(agent.model === undefined ? {} : { model: string(agent.model, "agent.model") }),
      ...(agent.systemPrompt === undefined ? {} : { systemPrompt: string(agent.systemPrompt, "agent.systemPrompt") }),
    },
    evaluator: {
      command,
      timeoutSeconds: integer(evaluator.timeoutSeconds ?? 600, "evaluator.timeoutSeconds", 1),
      repetitions: integer(evaluator.repetitions ?? 1, "evaluator.repetitions", 1),
      seeds: Array.isArray(evaluator.seeds)
        ? evaluator.seeds.map((seed, index) => integer(seed, `evaluator.seeds[${index}]`))
        : [17, 29, 43],
      inheritEnv: strings(evaluator.inheritEnv ?? ["PATH", "HOME", "TMPDIR", "VIRTUAL_ENV", "CUDA_VISIBLE_DEVICES"], "evaluator.inheritEnv"),
      env: Object.fromEntries(
        Object.entries(object(evaluator.env ?? {}, "evaluator.env")).map(([key, value]) => [key, string(value, `evaluator.env.${key}`)]),
      ),
      agentRequests: {
        allowPairedComparison: agentRequests.allowPairedComparison === undefined
          ? false
          : boolean(agentRequests.allowPairedComparison, "evaluator.agentRequests.allowPairedComparison"),
        maxSeeds: integer(agentRequests.maxSeeds ?? 5, "evaluator.agentRequests.maxSeeds", 1),
      },
      runner: {
        mode: (runner.mode ?? "local") as "local" | "docker",
        ...(runner.image === undefined ? {} : { image: string(runner.image, "evaluator.runner.image") }),
        ...(runner.cpus === undefined ? {} : { cpus: number(runner.cpus, "evaluator.runner.cpus", 0.1) }),
        ...(runner.memory === undefined ? {} : { memory: string(runner.memory, "evaluator.runner.memory") }),
        network: runner.network === undefined ? "none" : string(runner.network, "evaluator.runner.network"),
        ...(runner.gpus === undefined ? {} : { gpus: string(runner.gpus, "evaluator.runner.gpus") }),
        readOnlyRoot: runner.readOnlyRoot === undefined ? true : boolean(runner.readOnlyRoot, "evaluator.runner.readOnlyRoot"),
        pidsLimit: integer(runner.pidsLimit ?? 512, "evaluator.runner.pidsLimit", 16),
      },
    },
    metrics: {
      primary: {
        name: string(primary.name, "metrics.primary.name"),
        direction: direction(primary.direction, "metrics.primary.direction"),
        minimumDelta: number(primary.minimumDelta ?? 0, "metrics.primary.minimumDelta"),
        aggregation: aggregation(primary.aggregation ?? "median", "metrics.primary.aggregation"),
      },
      guardrails: guardrailsRaw.map((entry, index) => {
        const rule = object(entry, `metrics.guardrails[${index}]`);
        return {
          name: string(rule.name, `metrics.guardrails[${index}].name`),
          direction: direction(rule.direction, `metrics.guardrails[${index}].direction`),
          aggregation: aggregation(rule.aggregation ?? "median", `metrics.guardrails[${index}].aggregation`),
          ...(rule.maxRegression === undefined ? {} : { maxRegression: number(rule.maxRegression, `metrics.guardrails[${index}].maxRegression`) }),
          ...(rule.min === undefined ? {} : { min: number(rule.min, `metrics.guardrails[${index}].min`, -Infinity) }),
          ...(rule.max === undefined ? {} : { max: number(rule.max, `metrics.guardrails[${index}].max`, -Infinity) }),
        };
      }),
    },
    budget: {
      maxExperiments: integer(budget.maxExperiments ?? 20, "budget.maxExperiments", 1),
      maxWallTimeMinutes: number(budget.maxWallTimeMinutes ?? 480, "budget.maxWallTimeMinutes", 0),
      maxConsecutiveFailures: integer(budget.maxConsecutiveFailures ?? 3, "budget.maxConsecutiveFailures", 1),
    },
    learning: {
      beamWidth: integer(learning.beamWidth ?? 3, "learning.beamWidth", 1),
      maxBranchDepth: integer(learning.maxBranchDepth ?? 3, "learning.maxBranchDepth", 1),
      maxTemporaryRegressionRatio: rate(learning.maxTemporaryRegressionRatio ?? 0.05, "learning.maxTemporaryRegressionRatio"),
      recentExperiments: integer(learning.recentExperiments ?? 12, "learning.recentExperiments", 1),
      maxContextLessons: integer(learning.maxContextLessons ?? 40, "learning.maxContextLessons", 1),
      supportThreshold: integer(learning.supportThreshold ?? 2, "learning.supportThreshold", 1),
      contradictionThreshold: integer(learning.contradictionThreshold ?? 1, "learning.contradictionThreshold", 1),
      maxFrontierPerCategory: integer(learning.maxFrontierPerCategory ?? 1, "learning.maxFrontierPerCategory", 1),
      strategy: { explorationRate, backtrackRate, replicationRate, falsificationRate },
      humanLessons: humanLessonsRaw.map((entry, index) => {
        const lesson = object(entry, `learning.humanLessons[${index}]`);
        const guidance = (lesson.guidance ?? "consider") as LessonGuidance;
        if (!LESSON_GUIDANCE.has(guidance)) {
          throw new Error(`learning.humanLessons[${index}].guidance must be consider, avoid, or verify`);
        }
        return {
          id: string(lesson.id ?? `human-${index + 1}`, `learning.humanLessons[${index}].id`),
          claim: string(lesson.claim, `learning.humanLessons[${index}].claim`),
          guidance,
        };
      }),
    },
    outputDir: path.resolve(configDir, string(raw.outputDir ?? "runs", "outputDir")),
    researchInstructions: string(raw.researchInstructions, "researchInstructions"),
  };

  if (!THINKING_LEVELS.has(config.agent.thinkingLevel)) throw new Error("agent.thinkingLevel is invalid");
  if (config.evaluator.runner.mode !== "local" && config.evaluator.runner.mode !== "docker") {
    throw new Error("evaluator.runner.mode must be local or docker");
  }
  if (config.evaluator.runner.mode === "docker" && !config.evaluator.runner.image) {
    throw new Error("evaluator.runner.image is required in docker mode");
  }
  if (config.project.mutablePaths.length === 0) throw new Error("project.mutablePaths cannot be empty");
  const hiddenMutable = config.project.hiddenPaths.filter((hiddenPath) => isPathMatched(hiddenPath, config.project.mutablePaths));
  if (hiddenMutable.length > 0) throw new Error(`project.hiddenPaths cannot also be mutable: ${hiddenMutable.join(", ")}`);
  if (config.evaluator.seeds.length < config.evaluator.repetitions) {
    throw new Error("evaluator.seeds must contain at least evaluator.repetitions values");
  }
  if (new Set(config.learning.humanLessons.map((lesson) => lesson.id)).size !== config.learning.humanLessons.length) {
    throw new Error("learning.humanLessons ids must be unique");
  }
  return config;
}
