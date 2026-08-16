import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentProfileConfig,
  AgentRole,
  Aggregation,
  Direction,
  HarnessConfig,
  LessonGuidance,
  SearchParameterConfig,
  ThinkingLevel,
} from "./types.js";
import { isPathMatched } from "./workspace.js";

const DIRECTIONS = new Set<Direction>(["minimize", "maximize"]);
const AGGREGATIONS = new Set<Aggregation>(["mean", "median", "min", "max"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const LESSON_GUIDANCE = new Set<LessonGuidance>(["consider", "avoid", "verify"]);
const AGENT_ROLES = new Set<AgentRole>(["implementer", "reviewer"]);
const SEARCH_PARAMETER_TYPES = new Set<SearchParameterConfig["type"]>(["float", "integer", "categorical", "boolean"]);

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

function agentProfile(
  value: unknown,
  label: string,
  fallback: { model?: string; thinkingLevel: ThinkingLevel },
  fallbackId: string,
): AgentProfileConfig {
  const raw = object(value, label);
  const thinkingLevel = (raw.thinkingLevel ?? fallback.thinkingLevel) as ThinkingLevel;
  if (!THINKING_LEVELS.has(thinkingLevel)) throw new Error(`${label}.thinkingLevel is invalid`);
  const model = raw.model === undefined ? fallback.model : string(raw.model, `${label}.model`);
  return {
    id: string(raw.id ?? fallbackId, `${label}.id`),
    ...(model ? { model } : {}),
    thinkingLevel,
    ...(raw.systemPrompt === undefined ? {} : { systemPrompt: string(raw.systemPrompt, `${label}.systemPrompt`) }),
  };
}

export async function loadConfig(configPath: string): Promise<HarnessConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const raw = object(JSON.parse(await readFile(absoluteConfigPath, "utf8")) as unknown, "config");
  if (raw.version !== 2) throw new Error("config.version must be 2");

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
  const campaign = object(learning.campaign ?? {}, "learning.campaign");
  const meta = object(learning.meta ?? {}, "learning.meta");
  const statistics = object(evaluator.statistics ?? {}, "evaluator.statistics");
  const pareto = object(metrics.pareto ?? {}, "metrics.pareto");
  const search = object(raw.search ?? {}, "search");
  const execution = object(raw.execution ?? {}, "execution");
  const knowledge = object(raw.knowledge ?? {}, "knowledge");

  const command = strings(evaluator.command, "evaluator.command");
  if (command.length === 0) throw new Error("evaluator.command cannot be empty");

  const guardrailsRaw = metrics.guardrails ?? [];
  if (!Array.isArray(guardrailsRaw)) throw new Error("metrics.guardrails must be an array");
  const humanLessonsRaw = learning.humanLessons ?? [];
  if (!Array.isArray(humanLessonsRaw)) throw new Error("learning.humanLessons must be an array");
  const objectivesRaw = metrics.objectives ?? [];
  if (!Array.isArray(objectivesRaw)) throw new Error("metrics.objectives must be an array");
  const stagesRaw = evaluator.stages ?? [{ name: "canonical", budgetRatio: 1 }];
  if (!Array.isArray(stagesRaw) || stagesRaw.length === 0) throw new Error("evaluator.stages must be a non-empty array");
  const poolRaw = agent.pool ?? [];
  if (!Array.isArray(poolRaw)) throw new Error("agent.pool must be an array");
  const rolesRaw = object(agent.roles ?? {}, "agent.roles");
  const parametersRaw = search.parameters ?? [];
  if (!Array.isArray(parametersRaw)) throw new Error("search.parameters must be an array");

  const explorationRate = rate(strategy.explorationRate ?? 0.25, "learning.strategy.explorationRate");
  const backtrackRate = rate(strategy.backtrackRate ?? 0.1, "learning.strategy.backtrackRate");
  const replicationRate = rate(strategy.replicationRate ?? 0.1, "learning.strategy.replicationRate");
  const falsificationRate = rate(strategy.falsificationRate ?? 0.1, "learning.strategy.falsificationRate");
  const optimizeRate = rate(strategy.optimizeRate ?? 0.1, "learning.strategy.optimizeRate");
  const mergeRate = rate(strategy.mergeRate ?? 0.05, "learning.strategy.mergeRate");
  const ablationRate = rate(strategy.ablationRate ?? 0.05, "learning.strategy.ablationRate");
  if (explorationRate + backtrackRate + replicationRate + falsificationRate + optimizeRate + mergeRate + ablationRate > 1) {
    throw new Error("learning strategy rates must sum to <= 1");
  }

  const baseAgent = {
    ...(agent.model === undefined ? {} : { model: string(agent.model, "agent.model") }),
    thinkingLevel: (agent.thinkingLevel ?? "high") as ThinkingLevel,
  };
  if (!THINKING_LEVELS.has(baseAgent.thinkingLevel)) throw new Error("agent.thinkingLevel is invalid");
  const roleProfiles = Object.fromEntries(Object.entries(rolesRaw).map(([role, value]) => {
    if (!AGENT_ROLES.has(role as AgentRole)) throw new Error(`agent.roles contains unknown role ${role}`);
    return [role, agentProfile(value, `agent.roles.${role}`, baseAgent, role)];
  })) as NonNullable<HarnessConfig["agent"]["roles"]>;

  const repetitions = integer(evaluator.repetitions ?? 1, "evaluator.repetitions", 1);
  const evaluatorSeeds = Array.isArray(evaluator.seeds)
    ? evaluator.seeds.map((seed, index) => integer(seed, `evaluator.seeds[${index}]`))
    : [17, 29, 43];

  const config: HarnessConfig = {
    version: 2,
    name: string(raw.name, "name"),
    project: {
      sourceDir: path.resolve(configDir, string(project.sourceDir, "project.sourceDir")),
      mutablePaths: strings(project.mutablePaths, "project.mutablePaths"),
      protectedPaths: strings(project.protectedPaths ?? [], "project.protectedPaths"),
      hiddenPaths: strings(project.hiddenPaths ?? [], "project.hiddenPaths"),
      copyIgnore: strings(project.copyIgnore ?? [], "project.copyIgnore"),
    },
    agent: {
      ...baseAgent,
      ...(agent.systemPrompt === undefined ? {} : { systemPrompt: string(agent.systemPrompt, "agent.systemPrompt") }),
      pool: poolRaw.map((entry, index) => agentProfile(entry, `agent.pool[${index}]`, baseAgent, `agent-${index + 1}`)),
      roles: roleProfiles,
    },
    evaluator: {
      command,
      timeoutSeconds: integer(evaluator.timeoutSeconds ?? 600, "evaluator.timeoutSeconds", 1),
      repetitions,
      seeds: evaluatorSeeds,
      inheritEnv: strings(evaluator.inheritEnv ?? ["PATH", "HOME", "TMPDIR", "VIRTUAL_ENV", "CUDA_VISIBLE_DEVICES"], "evaluator.inheritEnv"),
      env: Object.fromEntries(
        Object.entries(object(evaluator.env ?? {}, "evaluator.env")).map(([key, value]) => [key, string(value, `evaluator.env.${key}`)]),
      ),
      stages: stagesRaw.map((entry, index) => {
        const stage = object(entry, `evaluator.stages[${index}]`);
        const budgetRatio = number(stage.budgetRatio ?? 1, `evaluator.stages[${index}].budgetRatio`, Number.EPSILON);
        if (budgetRatio > 1) throw new Error(`evaluator.stages[${index}].budgetRatio must be <= 1`);
        return {
          name: string(stage.name ?? `stage-${index + 1}`, `evaluator.stages[${index}].name`),
          budgetRatio,
          ...(stage.repetitions === undefined ? {} : { repetitions: integer(stage.repetitions, `evaluator.stages[${index}].repetitions`, 1) }),
          ...(stage.timeoutSeconds === undefined ? {} : { timeoutSeconds: integer(stage.timeoutSeconds, `evaluator.stages[${index}].timeoutSeconds`, 1) }),
          pruneIfClearlyWorse: stage.pruneIfClearlyWorse === undefined
            ? index < stagesRaw.length - 1
            : boolean(stage.pruneIfClearlyWorse, `evaluator.stages[${index}].pruneIfClearlyWorse`),
        };
      }),
      statistics: {
        enabled: statistics.enabled === undefined ? true : boolean(statistics.enabled, "evaluator.statistics.enabled"),
        confidenceLevel: number(statistics.confidenceLevel ?? 0.95, "evaluator.statistics.confidenceLevel", Number.EPSILON),
        equivalenceMargin: number(statistics.equivalenceMargin ?? Number(primary.minimumDelta ?? 0), "evaluator.statistics.equivalenceMargin"),
        minimumSeeds: integer(statistics.minimumSeeds ?? Math.min(repetitions, 3), "evaluator.statistics.minimumSeeds", 1),
        maximumSeeds: integer(statistics.maximumSeeds ?? repetitions, "evaluator.statistics.maximumSeeds", 1),
        seedStep: integer(statistics.seedStep ?? 2, "evaluator.statistics.seedStep", 1),
      },
      repetitionConcurrency: integer(evaluator.repetitionConcurrency ?? 1, "evaluator.repetitionConcurrency", 1),
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
      objectives: objectivesRaw.map((entry, index) => {
        const objective = object(entry, `metrics.objectives[${index}]`);
        return {
          name: string(objective.name, `metrics.objectives[${index}].name`),
          direction: direction(objective.direction, `metrics.objectives[${index}].direction`),
          aggregation: aggregation(objective.aggregation ?? "median", `metrics.objectives[${index}].aggregation`),
          weight: number(objective.weight ?? 1, `metrics.objectives[${index}].weight`, Number.EPSILON),
        };
      }),
      pareto: {
        enabled: pareto.enabled === undefined ? objectivesRaw.length > 0 : boolean(pareto.enabled, "metrics.pareto.enabled"),
      },
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
      strategy: { explorationRate, backtrackRate, replicationRate, falsificationRate, optimizeRate, mergeRate, ablationRate },
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
      campaign: {
        enabled: campaign.enabled === undefined ? true : boolean(campaign.enabled, "learning.campaign.enabled"),
        queueRate: rate(campaign.queueRate ?? 0.35, "learning.campaign.queueRate"),
        maxQueued: integer(campaign.maxQueued ?? 40, "learning.campaign.maxQueued", 1),
        hypothesesPerProposal: integer(campaign.hypothesesPerProposal ?? 4, "learning.campaign.hypothesesPerProposal", 1),
        autoAblations: campaign.autoAblations === undefined ? true : boolean(campaign.autoAblations, "learning.campaign.autoAblations"),
        maxAblationsPerPromotion: integer(campaign.maxAblationsPerPromotion ?? 3, "learning.campaign.maxAblationsPerPromotion", 1),
        autoMerge: campaign.autoMerge === undefined ? true : boolean(campaign.autoMerge, "learning.campaign.autoMerge"),
      },
      meta: {
        enabled: meta.enabled === undefined ? true : boolean(meta.enabled, "learning.meta.enabled"),
        updateInterval: integer(meta.updateInterval ?? 5, "learning.meta.updateInterval", 1),
        warmupExperiments: integer(meta.warmupExperiments ?? 5, "learning.meta.warmupExperiments", 1),
        explorationFloor: rate(meta.explorationFloor ?? 0.05, "learning.meta.explorationFloor"),
      },
    },
    search: {
      enabled: search.enabled === undefined ? parametersRaw.length > 0 : boolean(search.enabled, "search.enabled"),
      seed: integer(search.seed ?? 2027, "search.seed"),
      exploitationRatio: rate(search.exploitationRatio ?? 0.55, "search.exploitationRatio"),
      parameters: parametersRaw.map((entry, index) => {
        const parameter = object(entry, `search.parameters[${index}]`);
        const type = parameter.type as SearchParameterConfig["type"];
        if (!SEARCH_PARAMETER_TYPES.has(type)) throw new Error(`search.parameters[${index}].type is invalid`);
        const values = parameter.values;
        if (values !== undefined && (!Array.isArray(values) || values.some((value) => !["string", "number", "boolean"].includes(typeof value)))) {
          throw new Error(`search.parameters[${index}].values must contain only string, number, or boolean values`);
        }
        return {
          name: string(parameter.name, `search.parameters[${index}].name`),
          file: string(parameter.file, `search.parameters[${index}].file`),
          path: string(parameter.path ?? parameter.name, `search.parameters[${index}].path`),
          type,
          ...(parameter.min === undefined ? {} : { min: number(parameter.min, `search.parameters[${index}].min`, -Infinity) }),
          ...(parameter.max === undefined ? {} : { max: number(parameter.max, `search.parameters[${index}].max`, -Infinity) }),
          ...(parameter.scale === undefined ? {} : { scale: parameter.scale as "linear" | "log" }),
          ...(values === undefined ? {} : { values: values as Array<string | number | boolean> }),
        };
      }),
    },
    execution: {
      experimentConcurrency: integer(execution.experimentConcurrency ?? 1, "execution.experimentConcurrency", 1),
      resourceSlots: strings(execution.resourceSlots ?? [], "execution.resourceSlots"),
    },
    knowledge: {
      enabled: knowledge.enabled === undefined ? false : boolean(knowledge.enabled, "knowledge.enabled"),
      path: path.resolve(configDir, typeof knowledge.path === "string" ? knowledge.path : ".autoresearch/project-knowledge.json"),
      scope: Object.fromEntries(Object.entries(object(knowledge.scope ?? {}, "knowledge.scope")).map(([key, value]) => [key, string(value, `knowledge.scope.${key}`)])),
      minimumConfidence: rate(knowledge.minimumConfidence ?? 0.7, "knowledge.minimumConfidence"),
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
  if (config.evaluator.statistics!.confidenceLevel >= 1) throw new Error("evaluator.statistics.confidenceLevel must be < 1");
  if (config.evaluator.statistics!.minimumSeeds > config.evaluator.statistics!.maximumSeeds) {
    throw new Error("evaluator.statistics.minimumSeeds must be <= evaluator.statistics.maximumSeeds");
  }
  const finalStageRepetitions = config.evaluator.stages!.at(-1)!.repetitions ?? config.evaluator.repetitions;
  if (config.evaluator.statistics!.enabled && finalStageRepetitions > config.evaluator.statistics!.maximumSeeds) {
    throw new Error("final evaluator stage repetitions must be <= evaluator.statistics.maximumSeeds");
  }
  const maximumStageSeeds = Math.max(
    config.evaluator.statistics!.maximumSeeds,
    ...config.evaluator.stages!.map((stage) => stage.repetitions ?? config.evaluator.repetitions),
  );
  if (config.evaluator.seeds.length < maximumStageSeeds) {
    throw new Error(`evaluator.seeds must contain at least ${maximumStageSeeds} values required by stages/statistics`);
  }
  if (new Set(config.evaluator.seeds).size !== config.evaluator.seeds.length) throw new Error("evaluator.seeds must be unique");
  if (new Set(config.learning.humanLessons.map((lesson) => lesson.id)).size !== config.learning.humanLessons.length) {
    throw new Error("learning.humanLessons ids must be unique");
  }
  if (new Set(config.agent.pool?.map((profile) => profile.id)).size !== (config.agent.pool?.length ?? 0)) {
    throw new Error("agent.pool ids must be unique");
  }
  if (new Set(config.evaluator.stages?.map((stage) => stage.name)).size !== config.evaluator.stages?.length) {
    throw new Error("evaluator.stages names must be unique");
  }
  for (const stage of config.evaluator.stages!) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stage.name)) throw new Error(`evaluator stage name is unsafe: ${stage.name}`);
  }
  for (let index = 1; index < config.evaluator.stages!.length; index += 1) {
    if (config.evaluator.stages![index]!.budgetRatio < config.evaluator.stages![index - 1]!.budgetRatio) {
      throw new Error("evaluator.stages budgetRatio values must be non-decreasing");
    }
  }
  if (config.evaluator.stages!.at(-1)!.budgetRatio !== 1) throw new Error("the final evaluator stage must use budgetRatio=1");
  const objectiveNames = config.metrics.objectives?.map((objective) => objective.name) ?? [];
  const metricNames = [
    config.metrics.primary.name,
    ...config.metrics.guardrails.map((guardrail) => guardrail.name),
    ...objectiveNames,
  ];
  if (new Set(metricNames).size !== metricNames.length) {
    throw new Error("metrics primary, guardrails, and objectives names must be unique");
  }
  if (new Set(objectiveNames).size !== objectiveNames.length) throw new Error("metrics.objectives names must be unique");
  if (objectiveNames.includes(config.metrics.primary.name)) throw new Error("metrics.objectives must not repeat metrics.primary");
  const searchKeys = config.search?.parameters.map((parameter) => `${parameter.file}:${parameter.path}`) ?? [];
  if (new Set(searchKeys).size !== searchKeys.length) throw new Error("search parameter file/path pairs must be unique");
  for (const parameter of config.search?.parameters ?? []) {
    if (!isPathMatched(parameter.file, config.project.mutablePaths)) throw new Error(`search parameter file must be mutable: ${parameter.file}`);
    if ((parameter.type === "float" || parameter.type === "integer") && (parameter.min === undefined || parameter.max === undefined || parameter.min >= parameter.max)) {
      throw new Error(`search parameter ${parameter.name} requires min < max`);
    }
    if (parameter.scale !== undefined && parameter.scale !== "linear" && parameter.scale !== "log") throw new Error(`search parameter ${parameter.name} scale is invalid`);
    if (parameter.scale === "log" && (parameter.min ?? 0) <= 0) throw new Error(`log-scale search parameter ${parameter.name} requires min > 0`);
    if (parameter.type === "categorical" && (!parameter.values || parameter.values.length === 0)) throw new Error(`categorical search parameter ${parameter.name} requires values`);
  }
  if ((config.execution?.experimentConcurrency ?? 1) > 1 && !config.search?.enabled) {
    throw new Error("execution.experimentConcurrency > 1 requires deterministic search to be enabled");
  }
  if ((config.execution?.resourceSlots.length ?? 0) > 0 && config.execution!.resourceSlots.length < config.execution!.experimentConcurrency) {
    throw new Error("execution.resourceSlots must contain at least experimentConcurrency entries when provided");
  }
  if (new Set(config.execution?.resourceSlots).size !== config.execution?.resourceSlots.length) {
    throw new Error("execution.resourceSlots values must be unique");
  }
  return config;
}
