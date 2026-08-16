import { cp, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DecisionResult,
  EvaluationResult,
  ExperimentPlan,
  ExperimentRecord,
  HarnessConfig,
  AgentProfileConfig,
  PairedEvaluationRequest,
  PairedEvaluationResult,
  ProposalReview,
  ResearchConclusion,
  ResearchContext,
  ResearchMemory,
  ResearchNode,
  ResearchProposal,
  ResearcherFactory,
  RunState,
  SearchParameterConfig,
} from "./types.js";
import { EventLog, ensureDir, makeRunId, writeJsonAtomic } from "./io.js";
import { evaluateWorkspace } from "./evaluator.js";
import { decideResearchCandidate } from "./metrics.js";
import {
  applyExperimentKnowledge,
  createResearchMemory,
  memoryForAgent,
  normalizeClaim,
  recordBaselineFact,
  renderResearchMemory,
} from "./research-memory.js";
import {
  applyGraphDecision,
  candidateFitsFrontier,
  chooseResearchAssignment,
  createResearchGraph,
  primaryImprovement,
} from "./research-strategy.js";
import { normalizeChangeCategory } from "./change-category.js";
import { writeReport } from "./report.js";
import { readControlCommands, readRunControl, runningControl, writeRunControl } from "./control.js";
import {
  createResearchCampaign,
  enqueueCampaignTicket,
  enqueueConclusionHypotheses,
  enqueueMergeCandidate,
  enqueuePromotionAblations,
  finishCampaignTicket,
} from "./research-campaign.js";
import {
  createMetaResearchState,
  maybeUpdateMetaPolicy,
  normalizedResearchReward,
  recordMetaOutcome,
  selectAgentProfile,
} from "./meta-research.js";
import { importProjectLessons, loadProjectKnowledge, persistProjectKnowledge } from "./project-knowledge.js";
import { bestByObjective, configuredObjectives, paretoFrontier } from "./pareto.js";
import { applySearchSuggestion, suggestSearchSpace, type JsonValue, type SearchParameter } from "./search-space.js";
import {
  assertWorkspace,
  copyWorkspace,
  diffSnapshots,
  fingerprintSnapshot,
  isPathMatched,
  resolveSafeWorkspacePath,
  snapshotWorkspace,
} from "./workspace.js";

export interface HarnessRunOptions {
  configPath: string;
  resumeRunDir?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onState?: (state: RunState) => void | Promise<void>;
}

function failedEvaluation(error: string): EvaluationResult {
  return { ok: false, attempts: [], aggregatedMetrics: {}, error };
}

function skippedEvaluation(error: string): EvaluationResult {
  return { ok: false, skipped: true, attempts: [], aggregatedMetrics: {}, error };
}

function failureDecision(error: string): DecisionResult {
  return { status: "failure", primaryDelta: null, reasons: [error] };
}

function discardDecision(error: string): DecisionResult {
  return { status: "discard", primaryDelta: null, reasons: [error] };
}

function validatePairedRequest(config: HarnessConfig, request: PairedEvaluationRequest | undefined): string | undefined {
  if (!request) return undefined;
  const policy = config.evaluator.agentRequests;
  if (!policy?.allowPairedComparison) return "Agent-requested paired comparisons are disabled by evaluator.agentRequests";
  if (request.seeds.length === 0) return "A paired comparison must request at least one seed";
  if (request.seeds.length > policy.maxSeeds) return `Paired comparison requested ${request.seeds.length} seeds; maximum is ${policy.maxSeeds}`;
  if (new Set(request.seeds).size !== request.seeds.length) return "Paired comparison seeds must be unique";
  if (request.seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0)) return "Paired comparison seeds must be non-negative safe integers";
  const canonicalSeeds = new Set(config.evaluator.seeds.slice(0, config.evaluator.repetitions));
  const repeatedSeeds = request.seeds.filter((seed) => canonicalSeeds.has(seed));
  if (repeatedSeeds.length > 0) return `Paired comparison must use fresh seeds; canonical seeds repeated: ${repeatedSeeds.join(", ")}`;
  return undefined;
}

function checkpointEvaluation(state: RunState, checkpointId: string): EvaluationResult | undefined {
  if (checkpointId === "baseline") return state.baseline;
  return state.experiments.find((experiment) => experiment.id === checkpointId)?.evaluation;
}

function combinePairedDecision(canonical: DecisionResult, paired: DecisionResult, referenceId: string): DecisionResult {
  const confirmation = `Paired fresh-seed comparison against ${referenceId}: ${paired.reasons.join("; ")}`;
  if (canonical.status === "failure" || paired.status === "failure") {
    return failureDecision([canonical.reasons.join("; "), confirmation].filter(Boolean).join("; "));
  }
  if (canonical.status === "promote" || canonical.status === "keep") {
    if (paired.status === "promote" || paired.status === "keep") {
      return { ...canonical, reasons: [...canonical.reasons, confirmation, "Canonical and paired comparisons both satisfy promotion policy"] };
    }
    return {
      status: paired.status === "inconclusive" ? "inconclusive" : paired.status === "retain" ? "retain" : "discard",
      primaryDelta: canonical.primaryDelta,
      reasons: [...canonical.reasons, confirmation, "Promotion blocked because fresh-seed confirmation did not satisfy promotion policy"],
      ...(paired.statisticalStatus ? { statisticalStatus: paired.statisticalStatus } : {}),
      paretoOptimal: Boolean(canonical.paretoOptimal || paired.paretoOptimal),
    };
  }
  return { ...canonical, reasons: [...canonical.reasons, confirmation] };
}

function oneLine(value: string, maxLength = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 0.0001 || absolute >= 10_000)) return value.toExponential(6);
  return Number(value.toPrecision(7)).toString();
}

function formatMetrics(metrics: Record<string, number>): string {
  const entries = Object.entries(metrics);
  return entries.length === 0
    ? "none"
    : entries.map(([name, value]) => `${name}=${formatNumber(value)}`).join(", ");
}

function formatCheckpoint(id: string, metrics: Record<string, number>, primaryName: string): string {
  const value = metrics[primaryName];
  return `${id} (${primaryName}=${value === undefined ? "missing" : formatNumber(value)})`;
}

function formatEvaluation(evaluation: EvaluationResult, primaryName: string): string {
  if (!evaluation.ok) return evaluation.error ?? "evaluation failed without an error message";
  const attempts = evaluation.attempts.map((attempt) => {
    const value = attempt.metrics?.[primaryName];
    const measured = value === undefined ? "missing" : formatNumber(value);
    return `r${attempt.repetition + 1}/seed=${attempt.seed}:${measured}`;
  });
  return `aggregate {${formatMetrics(evaluation.aggregatedMetrics)}}; primary attempts [${attempts.join(", ") || "none"}]`;
}

function formatSigned(value: number | null): string {
  if (value === null) return "n/a";
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

function questionCounts(memory: ResearchMemory): string {
  return ["open", "resolved", "invalidated"]
    .map((status) => `${status}=${memory.questions.filter((question) => question.status === status).length}`)
    .join(", ");
}

function memoryChanges(before: ResearchMemory, after: ResearchMemory, experimentId: string): string[] {
  const changes: string[] = [];
  const previousQuestions = new Map(before.questions.map((question) => [question.id, question]));
  for (const question of after.questions) {
    const previous = previousQuestions.get(question.id);
    if (!previous) {
      changes.push(`opened ${question.id}: ${oneLine(question.text, 320)}`);
    } else if (previous.status !== question.status) {
      changes.push(`${question.id} ${previous.status}->${question.status}: ${oneLine(question.resolution ?? "no resolution recorded", 320)}`);
    }
  }

  const previousLessons = new Map(before.lessons.map((lesson) => [lesson.id, lesson]));
  for (const lesson of after.lessons) {
    const previous = previousLessons.get(lesson.id);
    if (!previous) {
      changes.push(`created ${lesson.id} [${lesson.status}]: ${oneLine(lesson.claim, 320)}`);
    } else if (previous.status !== lesson.status) {
      changes.push(`${lesson.id} ${previous.status}->${lesson.status}: ${oneLine(lesson.claim, 320)}`);
    }
  }

  for (const review of after.evidenceReviews.slice(before.evidenceReviews.length)) {
    changes.push(`evidence ${review.accepted ? "accepted" : "rejected"} for ${review.lessonId}: ${oneLine(review.reason, 320)}`);
  }

  const addedNotes = after.notes.length - before.notes.length;
  changes.unshift(`stored fact-${experimentId} and ${addedNotes} agent note${addedNotes === 1 ? "" : "s"}; questions {${questionCounts(after)}}`);
  return changes;
}

async function saveState(state: RunState): Promise<void> {
  await writeJsonAtomic(path.join(state.runDir, "state.json"), state);
  if (state.researchMemory) {
    await writeJsonAtomic(path.join(state.runDir, "research-memory.json"), state.researchMemory);
    await writeFile(path.join(state.runDir, "RESEARCH_MEMORY.md"), renderResearchMemory(state.researchMemory), "utf8");
  }
  if (state.researchGraph) await writeJsonAtomic(path.join(state.runDir, "frontier.json"), state.researchGraph);
  if (state.campaign) await writeJsonAtomic(path.join(state.runDir, "campaign.json"), state.campaign);
  if (state.metaResearch) await writeJsonAtomic(path.join(state.runDir, "meta-research.json"), state.metaResearch);
  if (state.bestByObjective) await writeJsonAtomic(path.join(state.runDir, "pareto.json"), {
    frontierIds: state.researchGraph?.paretoFrontierIds ?? [],
    bestByObjective: state.bestByObjective,
  });
  await writeJsonAtomic(path.join(state.runDir, "accepted.json"), {
    experimentId: state.researchGraph?.leaderId ?? "baseline",
    workspacePath: state.acceptedWorkspacePath,
    metrics: state.acceptedMetrics,
    policy: "promotion-threshold leader",
  });
  if (state.bestObserved) {
    await writeJsonAtomic(path.join(state.runDir, "best-observed.json"), state.bestObserved);
  }
  await writeReport(state);
}

async function previousContext(state: RunState, limit: number): Promise<ResearchContext["previousExperiments"]> {
  return Promise.all(state.experiments.slice(-limit).map(async (experiment) => ({
    id: experiment.id,
    status: experiment.decision.status,
    metrics: experiment.evaluation.aggregatedMetrics,
    primaryDelta: experiment.decision.primaryDelta,
    ...(experiment.strategy ? { strategy: experiment.strategy } : {}),
    ...(experiment.parentId ? { parentId: experiment.parentId } : {}),
    ...(experiment.plan?.hypothesis ? { hypothesis: experiment.plan.hypothesis } : {}),
    ...(experiment.conclusion?.summary
      ? { conclusion: experiment.conclusion.summary }
      : experiment.conclusionPath
        ? { conclusion: (await readFile(experiment.conclusionPath, "utf8").catch(() => "")).slice(0, 1_500) }
        : {}),
  })));
}

function fallbackPlan(narrative: string): ExperimentPlan {
  const firstLine = narrative.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
  return {
    hypothesis: (firstLine ?? "Unstructured experiment proposal").slice(0, 1_000),
    changeCategory: "other",
    expectedEffect: "See the experiment proposal narrative.",
    notes: [],
    lessonsUsed: [],
    contradictedLessons: [],
    lessonTests: [],
    questionsAddressed: [],
  };
}

function candidateNode(
  id: string,
  workspacePath: string,
  workspaceFingerprint: string,
  metrics: Record<string, number>,
  parentId: string,
  branchDepth: number,
  strategy: ResearchNode["strategy"],
  changeCategory: string,
): ResearchNode {
  return {
    id,
    parentId,
    workspacePath,
    workspaceFingerprint,
    metrics,
    branchDepth,
    status: "frontier",
    wasLeader: false,
    strategy,
    changeCategory: normalizeChangeCategory(changeCategory),
    selectedCount: 0,
  };
}

function activeRuntimeMs(state: RunState): number {
  const current = state.activeSegmentStartedAt ? Date.now() - Date.parse(state.activeSegmentStartedAt) : 0;
  return (state.activeDurationMs ?? 0) + Math.max(0, current);
}

function stopActiveSegment(state: RunState): void {
  if (!state.activeSegmentStartedAt) return;
  state.activeDurationMs = activeRuntimeMs(state);
  delete state.activeSegmentStartedAt;
}

function startActiveSegment(state: RunState): void {
  if (!state.activeSegmentStartedAt) state.activeSegmentStartedAt = new Date().toISOString();
}

async function pathExists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}

async function replaceFromWorkspace(sourceWorkspace: string, targetWorkspace: string, relativePath: string): Promise<void> {
  const source = path.join(sourceWorkspace, relativePath);
  const target = path.join(targetWorkspace, relativePath);
  await rm(target, { recursive: true, force: true });
  if (await pathExists(source)) {
    await ensureDir(path.dirname(target));
    await cp(source, target, { recursive: true, force: true });
  }
}

function searchParameter(parameter: SearchParameterConfig): SearchParameter {
  if (parameter.type === "float") {
    return { type: "float", min: parameter.min!, max: parameter.max!, ...(parameter.scale ? { scale: parameter.scale } : {}) };
  }
  if (parameter.type === "integer") return { type: "integer", min: parameter.min!, max: parameter.max! };
  if (parameter.type === "categorical") return { type: "categorical", values: parameter.values! as JsonValue[] };
  return { type: "boolean" };
}

async function prepareAutomatedCandidate(
  config: HarnessConfig,
  state: RunState,
  assignment: ResearchContext["assignment"],
  workspacePath: string,
  experimentIndex: number,
): Promise<ExperimentPlan | undefined> {
  if (assignment.strategy === "optimize" && config.search?.enabled) {
    const fullSuggestion: Record<string, string | number | boolean> = {};
    const plannedSuggestion = assignment.searchSuggestion;
    if (plannedSuggestion) {
      const knownKeys = new Set(config.search.parameters.map((parameter) => `${parameter.file}:${parameter.path}`));
      const unknownKeys = Object.keys(plannedSuggestion).filter((key) => !knownKeys.has(key));
      if (unknownKeys.length > 0) throw new Error(`Search ticket contains unknown parameter keys: ${unknownKeys.join(", ")}`);
    }
    const files = new Map<string, typeof config.search.parameters>();
    for (const parameter of config.search.parameters) {
      const existing = files.get(parameter.file) ?? [];
      existing.push(parameter);
      files.set(parameter.file, existing);
    }
    for (const [relativePath, parameters] of files) {
      const requestedForFile = plannedSuggestion
        ? Object.fromEntries(parameters.flatMap((parameter) => {
          const key = `${relativePath}:${parameter.path}`;
          const value = plannedSuggestion[key];
          return value === undefined ? [] : [[parameter.path, value]];
        }))
        : undefined;
      if (plannedSuggestion && Object.keys(requestedForFile!).length === 0) continue;
      const absolutePath = (await resolveSafeWorkspacePath(workspacePath, relativePath, {
        requireMutable: config.project.mutablePaths,
        protectedPaths: config.project.protectedPaths,
      })).absolutePath;
      const document = JSON.parse(await readFile(absolutePath, "utf8")) as JsonValue;
      const space = Object.fromEntries(parameters.map((parameter) => [parameter.path, searchParameter(parameter)]));
      const local = ((experimentIndex * 2654435761 + config.search.seed) >>> 0) / 4_294_967_296 < config.search.exploitationRatio;
      const suggestion = requestedForFile
        ?? suggestSearchSpace(space, config.search.seed, experimentIndex - 1, local ? { local: true, leader: document } : {});
      await writeFile(absolutePath, `${JSON.stringify(applySearchSuggestion(document, suggestion), null, 2)}\n`, "utf8");
      for (const [parameterPath, value] of Object.entries(suggestion)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") fullSuggestion[`${relativePath}:${parameterPath}`] = value;
      }
    }
    if (Object.keys(fullSuggestion).length === 0) throw new Error("Search suggestion does not select any configured parameter");
    assignment.searchSuggestion = fullSuggestion;
    return {
      hypothesis: `Deterministic search suggestion ${JSON.stringify(fullSuggestion)} will improve the current checkpoint.`,
      changeCategory: "optimization",
      expectedEffect: "Measure the suggested parameter configuration against the current leader with staged paired evidence.",
      notes: [assignment.reason], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
      searchSuggestion: fullSuggestion,
      expectedGain: 0, probabilityOfSuccess: 0.5, informationGain: 0.7, estimatedCost: 1,
      falsificationCriterion: `The primary metric does not improve by ${config.metrics.primary.minimumDelta}.`,
      dependencies: [], followUpHypotheses: [],
    };
  }
  if (assignment.strategy === "ablate" && assignment.ablation) {
    const source = state.experiments.find((experiment) => experiment.id === assignment.ablation!.sourceExperimentId);
    const parent = source?.parentId ? state.researchGraph?.nodes.find((node) => node.id === source.parentId) : undefined;
    if (!source || !parent) throw new Error(`Cannot resolve ablation source ${assignment.ablation.sourceExperimentId} and its parent`);
    await replaceFromWorkspace(parent.workspacePath, workspacePath, assignment.ablation.removePath);
    return {
      hypothesis: assignment.plannedHypothesis ?? `The promoted result remains when ${assignment.ablation.removePath} is removed.`,
      changeCategory: source.plan?.changeCategory ?? "other",
      expectedEffect: "Estimate the isolated contribution of one component from a promoted multi-file change.",
      notes: [assignment.reason], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
      ablation: assignment.ablation, expectedGain: 0, probabilityOfSuccess: 0.5, informationGain: 1, estimatedCost: 1,
      falsificationCriterion: "Removing the component erases the promoted gain.", dependencies: [], followUpHypotheses: [],
    };
  }
  if (assignment.strategy === "merge" && assignment.merge) {
    const second = state.researchGraph?.nodes.find((node) => node.id === assignment.merge!.sourceExperimentIds[1]);
    if (!second) throw new Error(`Cannot resolve merge source ${assignment.merge.sourceExperimentIds[1]}`);
    for (const relativePath of assignment.merge.pathsFromSecond) await replaceFromWorkspace(second.workspacePath, workspacePath, relativePath);
    return {
      hypothesis: assignment.plannedHypothesis ?? `Independent changes from ${assignment.merge.sourceExperimentIds.join(" and ")} are additive.`,
      changeCategory: "other",
      expectedEffect: "Test whether disjoint retained changes combine without destructive interaction.",
      notes: [assignment.reason], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
      merge: assignment.merge, expectedGain: 0, probabilityOfSuccess: 0.4, informationGain: 0.8, estimatedCost: 1.2,
      falsificationCriterion: "The merged candidate fails to outperform its strongest source checkpoint.", dependencies: [], followUpHypotheses: [],
    };
  }
  return undefined;
}

export class AutoresearchHarness {
  private readonly config: HarnessConfig;
  private readonly researcherFactory: ResearcherFactory;

  constructor(config: HarnessConfig, researcherFactory: ResearcherFactory) {
    this.config = config;
    this.researcherFactory = researcherFactory;
  }

  async run(options: HarnessRunOptions): Promise<RunState> {
    await assertWorkspace(this.config.project.sourceDir);
    const invocationStartedAtMs = Date.now();
    const restored = options.resumeRunDir
      ? JSON.parse(await readFile(path.join(path.resolve(options.resumeRunDir), "state.json"), "utf8")) as RunState
      : undefined;
    if (restored && restored.schemaVersion !== 4) throw new Error("Only future schemaVersion 4 runs can be resumed");
    if (restored && (restored.status === "completed" || restored.status === "stopped")) {
      throw new Error(`Run ${restored.runId} is already ${restored.status}`);
    }
    if (restored && !restored.baseline.ok) throw new Error(`Run ${restored.runId} cannot resume because its baseline failed`);
    const runId = restored?.runId ?? makeRunId(this.config.name);
    const runDir = restored?.runDir ?? path.join(this.config.outputDir, runId);
    await ensureDir(runDir);
    const events = new EventLog(path.join(runDir, "events.jsonl"));
    const progress = (message: string) => {
      events.append("progress", { message });
      options.onProgress?.(message);
    };
    const persistState = async (state: RunState) => {
      await saveState(state);
      await options.onState?.(state);
    };
    const prepareExperimentDir = async (experimentId: string): Promise<string> => {
      const experimentDir = path.join(runDir, "experiments", experimentId);
      if (await pathExists(experimentDir)) {
        const recoveredDir = path.join(runDir, "orphaned", `${experimentId}-${Date.now()}`);
        await ensureDir(path.dirname(recoveredDir));
        await rename(experimentDir, recoveredDir);
        progress(`${experimentId} RECOVERY: moved an incomplete prior attempt to ${path.relative(runDir, recoveredDir)}`);
      }
      await ensureDir(experimentDir);
      return experimentDir;
    };
    events.append(restored ? "run_resumed" : "run_started", { runId, configPath: path.resolve(options.configPath) });
    const wallTime = this.config.budget.maxWallTimeMinutes === 0
      ? "unlimited"
      : `${formatNumber(this.config.budget.maxWallTimeMinutes)} min`;
    progress(`Run configuration: model=${this.config.agent.model ?? "Pi default"}, reasoning=${this.config.agent.thinkingLevel}, budget=${this.config.budget.maxExperiments} experiments / ${wallTime}`);
    progress(`Promotion policy: ${this.config.metrics.primary.direction} ${this.config.metrics.primary.name}, minimum improvement=${formatNumber(this.config.metrics.primary.minimumDelta)}${this.config.metrics.guardrails.length > 0 ? `; guardrails=${this.config.metrics.guardrails.map((guardrail) => guardrail.name).join(", ")}` : "; no guardrails"}`);

    const ignoreRules = [...this.config.project.copyIgnore];
    const relativeOutput = path.relative(this.config.project.sourceDir, this.config.outputDir);
    if (relativeOutput && relativeOutput !== ".." && !relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput)) {
      ignoreRules.push(relativeOutput);
    }
    const relativeRun = path.relative(this.config.project.sourceDir, runDir);
    if (relativeRun && relativeRun !== ".." && !relativeRun.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeRun)) {
      ignoreRules.push(relativeRun);
    }

    let state: RunState;
    if (restored) {
      state = restored;
      if (!state.researchGraph || !state.researchMemory) throw new Error("Run is missing schemaVersion 4 research state");
      state.status = "running";
      delete state.finishedAt;
      delete state.stopReason;
      state.campaign ??= createResearchCampaign(this.config.researchInstructions, runId, state.startedAt);
      state.metaResearch ??= createMetaResearchState(this.config);
      state.appliedCommandIds ??= [];
      for (const ticket of state.campaign.tickets) {
        if (ticket.status === "running" && !ticket.resultExperimentId) {
          ticket.status = "queued";
          delete ticket.claimedBy;
        }
      }
      if (state.activeSegmentStartedAt) {
        const lastHeartbeat = state.control?.heartbeatAt ? Date.parse(state.control.heartbeatAt) : Date.parse(state.activeSegmentStartedAt);
        state.activeDurationMs = (state.activeDurationMs ?? 0) + Math.max(0, lastHeartbeat - Date.parse(state.activeSegmentStartedAt));
        delete state.activeSegmentStartedAt;
      }
      startActiveSegment(state);
      state.control = { ...runningControl(), ownerPid: process.pid, heartbeatAt: new Date().toISOString() };
      await writeRunControl(runDir, state.control);
      progress(`Resuming ${runId} after ${state.experiments.length} recorded experiments; baseline will not be rerun`);
    } else {
      const baselineWorkspace = path.join(runDir, "baseline", "workspace");
      progress("Creating isolated baseline workspace");
      await copyWorkspace(this.config.project.sourceDir, baselineWorkspace, ignoreRules);
      const baselineFingerprint = fingerprintSnapshot(await snapshotWorkspace(baselineWorkspace));
      progress("Running baseline evaluation");
      const baseline = await evaluateWorkspace(this.config, baselineWorkspace, path.join(runDir, "baseline", "evaluation"), "baseline");
      events.append("baseline_evaluated", { evaluation: baseline, workspaceFingerprint: baselineFingerprint });
      const createdAt = new Date(invocationStartedAtMs).toISOString();
      const projectKnowledge = await loadProjectKnowledge(this.config);
      const graph = createResearchGraph(baselineWorkspace, baselineFingerprint, baseline.aggregatedMetrics);
      state = {
        schemaVersion: 4, runId, name: this.config.name, status: baseline.ok ? "running" : "failed", startedAt: createdAt,
        configPath: path.resolve(options.configPath), runDir, sourceDir: this.config.project.sourceDir,
        agent: { ...(this.config.agent.model ? { model: this.config.agent.model } : {}), thinkingLevel: this.config.agent.thinkingLevel },
        primaryMetric: this.config.metrics.primary, objectives: this.config.metrics.objectives ?? [], acceptedWorkspacePath: baselineWorkspace, baseline,
        acceptedMetrics: baseline.aggregatedMetrics,
        bestObserved: { experimentId: "baseline", workspacePath: baselineWorkspace, metrics: baseline.aggregatedMetrics, decisionStatus: "baseline" },
        researchMemory: importProjectLessons(recordBaselineFact(createResearchMemory(this.config, createdAt), baseline, baselineFingerprint, new Date().toISOString()), projectKnowledge),
        researchGraph: graph,
        campaign: createResearchCampaign(this.config.researchInstructions, runId, createdAt),
        control: { ...runningControl(createdAt), ownerPid: process.pid, heartbeatAt: createdAt },
        metaResearch: createMetaResearchState(this.config),
        bestByObjective: bestByObjective(graph.nodes, configuredObjectives(this.config)),
        appliedCommandIds: [], activeDurationMs: 0, activeSegmentStartedAt: createdAt, experiments: [],
        ...(!baseline.ok ? { stopReason: `Baseline failed: ${baseline.error ?? "unknown evaluator error"}` } : {}),
      };
      await writeJsonAtomic(path.join(runDir, "config.resolved.json"), this.config);
      await writeRunControl(runDir, state.control!);
      if (!baseline.ok) {
        stopActiveSegment(state);
        state.finishedAt = new Date().toISOString();
        const stoppedControl = {
          desiredState: "stopped" as const,
          updatedAt: state.finishedAt,
          heartbeatAt: state.finishedAt,
          ...(state.stopReason ? { reason: state.stopReason } : {}),
        };
        state.control = stoppedControl;
        await writeRunControl(runDir, stoppedControl);
        await persistState(state);
        events.append("run_failed", { reason: state.stopReason });
        progress(`Run failed: ${state.stopReason}`);
        return state;
      }
      progress(`Baseline result: ${formatEvaluation(baseline, this.config.metrics.primary.name)}`);
      progress(`Baseline accepted; leader=${formatCheckpoint("baseline", state.acceptedMetrics, this.config.metrics.primary.name)}; best-observed=${formatCheckpoint("baseline", state.acceptedMetrics, this.config.metrics.primary.name)}`);
    }
    await persistState(state);

    const syncControl = async (): Promise<boolean> => {
      const pending = await readControlCommands(runDir);
      const applied = new Set(state.appliedCommandIds ?? []);
      for (const command of pending.commands) {
        if (applied.has(command.id)) continue;
        if (command.type === "enqueue" && state.campaign && !state.campaign.tickets.some((ticket) => ticket.id === command.ticket.id)) {
          const duplicate = state.campaign.tickets.find((ticket) =>
            ticket.kind === command.ticket.kind && normalizeClaim(ticket.hypothesis) === normalizeClaim(command.ticket.hypothesis));
          if (duplicate) {
            progress(`CONTROL: ignored duplicate human hypothesis ${command.ticket.id}; equivalent ticket=${duplicate.id}`);
          } else if (state.campaign.tickets.filter((ticket) => ticket.status === "queued").length >= (this.config.learning.campaign?.maxQueued ?? 40)) {
            progress(`CONTROL: rejected ${command.ticket.id}; campaign queue capacity reached`);
          } else {
            state.campaign.tickets.push(command.ticket);
            state.campaign.updatedAt = command.createdAt;
            progress(`CONTROL: queued ${command.ticket.id} from human input — ${oneLine(command.ticket.hypothesis)}`);
          }
        }
        applied.add(command.id);
      }
      state.appliedCommandIds = [...applied];
      let control = await readRunControl(runDir);
      if (control.desiredState !== "stopped") {
        control = { ...control, ownerPid: process.pid, heartbeatAt: new Date().toISOString() };
        await writeRunControl(runDir, control);
      }
      state.control = control;
      if (control.desiredState === "paused") {
        stopActiveSegment(state);
        state.status = "paused";
        await persistState(state);
        progress(`Run paused at a safe experiment boundary${control.reason ? `: ${control.reason}` : ""}`);
        while (control.desiredState === "paused" && !options.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          control = await readRunControl(runDir);
        }
        state.control = control;
        if (options.signal?.aborted) {
          state.status = "interrupted";
          state.stopReason = "Received interruption signal while paused";
          return false;
        }
        if (control.desiredState === "running") {
          state.status = "running";
          startActiveSegment(state);
          progress("Run resumed from the safe boundary");
          await persistState(state);
        }
      }
      if (control.desiredState === "stopped") {
        stopActiveSegment(state);
        state.status = "stopped";
        state.stopReason = control.reason ?? "Stopped by user command";
        return false;
      }
      return true;
    };

    let consecutiveFailures = [...state.experiments].reverse().findIndex((experiment) => experiment.decision.status !== "failure");
    if (consecutiveFailures === -1) consecutiveFailures = state.experiments.length;

    const commitRecord = async (
      record: ExperimentRecord,
      assignment: ResearchContext["assignment"],
      agentProfile: AgentProfileConfig,
      leaderBefore: string,
      acceptedMetricsBefore: Record<string, number>,
      bestObservedBefore: RunState["bestObserved"],
      memoryBefore: ResearchMemory,
    ): Promise<void> => {
      const { id, index, workspacePath, evaluation, decision, workspaceFingerprint = "", pairedEvaluation, duplicateOf, repeatedHypothesisOf } = record;
      const plan = record.plan;
      state.experiments.push(record);
      if (evaluation.ok && !evaluation.pruned && state.bestObserved && primaryImprovement(
        state.bestObserved.metrics, evaluation.aggregatedMetrics, this.config.metrics.primary,
      ) > 0) {
        state.bestObserved = {
          experimentId: id, workspacePath, metrics: evaluation.aggregatedMetrics,
          decisionStatus: decision.status === "keep" ? "promote" : decision.status === "reject" ? "discard" : decision.status,
        };
      }
      const node = candidateNode(
        id, workspacePath, workspaceFingerprint, evaluation.aggregatedMetrics, assignment.parentId,
        assignment.branchDepth, assignment.strategy, plan?.changeCategory ?? "other",
      );
      if (!(pairedEvaluation && duplicateOf)) applyGraphDecision(state.researchGraph!, node, decision, this.config, this.config.metrics.primary);
      const leader = state.researchGraph!.nodes.find((candidate) => candidate.id === state.researchGraph!.leaderId)!;
      state.acceptedWorkspacePath = leader.workspacePath;
      state.acceptedMetrics = leader.metrics;
      state.researchMemory = applyExperimentKnowledge(state.researchMemory!, record, record.conclusion, this.config);
      state.bestByObjective = bestByObjective(
        state.researchGraph!.nodes.filter((candidate) => candidate.status !== "failed" && candidate.status !== "discarded"),
        configuredObjectives(this.config),
      );
      if (state.campaign) {
        finishCampaignTicket(state.campaign, assignment.ticketId, record);
        if (this.config.learning.campaign?.enabled) {
          for (const hypothesis of plan?.followUpHypotheses ?? []) {
            enqueueCampaignTicket(state.campaign, {
              kind: "hypothesis", hypothesis, createdBy: "agent",
              ...(plan?.expectedGain === undefined ? {} : { expectedGain: plan.expectedGain }),
              ...(plan?.probabilityOfSuccess === undefined ? {} : { probabilityOfSuccess: plan.probabilityOfSuccess }),
              ...(plan?.informationGain === undefined ? {} : { informationGain: plan.informationGain }),
              ...(plan?.estimatedCost === undefined ? {} : { estimatedCost: plan.estimatedCost }),
            }, this.config);
          }
          enqueueConclusionHypotheses(state.campaign, record, this.config);
          enqueuePromotionAblations(state.campaign, record, this.config);
          enqueueMergeCandidate(state.campaign, state.researchGraph!, state.experiments, this.config);
        }
      }
      if (state.metaResearch) {
        const referenceValue = acceptedMetricsBefore[this.config.metrics.primary.name] ?? 0;
        const reward = normalizedResearchReward(decision.primaryDelta, referenceValue, decision.status === "failure");
        recordMetaOutcome(
          state.metaResearch, agentProfile.id, assignment.strategy, reward,
          decision.status === "promote" ? "promote" : decision.status === "failure" ? "failure" : "other",
        );
        const priorUpdates = state.metaResearch.policyUpdates.length;
        maybeUpdateMetaPolicy(this.config, state.metaResearch, index);
        if (state.metaResearch.policyUpdates.length > priorUpdates) progress(`${id} META: research policy was rebalanced from observed strategy rewards`);
      }
      events.append("experiment_decided", { id, assignment, decision, evaluation, pairedEvaluation, duplicateOf, repeatedHypothesisOf });
      if (decision.status === "failure") consecutiveFailures += 1;
      else consecutiveFailures = 0;
      progress(`${id} DECISION: ${decision.status}; primary improvement=${formatSigned(decision.primaryDelta)}; ${decision.reasons.map((reason) => oneLine(reason)).join("; ")}`);
      if (leaderBefore !== leader.id) progress(`${id} NEW LEADER: ${formatCheckpoint(leaderBefore, acceptedMetricsBefore, this.config.metrics.primary.name)} -> ${formatCheckpoint(leader.id, leader.metrics, this.config.metrics.primary.name)}`);
      if (bestObservedBefore?.experimentId !== state.bestObserved?.experimentId && state.bestObserved) {
        progress(`${id} NEW BEST-OBSERVED: ${bestObservedBefore ? formatCheckpoint(bestObservedBefore.experimentId, bestObservedBefore.metrics, this.config.metrics.primary.name) : "none"} -> ${formatCheckpoint(state.bestObserved.experimentId, state.bestObserved.metrics, this.config.metrics.primary.name)} (decision=${state.bestObserved.decisionStatus})`);
      }
      progress(`${id} STATE: leader=${formatCheckpoint(leader.id, leader.metrics, this.config.metrics.primary.name)}; best-observed=${state.bestObserved ? formatCheckpoint(state.bestObserved.experimentId, state.bestObserved.metrics, this.config.metrics.primary.name) : "none"}; frontier=[${state.researchGraph!.frontierIds.join(", ") || "empty"}]`);
      progress(`${id} PARETO: [${state.researchGraph!.paretoFrontierIds.join(", ") || "empty"}]; objectives=${Object.entries(state.bestByObjective ?? {}).map(([name, best]) => `${name}:${best.experimentId}=${formatNumber(best.value)}`).join(", ") || "none"}`);
      if (state.campaign) progress(`${id} CAMPAIGN: queued=${state.campaign.tickets.filter((ticket) => ticket.status === "queued").length}, running=${state.campaign.tickets.filter((ticket) => ticket.status === "running").length}, completed=${state.campaign.tickets.filter((ticket) => ticket.status === "completed").length}`);
      for (const change of memoryChanges(memoryBefore, state.researchMemory, id)) progress(`${id} MEMORY: ${change}`);
      await persistState(state);
      await persistProjectKnowledge(this.config, state);
    };

    const runParallelOptimizationBatch = async (
      startIndex: number,
      firstAssignment: ResearchContext["assignment"],
      batchSize: number,
    ): Promise<void> => {
      const referenceId = state.researchGraph!.leaderId;
      const referenceMetrics = { ...state.acceptedMetrics };
      const referenceWorkspace = state.acceptedWorkspacePath;
      const referenceEvaluation = checkpointEvaluation(state, referenceId)!;
      const resourceSlots = this.config.execution?.resourceSlots ?? [];
      progress(`SEARCH BATCH: preparing ${batchSize} independent candidates in parallel from ${referenceId}`);
      const prepared = await Promise.all(Array.from({ length: batchSize }, async (_, offset) => {
        const experimentIndex = startIndex + offset;
        const experimentId = `exp-${String(experimentIndex).padStart(4, "0")}`;
        const { ticketId: _ticketId, plannedHypothesis: _plannedHypothesis, searchSuggestion: _searchSuggestion, ...unclaimed } = firstAssignment;
        const assignment = offset === 0 ? firstAssignment : {
          ...unclaimed,
          reason: `Parallel deterministic search candidate ${offset + 1}/${batchSize} from ${referenceId}.`,
        };
        const startedAt = new Date().toISOString();
        let experimentDir = path.join(runDir, "experiments", experimentId);
        let workspacePath = path.join(experimentDir, "workspace");
        const proposalPath = path.join(experimentDir, "proposal.md");
        const proposalJsonPath = path.join(experimentDir, "proposal.json");
        const resourceSlot = resourceSlots[offset] ?? `worker-${offset + 1}`;
        try {
          experimentDir = await prepareExperimentDir(experimentId);
          workspacePath = path.join(experimentDir, "workspace");
          progress(`${experimentId} START: optimize from ${referenceId}; resource=${resourceSlot}`);
          await copyWorkspace(firstAssignment.parentWorkspacePath, workspacePath, ignoreRules);
          const before = await snapshotWorkspace(workspacePath);
          events.append("experiment_started", { id: experimentId, index: experimentIndex, workspacePath, assignment, acceptedMetrics: referenceMetrics, parallelBatch: startIndex });
          const plan = await prepareAutomatedCandidate(this.config, state, assignment, workspacePath, experimentIndex);
          if (!plan) throw new Error("Parallel optimization batch did not produce a deterministic plan");
          await writeFile(proposalPath, `# Harness-planned parallel optimize\n\n${assignment.reason}\n`, "utf8");
          await writeJsonAtomic(proposalJsonPath, plan);
          const after = await snapshotWorkspace(workspacePath);
          const workspaceFingerprint = fingerprintSnapshot(after);
          const changedPaths = diffSnapshots(before, after);
          const forbiddenChanges = changedPaths.filter((changedPath) =>
            !isPathMatched(changedPath, this.config.project.mutablePaths) || isPathMatched(changedPath, this.config.project.protectedPaths));
          events.append("candidate_prepared", { id: experimentId, changedPaths, forbiddenChanges, workspaceFingerprint, parallelBatch: startIndex });
          progress(`${experimentId} SEARCH: ${JSON.stringify(plan.searchSuggestion)}; changed=${changedPaths.join(", ") || "none"}`);
          return {
            experimentIndex, experimentId, assignment, experimentDir, workspacePath, before, after, startedAt, plan,
            proposalPath, proposalJsonPath, workspaceFingerprint, changedPaths, forbiddenChanges, resourceSlot,
            preparationError: undefined as string | undefined,
          };
        } catch (error) {
          const preparationError = error instanceof Error ? error.message : String(error);
          const plan: ExperimentPlan = {
            hypothesis: assignment.plannedHypothesis ?? "Prepare the deterministic search candidate.",
            changeCategory: "optimization",
            expectedEffect: "The candidate could not be prepared.",
            notes: [assignment.reason, preparationError], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
          };
          events.append("candidate_preparation_failed", { id: experimentId, error: preparationError, parallelBatch: startIndex });
          progress(`${experimentId} PREPARATION FAILED: ${oneLine(preparationError)}`);
          return {
            experimentIndex, experimentId, assignment, experimentDir, workspacePath,
            before: new Map<string, string>(), after: new Map<string, string>(), startedAt, plan,
            proposalPath, proposalJsonPath, workspaceFingerprint: `failed:${experimentId}`,
            changedPaths: [] as string[], forbiddenChanges: [] as string[], resourceSlot, preparationError,
          };
        }
      }));

      const seenFingerprints = new Map(state.researchGraph!.nodes.map((node) => [node.workspaceFingerprint, node.id]));
      const evaluated = await Promise.all(prepared.map(async (candidate) => {
        if (candidate.preparationError) {
          return { candidate, evaluation: failedEvaluation(`Candidate preparation failed: ${candidate.preparationError}`), duplicateOf: undefined as string | undefined };
        }
        const existing = seenFingerprints.get(candidate.workspaceFingerprint);
        if (!existing) seenFingerprints.set(candidate.workspaceFingerprint, candidate.experimentId);
        if (candidate.forbiddenChanges.length > 0) {
          const error = `Harness search changed forbidden paths: ${candidate.forbiddenChanges.join(", ")}`;
          return { candidate, evaluation: failedEvaluation(error), duplicateOf: undefined as string | undefined };
        }
        if (candidate.changedPaths.length === 0) {
          const error = "Search suggestion did not change any mutable file";
          return { candidate, evaluation: failedEvaluation(error), duplicateOf: undefined as string | undefined };
        }
        if (existing) {
          const reason = `Skipped duplicate workspace already evaluated as ${existing}`;
          return { candidate, evaluation: skippedEvaluation(reason), duplicateOf: existing };
        }
        try {
          const evaluationConfig: HarnessConfig = {
            ...this.config,
            evaluator: { ...this.config.evaluator, env: { ...this.config.evaluator.env, AUTORESEARCH_RESOURCE_SLOT: candidate.resourceSlot } },
          };
          const evaluation = await evaluateWorkspace(
            evaluationConfig,
            candidate.workspacePath,
            path.join(candidate.experimentDir, "evaluation"),
            candidate.experimentId,
            {
              reference: {
                evaluation: referenceEvaluation,
                workspacePath: referenceWorkspace,
                artifactDir: path.join(candidate.experimentDir, "adaptive-reference"),
                experimentId: `${candidate.experimentId}-adaptive-reference`,
              },
              onStage: (stage) => progress(`${candidate.experimentId} STAGE ${stage.name}: ${stage.pruned ? "pruned" : stage.ok ? "complete" : "failed"}; samples=${stage.attempts.length}${stage.comparison ? `; evidence=${stage.comparison.status}` : ""}`),
            },
          );
          const afterEvaluation = await snapshotWorkspace(candidate.workspacePath);
          const evaluatorMutations = diffSnapshots(candidate.after, afterEvaluation);
          if (evaluatorMutations.length > 0) {
            const error = `Evaluator mutated the candidate workspace: ${evaluatorMutations.join(", ")}`;
            return { candidate, evaluation: { ...evaluation, ok: false, error }, duplicateOf: undefined as string | undefined };
          }
          return { candidate, evaluation, duplicateOf: undefined as string | undefined };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { candidate, evaluation: failedEvaluation(`Candidate evaluation failed: ${message}`), duplicateOf: undefined as string | undefined };
        }
      }));

      const eligibleNodes = evaluated.flatMap(({ candidate, evaluation }) => evaluation.ok && !evaluation.pruned
        ? [candidateNode(candidate.experimentId, candidate.workspacePath, candidate.workspaceFingerprint, evaluation.aggregatedMetrics, referenceId, candidate.assignment.branchDepth, "optimize", candidate.plan.changeCategory)]
        : []);
      const paretoIds = new Set(this.config.metrics.pareto?.enabled
        ? paretoFrontier([
          ...state.researchGraph!.nodes.filter((node) => node.status !== "failed" && node.status !== "discarded"),
          ...eligibleNodes,
        ], configuredObjectives(this.config)).map((node) => node.id)
        : []);
      const decisions = evaluated.map(({ candidate, evaluation, duplicateOf }) => {
        if (duplicateOf) return discardDecision(`Skipped duplicate workspace already evaluated as ${duplicateOf}`);
        return decideResearchCandidate(
          referenceMetrics, evaluation, this.config.metrics.primary, this.config.metrics.guardrails,
          candidate.assignment.branchDepth, this.config.learning.maxBranchDepth,
          this.config.learning.maxTemporaryRegressionRatio, paretoIds.has(candidate.experimentId),
        );
      });
      const promotionWinner = decisions
        .map((decision, offset) => ({ decision, offset }))
        .filter(({ decision }) => decision.status === "promote")
        .sort((left, right) => (right.decision.primaryDelta ?? Number.NEGATIVE_INFINITY) - (left.decision.primaryDelta ?? Number.NEGATIVE_INFINITY))[0]?.offset;

      for (let offset = 0; offset < evaluated.length; offset += 1) {
        const { candidate, evaluation, duplicateOf } = evaluated[offset]!;
        let decision = decisions[offset]!;
        if (decision.status === "promote" && promotionWinner !== offset) {
          decision = { ...decision, status: "retain", reasons: [...decision.reasons, `Parallel batch promotion reserved for stronger candidate ${evaluated[promotionWinner!]!.candidate.experimentId}`] };
        }
        if (decision.status === "retain" && !decision.paretoOptimal) {
          const prospective = candidateNode(
            candidate.experimentId, candidate.workspacePath, candidate.workspaceFingerprint, evaluation.aggregatedMetrics,
            candidate.assignment.parentId, candidate.assignment.branchDepth, "optimize", candidate.plan.changeCategory,
          );
          if (!candidateFitsFrontier(state.researchGraph!, prospective, this.config, this.config.metrics.primary)) {
            decision = { ...decision, status: "discard", reasons: [...decision.reasons, `Candidate did not fit beam width ${this.config.learning.beamWidth}`] };
          }
        }
        if (evaluation.ok) progress(`${candidate.experimentId} RESULT: ${formatEvaluation(evaluation, this.config.metrics.primary.name)}`);
        else progress(`${candidate.experimentId} ${evaluation.skipped ? "SKIP" : "EVALUATION FAILED"}: ${evaluation.error ?? "unknown error"}`);
        const record: ExperimentRecord = {
          id: candidate.experimentId,
          index: candidate.experimentIndex,
          startedAt: candidate.startedAt,
          finishedAt: new Date().toISOString(),
          workspacePath: candidate.workspacePath,
          proposalPath: candidate.proposalPath,
          proposalJsonPath: candidate.proposalJsonPath,
          parentId: candidate.assignment.parentId,
          strategy: "optimize",
          branchDepth: candidate.assignment.branchDepth,
          plan: candidate.plan,
          workspaceFingerprint: candidate.workspaceFingerprint,
          ...(duplicateOf ? { duplicateOf } : {}),
          ...(candidate.assignment.ticketId ? { ticketId: candidate.assignment.ticketId } : {}),
          agentProfileId: "harness-search",
          changedPaths: candidate.changedPaths,
          forbiddenChanges: candidate.forbiddenChanges,
          evaluation,
          decision,
        };
        const profile: AgentProfileConfig = { id: "harness-search", thinkingLevel: "off" };
        const leaderBeforeCommit = state.researchGraph!.leaderId;
        const metricsBeforeCommit = { ...state.acceptedMetrics };
        const bestBeforeCommit = state.bestObserved ? { ...state.bestObserved, metrics: { ...state.bestObserved.metrics } } : undefined;
        const memoryBeforeCommit = state.researchMemory!;
        await commitRecord(record, candidate.assignment, profile, leaderBeforeCommit, metricsBeforeCommit, bestBeforeCommit, memoryBeforeCommit);
      }
    };

    for (let index = state.experiments.length + 1; index <= this.config.budget.maxExperiments; index += 1) {
      if (!await syncControl()) break;
      if (options.signal?.aborted) {
        state.status = "interrupted";
        state.stopReason = "Received interruption signal";
        break;
      }
      if (this.config.budget.maxWallTimeMinutes !== 0 && activeRuntimeMs(state) >= this.config.budget.maxWallTimeMinutes * 60_000) {
        state.stopReason = `Reached wall-time budget of ${this.config.budget.maxWallTimeMinutes} minutes`;
        break;
      }

      const id = `exp-${String(index).padStart(4, "0")}`;
      const assignment = chooseResearchAssignment(state, this.config);
      const requestedConcurrency = this.config.execution?.experimentConcurrency ?? 1;
      if (assignment.strategy === "optimize" && requestedConcurrency > 1) {
        const batchSize = Math.min(requestedConcurrency, this.config.budget.maxExperiments - index + 1);
        await runParallelOptimizationBatch(index, assignment, batchSize);
        index += batchSize - 1;
        if (consecutiveFailures >= this.config.budget.maxConsecutiveFailures) {
          state.stopReason = `Reached ${consecutiveFailures} consecutive failed experiments`;
          break;
        }
        continue;
      }
      const leaderBefore = state.researchGraph!.leaderId;
      const acceptedMetricsBefore = { ...state.acceptedMetrics };
      const bestObservedBefore = state.bestObserved
        ? { ...state.bestObserved, metrics: { ...state.bestObserved.metrics } }
        : undefined;
      const memoryBefore = state.researchMemory!;
      const experimentDir = await prepareExperimentDir(id);
      const workspacePath = path.join(experimentDir, "workspace");
      progress(`${id} START: ${assignment.strategy} from ${assignment.parentId}; leader=${formatCheckpoint(leaderBefore, acceptedMetricsBefore, this.config.metrics.primary.name)}; best-observed=${bestObservedBefore ? formatCheckpoint(bestObservedBefore.experimentId, bestObservedBefore.metrics, this.config.metrics.primary.name) : "none"}; frontier=[${state.researchGraph!.frontierIds.join(", ") || "empty"}]`);
      progress(`${id} GOAL: ${oneLine(assignment.reason)}`);
      if (assignment.targetQuestionId) {
        const question = state.researchMemory!.questions.find((candidate) => candidate.id === assignment.targetQuestionId);
        progress(`${id} QUESTION: ${assignment.targetQuestionId}${question ? ` — ${oneLine(question.text)}` : " (not found in memory)"}`);
      }
      if (assignment.targetLessonId) {
        const lesson = state.researchMemory!.lessons.find((candidate) => candidate.id === assignment.targetLessonId);
        progress(`${id} LESSON TEST: ${assignment.targetLessonId}${lesson ? ` [${lesson.status}] — ${oneLine(lesson.claim)}` : " (not found in memory)"}`);
      }
      await copyWorkspace(assignment.parentWorkspacePath, workspacePath, ignoreRules);
      const before = await snapshotWorkspace(workspacePath);
      const startedAt = new Date().toISOString();
      events.append("experiment_started", { id, index, workspacePath, assignment, acceptedMetrics: state.acceptedMetrics });

      let proposalPath: string | undefined;
      let proposalJsonPath: string | undefined;
      let conclusionPath: string | undefined;
      let conclusionJsonPath: string | undefined;
      let conclusion: ResearchConclusion | undefined;
      let plan: ExperimentPlan | undefined;
      let evaluation: EvaluationResult = failedEvaluation("Experiment did not reach evaluation");
      let pairedEvaluation: PairedEvaluationResult | undefined;
      let decision: DecisionResult = failureDecision("Experiment did not reach a decision");
      let changedPaths: string[] = [];
      let forbiddenChanges: string[] = [];
      let workspaceFingerprint = fingerprintSnapshot(before);
      let duplicateOf: string | undefined;
      let repeatedHypothesisOf: string | undefined;
      let fatalResearcherError: string | undefined;
      let proposalReview: ProposalReview | undefined;
      let proposal: ResearchProposal | undefined;
      let researchContext: ResearchContext | undefined;
      let researcher;
      const agentProfile: AgentProfileConfig = selectAgentProfile(this.config, state.metaResearch!);

      try {
        const automatedPlan = await prepareAutomatedCandidate(this.config, state, assignment, workspacePath, index);
        researchContext = {
          experimentId: id,
          experimentIndex: index,
          workspacePath,
          mutablePaths: this.config.project.mutablePaths,
          protectedPaths: this.config.project.protectedPaths.filter((protectedPath) =>
            !isPathMatched(protectedPath, this.config.project.hiddenPaths ?? [])),
          primaryMetric: this.config.metrics.primary,
          guardrails: this.config.metrics.guardrails,
          evaluationRequests: {
            allowPairedComparison: this.config.evaluator.agentRequests?.allowPairedComparison ?? false,
            maxSeeds: this.config.evaluator.agentRequests?.maxSeeds ?? 5,
            canonicalSeeds: this.config.evaluator.seeds.slice(0, this.config.evaluator.repetitions),
          },
          acceptedMetrics: state.acceptedMetrics,
          assignment,
          memory: memoryForAgent(state.researchMemory!, this.config.learning.maxContextLessons),
          previousExperiments: await previousContext(state, this.config.learning.recentExperiments),
          researchInstructions: this.config.researchInstructions,
          ...(state.campaign ? { campaign: state.campaign } : {}),
          agentRole: "implementer",
        };
        if (automatedPlan) {
          plan = automatedPlan;
          proposal = { narrative: `# Harness-planned ${assignment.strategy}\n\n${assignment.reason}`, plan };
          progress(`${id} PLANNER: prepared deterministic ${assignment.strategy} candidate without an agent mutation session`);
        } else {
          progress(`${id} AGENT [${agentProfile.id}]: inspecting ${assignment.parentId} and preparing one controlled change`);
          researcher = await this.researcherFactory(workspacePath, experimentDir, agentProfile);
          proposal = await researcher.propose(researchContext!);
          if (proposal.agent) state.agent = proposal.agent;
          plan = proposal.plan ?? fallbackPlan(proposal.narrative);
        }
        proposalPath = path.join(experimentDir, "proposal.md");
        proposalJsonPath = path.join(experimentDir, "proposal.json");
        await writeFile(proposalPath, `${proposal.narrative.trim()}\n`, "utf8");
        await writeJsonAtomic(proposalJsonPath, plan);
        progress(`${id} PROPOSAL [${plan.changeCategory}]: ${oneLine(plan.hypothesis)}`);
        progress(`${id} EXPECTED: ${oneLine(plan.expectedEffect)}`);
        if (plan.evaluationRequest) {
          progress(`${id} EVALUATION REQUEST: paired against current leader on fresh seeds [${plan.evaluationRequest.seeds.join(", ")}]; ${oneLine(plan.evaluationRequest.rationale)}`);
        }

        const after = await snapshotWorkspace(workspacePath);
        workspaceFingerprint = fingerprintSnapshot(after);
        changedPaths = diffSnapshots(before, after);
        forbiddenChanges = changedPaths.filter((changedPath) =>
          !isPathMatched(changedPath, this.config.project.mutablePaths)
          || isPathMatched(changedPath, this.config.project.protectedPaths));
        events.append("candidate_prepared", { id, changedPaths, forbiddenChanges, proposalPath, proposalJsonPath, workspaceFingerprint });
        progress(`${id} CHANGE: ${changedPaths.length > 0 ? changedPaths.join(", ") : "no workspace changes"}`);
        if (this.config.agent.roles?.reviewer && researcher?.review && researchContext && proposal) {
          progress(`${id} REVIEW: independent proposal review is checking scope, causal clarity, and evaluation safety`);
          proposalReview = await researcher.review(researchContext, proposal, changedPaths);
          await writeJsonAtomic(path.join(experimentDir, "proposal-review.json"), proposalReview);
          progress(`${id} REVIEW: ${proposalReview.approved ? "approved" : "rejected"}; ${oneLine(proposalReview.summary)}`);
        }

        const duplicateNode = state.researchGraph!.nodes.find((node) => node.workspaceFingerprint === workspaceFingerprint);
        const repeatedExperiment = state.experiments.find((experiment) =>
          experiment.plan && normalizeClaim(experiment.plan.hypothesis) === normalizeClaim(plan!.hypothesis));
        const pairedRequestError = validatePairedRequest(this.config, plan.evaluationRequest);

        if (proposalReview && !proposalReview.approved) {
          const error = `Proposal review rejected the candidate: ${proposalReview.summary}${proposalReview.concerns.length ? ` (${proposalReview.concerns.join("; ")})` : ""}`;
          evaluation = skippedEvaluation(error);
          decision = discardDecision(error);
        } else if (pairedRequestError) {
          evaluation = failedEvaluation(pairedRequestError);
          decision = failureDecision(pairedRequestError);
        } else if (forbiddenChanges.length > 0) {
          const error = `Agent changed forbidden paths: ${forbiddenChanges.join(", ")}`;
          evaluation = failedEvaluation(error);
          decision = failureDecision(error);
        } else if (assignment.strategy === "replicate" && changedPaths.length > 0) {
          const error = `Replication must not change the workspace: ${changedPaths.join(", ")}`;
          evaluation = failedEvaluation(error);
          decision = failureDecision(error);
        } else if (assignment.strategy !== "replicate" && changedPaths.length === 0 && !plan.evaluationRequest) {
          const error = "Agent did not change any mutable file";
          evaluation = failedEvaluation(error);
          decision = failureDecision(error);
        } else if (assignment.strategy !== "replicate" && changedPaths.length === 0 && duplicateNode?.id === leaderBefore) {
          const error = "Paired comparison would compare the current leader with itself; change a candidate or start from a different checkpoint";
          evaluation = failedEvaluation(error);
          decision = failureDecision(error);
        } else if (assignment.strategy !== "replicate" && duplicateNode && !plan.evaluationRequest) {
          duplicateOf = duplicateNode.id;
          const reason = `Skipped duplicate workspace already evaluated as ${duplicateNode.id}`;
          evaluation = skippedEvaluation(reason);
          decision = discardDecision(reason);
        } else if (assignment.strategy !== "replicate" && assignment.strategy !== "falsify" && repeatedExperiment && !plan.evaluationRequest) {
          repeatedHypothesisOf = repeatedExperiment.id;
          const reason = `Skipped repeated hypothesis from ${repeatedExperiment.id}`;
          evaluation = skippedEvaluation(reason);
          decision = discardDecision(reason);
        } else {
          if (plan.evaluationRequest && duplicateNode && assignment.strategy !== "replicate") {
            duplicateOf = duplicateNode.id;
            const reused = checkpointEvaluation(state, duplicateNode.id);
            evaluation = reused ?? failedEvaluation(`Could not reuse canonical evaluation for duplicate checkpoint ${duplicateNode.id}`);
            progress(`${id} EVALUATION: reusing canonical result from ${duplicateNode.id}; fresh-seed comparison will still run`);
          } else {
            progress(`${id} EVALUATION: running ${this.config.evaluator.repetitions} canonical repetition${this.config.evaluator.repetitions === 1 ? "" : "s"} for ${assignment.strategy === "replicate" ? "the unchanged checkpoint" : changedPaths.join(", ")}`);
            evaluation = await evaluateWorkspace(
              this.config,
              workspacePath,
              path.join(experimentDir, "evaluation"),
              id,
              {
                reference: {
                  evaluation: checkpointEvaluation(state, leaderBefore)!,
                  workspacePath: state.acceptedWorkspacePath,
                  artifactDir: path.join(experimentDir, "adaptive-reference"),
                  experimentId: `${id}-adaptive-reference`,
                },
                onStage: (stage) => progress(`${id} STAGE ${stage.name}: ${stage.pruned ? "pruned" : stage.ok ? "complete" : "failed"}; budget=${formatNumber(stage.budgetRatio)}; samples=${stage.attempts.length}${stage.comparison ? `; evidence=${stage.comparison.status}; CI=[${formatNumber(stage.comparison.confidenceInterval.lower)}, ${formatNumber(stage.comparison.confidenceInterval.upper)}]` : ""}`),
              },
            );
          }
          const afterEvaluation = await snapshotWorkspace(workspacePath);
          const evaluatorMutations = diffSnapshots(after, afterEvaluation);
          if (evaluatorMutations.length > 0) {
            const error = `Evaluator mutated the candidate workspace: ${evaluatorMutations.join(", ")}`;
            evaluation = { ...evaluation, ok: false, error };
            decision = failureDecision(error);
          } else {
            const prospective = candidateNode(
              id, workspacePath, workspaceFingerprint, evaluation.aggregatedMetrics,
              assignment.parentId, assignment.branchDepth, assignment.strategy, plan.changeCategory,
            );
            const candidateIsPareto = Boolean(this.config.metrics.pareto?.enabled && paretoFrontier(
              [...state.researchGraph!.nodes.filter((node) => node.status !== "failed" && node.status !== "discarded"), prospective],
              configuredObjectives(this.config),
            ).some((node) => node.id === id));
            decision = decideResearchCandidate(
              state.acceptedMetrics,
              evaluation,
              this.config.metrics.primary,
              this.config.metrics.guardrails,
              assignment.branchDepth,
              this.config.learning.maxBranchDepth,
              this.config.learning.maxTemporaryRegressionRatio,
              candidateIsPareto,
            );

            if (plan.evaluationRequest && evaluation.ok) {
              const referenceBefore = await snapshotWorkspace(state.acceptedWorkspacePath);
              progress(`${id} PAIRED EVALUATION: comparing candidate with ${leaderBefore} on seeds [${plan.evaluationRequest.seeds.join(", ")}]`);
              const reference = await evaluateWorkspace(
                this.config,
                state.acceptedWorkspacePath,
                path.join(experimentDir, "paired-evaluation", "reference"),
                `${id}-paired-reference`,
                { seeds: plan.evaluationRequest.seeds },
              );
              const candidate = await evaluateWorkspace(
                this.config,
                workspacePath,
                path.join(experimentDir, "paired-evaluation", "candidate"),
                `${id}-paired-candidate`,
                {
                  seeds: plan.evaluationRequest.seeds,
                  reference: {
                    evaluation: reference,
                    workspacePath: state.acceptedWorkspacePath,
                    artifactDir: path.join(experimentDir, "paired-evaluation", "adaptive-reference"),
                    experimentId: `${id}-paired-adaptive-reference`,
                  },
                },
              );
              const referenceAfter = await snapshotWorkspace(state.acceptedWorkspacePath);
              const candidateAfter = await snapshotWorkspace(workspacePath);
              const pairedMutations = [
                ...diffSnapshots(referenceBefore, referenceAfter).map((changedPath) => `reference:${changedPath}`),
                ...diffSnapshots(after, candidateAfter).map((changedPath) => `candidate:${changedPath}`),
              ];
              let pairedDecision = decideResearchCandidate(
                reference.aggregatedMetrics,
                candidate,
                this.config.metrics.primary,
                this.config.metrics.guardrails,
                assignment.branchDepth,
                this.config.learning.maxBranchDepth,
                this.config.learning.maxTemporaryRegressionRatio,
              );
              if (!reference.ok) pairedDecision = failureDecision(`Paired reference evaluation failed: ${reference.error ?? "unknown evaluator error"}`);
              if (pairedMutations.length > 0) pairedDecision = failureDecision(`Paired evaluator mutated a workspace: ${pairedMutations.join(", ")}`);
              pairedEvaluation = {
                referenceId: leaderBefore,
                seeds: [...plan.evaluationRequest.seeds],
                rationale: plan.evaluationRequest.rationale,
                reference,
                candidate,
                decision: pairedDecision,
              };
              decision = combinePairedDecision(decision, pairedDecision, leaderBefore);
              if (duplicateOf && (decision.status === "promote" || decision.status === "keep")) {
                decision = {
                  ...decision,
                  status: "retain",
                  reasons: [...decision.reasons, `Fresh-seed evidence was attached to existing checkpoint ${duplicateOf}; duplicate topology was not promoted as a new node`],
                };
              }
            }

            if (assignment.strategy === "replicate" && evaluation.ok) {
              decision = {
                ...decision,
                status: decision.status === "promote" ? "retain" : decision.status,
                reasons: [`Replication of ${assignment.parentId} completed; checkpoint topology is unchanged`, ...decision.reasons],
              };
            } else if (decision.status === "retain" && !decision.paretoOptimal && !duplicateOf) {
              const prospective = candidateNode(
                id,
                workspacePath,
                workspaceFingerprint,
                evaluation.aggregatedMetrics,
                assignment.parentId,
                assignment.branchDepth,
                assignment.strategy,
                plan.changeCategory,
              );
              if (!candidateFitsFrontier(state.researchGraph!, prospective, this.config, this.config.metrics.primary)) {
                decision = { ...decision, status: "discard", reasons: [...decision.reasons, `Candidate did not fit beam width ${this.config.learning.beamWidth}`] };
              }
            }
          }
        }

        if (evaluation.ok) {
          progress(`${id} RESULT: ${formatEvaluation(evaluation, this.config.metrics.primary.name)}`);
        } else if (evaluation.skipped) {
          progress(`${id} SKIP: ${evaluation.error ?? "candidate was skipped"}; evaluator was not run`);
        } else {
          progress(`${id} EVALUATION FAILED: ${evaluation.error ?? "unknown evaluator error"}`);
        }
        if (pairedEvaluation) {
          progress(`${id} PAIRED REFERENCE: ${formatEvaluation(pairedEvaluation.reference, this.config.metrics.primary.name)}`);
          progress(`${id} PAIRED CANDIDATE: ${formatEvaluation(pairedEvaluation.candidate, this.config.metrics.primary.name)}`);
          progress(`${id} PAIRED CHECK: ${pairedEvaluation.decision.status}; primary improvement=${formatSigned(pairedEvaluation.decision.primaryDelta)}; ${pairedEvaluation.decision.reasons.map((reason) => oneLine(reason)).join("; ")}`);
        }

        if (researcher?.reflect) {
          try {
            progress(`${id} REFLECTION: agent is interpreting the result and preparing durable conclusions`);
            conclusion = await researcher.reflect({
              experimentId: id,
              changedPaths,
              acceptedMetricsBefore: state.acceptedMetrics,
              parentMetrics: assignment.parentMetrics,
              assignment,
              plan,
              evaluation,
              ...(pairedEvaluation ? { pairedEvaluation } : {}),
              decision,
            });
            conclusionPath = path.join(experimentDir, "conclusion.md");
            conclusionJsonPath = path.join(experimentDir, "conclusion.json");
            await writeFile(conclusionPath, `${conclusion.narrative.trim()}\n`, "utf8");
            await writeJsonAtomic(conclusionJsonPath, {
              summary: conclusion.summary,
              notes: conclusion.notes,
              lessonUpdates: conclusion.lessonUpdates,
              questionUpdates: conclusion.questionUpdates,
              nextHypotheses: conclusion.nextHypotheses,
            });
            progress(`${id} CONCLUSION: ${oneLine(conclusion.summary)}`);
            const afterReflection = await snapshotWorkspace(workspacePath);
            const reflectionMutations = diffSnapshots(after, afterReflection);
            if (reflectionMutations.length > 0) {
              const error = `Reflection phase mutated the workspace: ${reflectionMutations.join(", ")}`;
              evaluation = { ...evaluation, ok: false, error };
              decision = failureDecision(error);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            events.append("reflection_error", { id, error: message });
            progress(`${id} REFLECTION FAILED: ${oneLine(message)}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        evaluation = failedEvaluation(`Researcher failed: ${message}`);
        decision = failureDecision(evaluation.error!);
        fatalResearcherError = evaluation.error;
        events.append("researcher_error", { id, error: message });
        progress(`${id} AGENT FAILED: ${oneLine(message)}`);
      } finally {
        await researcher?.dispose?.();
      }

      const record: ExperimentRecord = {
        id,
        index,
        startedAt,
        finishedAt: new Date().toISOString(),
        workspacePath,
        parentId: assignment.parentId,
        strategy: assignment.strategy,
        branchDepth: assignment.branchDepth,
        workspaceFingerprint,
        ...(plan ? { plan } : {}),
        ...(conclusion ? { conclusion } : {}),
        ...(proposalPath ? { proposalPath } : {}),
        ...(proposalJsonPath ? { proposalJsonPath } : {}),
        ...(conclusionPath ? { conclusionPath } : {}),
        ...(conclusionJsonPath ? { conclusionJsonPath } : {}),
        ...(duplicateOf ? { duplicateOf } : {}),
        ...(repeatedHypothesisOf ? { repeatedHypothesisOf } : {}),
        ...(assignment.targetLessonId ? { targetLessonId: assignment.targetLessonId } : {}),
        ...(assignment.targetQuestionId ? { targetQuestionId: assignment.targetQuestionId } : {}),
        ...(assignment.ticketId ? { ticketId: assignment.ticketId } : {}),
        agentProfileId: agentProfile.id,
        ...(proposalReview ? { proposalReview } : {}),
        changedPaths,
        forbiddenChanges,
        evaluation,
        ...(pairedEvaluation ? { pairedEvaluation } : {}),
        decision,
      };
      await commitRecord(record, assignment, agentProfile, leaderBefore, acceptedMetricsBefore, bestObservedBefore, memoryBefore);

      if (fatalResearcherError) {
        state.status = "failed";
        state.stopReason = fatalResearcherError;
        break;
      }
      if (consecutiveFailures >= this.config.budget.maxConsecutiveFailures) {
        state.stopReason = `Reached ${consecutiveFailures} consecutive failed experiments`;
        break;
      }
    }

    if (state.status === "running") state.status = "completed";
    state.stopReason ??= state.experiments.length >= this.config.budget.maxExperiments
      ? `Reached experiment budget of ${this.config.budget.maxExperiments}`
      : "Run completed";
    stopActiveSegment(state);
    state.finishedAt = new Date().toISOString();
    state.control = { desiredState: "stopped", updatedAt: state.finishedAt, reason: state.stopReason, heartbeatAt: state.finishedAt };
    await writeRunControl(runDir, state.control);
    await persistState(state);
    await persistProjectKnowledge(this.config, state);
    events.append("run_finished", {
      status: state.status,
      stopReason: state.stopReason,
      acceptedMetrics: state.acceptedMetrics,
      bestObserved: state.bestObserved,
    });
    progress(`Run ${state.status}: ${state.stopReason}; leader=${formatCheckpoint(state.researchGraph?.leaderId ?? "baseline", state.acceptedMetrics, this.config.metrics.primary.name)}; best-observed=${state.bestObserved ? formatCheckpoint(state.bestObserved.experimentId, state.bestObserved.metrics, this.config.metrics.primary.name) : "none"}`);
    return state;
  }
}
