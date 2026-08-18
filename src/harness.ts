import { cp, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DecisionResult,
  EvaluationResult,
  ExperimentPlan,
  ExperimentRecord,
  HarnessConfig,
  AgentProfileConfig,
  AgentUsage,
  AgentEvaluationRequest,
  PairedEvaluationRequest,
  PairedEvaluationResult,
  ParameterSweepRequest,
  ParameterSweepResult,
  ParameterSweepTrial,
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
import { calculateExperimentAccounting, emptyAgentUsage } from "./experiment-accounting.js";
import { EventLog, ensureDir, makeRunId, writeJsonAtomic } from "./io.js";
import { evaluateWorkspace } from "./evaluator.js";
import { readRuntimeManifest } from "./dependency-broker.js";
import { decideResearchCandidate } from "./metrics.js";
import {
  applyExperimentKnowledge,
  createResearchMemory,
  memoryForAgent,
  normalizeClaim,
  recordBaselineFact,
  renderResearchMemory,
} from "./research-memory.js";
import { applyResearchMethodUpdates, createResearchMethodState, methodsForAgent, renderResearchMethods } from "./research-methods.js";
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
  claimRelatedCampaignTicket,
  enqueueCampaignTicket,
  enqueueConclusionHypotheses,
  enqueueEnsembleCandidate,
  enqueueMergeCandidate,
  enqueuePromotionAblations,
  enqueueSliceDiscoveries,
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
import { selectSurrogateSuggestion } from "./surrogate-search.js";
import { allocateResourceLeases } from "./resource-scheduler.js";
import { checkpointCapabilities, evaluationConsumedParameters } from "./evaluation-semantics.js";
import { applySweepValue, mapConcurrent as mapSweepConcurrent, readSweepReferenceValue, resolveParameterSweep } from "./parameter-sweep.js";
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

function pairedRequest(request: AgentEvaluationRequest | undefined): PairedEvaluationRequest | undefined {
  return request?.mode === "paired" ? request : undefined;
}

function sweepRequest(request: AgentEvaluationRequest | undefined): ParameterSweepRequest | undefined {
  return request?.mode === "parameter_sweep" ? request : undefined;
}

function validateEvaluationRequest(config: HarnessConfig, request: AgentEvaluationRequest | undefined): string | undefined {
  if (request?.rationale.startsWith("Invalid agent evaluation request:")) return request.rationale;
  const paired = pairedRequest(request);
  if (paired) return validatePairedRequest(config, paired);
  const sweep = sweepRequest(request);
  if (!sweep) return undefined;
  try {
    resolveParameterSweep(config, sweep);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

function formatEfficiency(costPerImprovementUsd: number | null, timePerImprovementMs: number | null): string {
  if (costPerImprovementUsd === null || timePerImprovementMs === null) return "no positive primary improvement";
  return `cost/+1%=$${formatNumber(costPerImprovementUsd)}; time/+1%=${formatNumber(timePerImprovementMs / 1_000)}s`;
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
  if (state.researchMethods) {
    await writeJsonAtomic(path.join(state.runDir, "research-methods.json"), state.researchMethods);
    await writeFile(path.join(state.runDir, "RESEARCH_METHODS.md"), renderResearchMethods(state.researchMethods), "utf8");
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

function betterPrimary(
  left: ParameterSweepTrial,
  right: ParameterSweepTrial,
  primary: HarnessConfig["metrics"]["primary"],
): number {
  const leftValue = left.evaluation.aggregatedMetrics[primary.name];
  const rightValue = right.evaluation.aggregatedMetrics[primary.name];
  if (leftValue === undefined) return 1;
  if (rightValue === undefined) return -1;
  return primary.direction === "maximize" ? rightValue - leftValue : leftValue - rightValue;
}

function sweepDecisionRank(status: DecisionResult["status"]): number {
  if (status === "promote" || status === "keep") return 0;
  if (status === "retain" || status === "inconclusive") return 1;
  if (status === "discard" || status === "reject") return 2;
  if (status === "pruned") return 3;
  return 4;
}

function betterSweepTrial(
  left: ParameterSweepTrial,
  right: ParameterSweepTrial,
  primary: HarnessConfig["metrics"]["primary"],
): number {
  return sweepDecisionRank(left.decision.status) - sweepDecisionRank(right.decision.status)
    || betterPrimary(left, right, primary);
}

function sweepWork(config: HarnessConfig, evaluation: EvaluationResult): number {
  const configuredStages = config.evaluator.stages?.length
    ? config.evaluator.stages
    : [{ name: "canonical", budgetRatio: 1, pruneIfClearlyWorse: false }];
  return (evaluation.stages ?? []).reduce((sum, stage) => sum + stage.budgetRatio * stage.attempts.length, 0)
    || configuredStages.at(-1)!.budgetRatio * evaluation.attempts.length;
}

async function executeParameterSweep(options: {
  config: HarnessConfig;
  request: ParameterSweepRequest;
  experimentId: string;
  experimentDir: string;
  workspacePath: string;
  parentEvaluation: EvaluationResult;
  parentWorkspacePath: string;
  branchDepth: number;
  resourceRequest?: ExperimentPlan["resourceRequest"];
  ignoreRules: string[];
  progress: (message: string) => void;
}): Promise<{ result: ParameterSweepResult; evaluation: EvaluationResult; decision: DecisionResult; snapshot: Awaited<ReturnType<typeof snapshotWorkspace>> }> {
  const { config, request, experimentId, experimentDir, workspacePath, parentEvaluation, parentWorkspacePath, branchDepth, resourceRequest, ignoreRules, progress } = options;
  const resolved = resolveParameterSweep(config, request);
  const referenceValue = await readSweepReferenceValue(config, workspacePath, resolved.parameter);
  const sweepDir = path.join(experimentDir, "parameter-sweep");
  const trials: ParameterSweepTrial[] = [];
  for (let index = 0; index < resolved.values.length; index += 1) {
    const trialId = `trial-${String(index + 1).padStart(2, "0")}`;
    const trialWorkspace = path.join(sweepDir, "trials", trialId, "workspace");
    await copyWorkspace(workspacePath, trialWorkspace, ignoreRules);
    await applySweepValue(config, trialWorkspace, resolved.parameter, resolved.values[index]!);
    const snapshot = await snapshotWorkspace(trialWorkspace);
    trials.push({
      id: trialId,
      value: resolved.values[index]!,
      status: "pending",
      evaluation: failedEvaluation("Sweep trial has not been evaluated"),
      decision: failureDecision("Sweep trial has not been evaluated"),
      workspacePath: trialWorkspace,
      workspaceFingerprint: fingerprintSnapshot(snapshot),
    });
  }

  const stages = config.evaluator.stages?.length
    ? config.evaluator.stages
    : [{ name: "canonical", budgetRatio: 1, pruneIfClearlyWorse: false }];
  const policy = config.search!.sweeps!;
  const concurrency = Math.min(policy.maxConcurrentTrials, trials.length);
  const leases = allocateResourceLeases(config, Array.from({ length: concurrency }, () => resourceRequest));
  let active = [...trials];

  for (let stageIndex = 0; stageIndex < stages.length && active.length > 0; stageIndex += 1) {
    const stage = stages[stageIndex]!;
    progress(`${experimentId} SWEEP STAGE ${stage.name}: evaluating ${active.length} value${active.length === 1 ? "" : "s"} with concurrency ${concurrency}`);
    await mapSweepConcurrent(active, concurrency, async (trial, index) => {
      const lease = leases[index % leases.length]!;
      const beforeEvaluation = await snapshotWorkspace(trial.workspacePath);
      const evaluationConfig: HarnessConfig = {
        ...config,
        evaluator: { ...config.evaluator, env: {
          ...config.evaluator.env,
          AUTORESEARCH_RESOURCE_SLOT: lease.id,
          AUTORESEARCH_RESOURCE_CPU: String(lease.resource.cpu),
          AUTORESEARCH_RESOURCE_MEMORY_GB: String(lease.resource.memoryGb),
          AUTORESEARCH_RESOURCE_GPU: String(lease.resource.gpu),
          AUTORESEARCH_RESOURCE_VRAM_GB: String(lease.resource.vramGb),
          AUTORESEARCH_SWEEP_PARAMETER: resolved.parameter.name,
          AUTORESEARCH_SWEEP_VALUE: JSON.stringify(trial.value),
          AUTORESEARCH_SWEEP_TRIAL_ID: trial.id,
        } },
      };
      trial.evaluation = await evaluateWorkspace(
        evaluationConfig,
        trial.workspacePath,
        path.join(sweepDir, "trials", trial.id, "evaluation"),
        `${experimentId}-${trial.id}`,
        {
          reference: {
            evaluation: parentEvaluation,
            workspacePath: parentWorkspacePath,
            artifactDir: path.join(sweepDir, "trials", trial.id, "adaptive-reference"),
            experimentId: `${experimentId}-${trial.id}-sweep-reference`,
          },
          startStageIndex: stageIndex,
          endStageIndex: stageIndex,
          ...(stageIndex === 0 ? {} : { previousEvaluation: trial.evaluation, skipPreflight: true }),
          onPhase: (event, context) => progress(`${experimentId} SWEEP ${trial.id}=${JSON.stringify(trial.value)} ${context.stage}/${context.repetition + 1} ${event.phase}: ${event.status}${event.progress === undefined ? "" : ` ${formatNumber(event.progress * 100)}%`}`),
        },
      );
      const mutations = diffSnapshots(beforeEvaluation, await snapshotWorkspace(trial.workspacePath));
      if (mutations.length > 0) {
        trial.evaluation = { ...trial.evaluation, ok: false, error: `Evaluator mutated sweep workspace: ${mutations.join(", ")}` };
      }
      trial.decision = decideResearchCandidate(
        config.metrics.primary.name in parentEvaluation.aggregatedMetrics ? parentEvaluation.aggregatedMetrics : {},
        trial.evaluation,
        config.metrics.primary,
        config.metrics.guardrails,
        branchDepth,
        config.learning.maxBranchDepth,
        config.learning.maxTemporaryRegressionRatio,
      );
      trial.status = trial.evaluation.ok ? "evaluated" : "failed";
      const primaryValue = trial.evaluation.aggregatedMetrics[config.metrics.primary.name];
      progress(`${experimentId} SWEEP ${trial.id}: value=${JSON.stringify(trial.value)}; ${stage.name}=${primaryValue === undefined ? "failed" : formatNumber(primaryValue)}; decision=${trial.decision.status}`);
    });

    active = active.filter((trial) => trial.evaluation.ok && !trial.evaluation.pruned);
    for (const trial of trials.filter((candidate) => candidate.evaluation.pruned && candidate.status !== "pruned")) {
      trial.status = "pruned";
      trial.prunedAtStage = stage.name;
    }
    if (stageIndex < stages.length - 1 && active.length > 1) {
      active.sort((left, right) => betterSweepTrial(left, right, config.metrics.primary));
      const survivorCount = Math.max(1, Math.ceil(active.length / policy.reductionFactor));
      const eliminated = active.slice(survivorCount);
      for (const trial of eliminated) {
        trial.status = "pruned";
        trial.prunedAtStage = stage.name;
        trial.evaluation = { ...trial.evaluation, pruned: true };
        trial.decision = discardDecision(`Sweep trial was pruned after ${stage.name}; ${survivorCount} of ${active.length} values advanced`);
        progress(`${experimentId} SWEEP PRUNE: ${trial.id}=${JSON.stringify(trial.value)} stopped after ${stage.name}`);
      }
      active = active.slice(0, survivorCount);
    }
  }

  const finalists = trials.filter((trial) => trial.status === "evaluated" && trial.evaluation.ok);
  const configuredWork = stages.reduce((sum, stage) => sum + stage.budgetRatio * Math.min(stage.repetitions ?? config.evaluator.repetitions, config.evaluator.seeds.length), 0);
  const actualWork = trials.reduce((sum, trial) => sum + sweepWork(config, trial.evaluation), 0);
  const plannedWork = configuredWork * trials.length;
  const commonResult = {
    parameter: resolved.parameter.name,
    file: resolved.parameter.file,
    path: resolved.parameter.path,
    rationale: request.rationale,
    ...(referenceValue === undefined ? {} : { referenceValue }),
    trials,
    totalDurationMs: trials.reduce((sum, trial) => sum + (trial.evaluation.totalDurationMs ?? 0), 0),
    computeSavedRatio: Math.max(0, Math.min(1, 1 - actualWork / Math.max(plannedWork, Number.EPSILON))),
  };
  if (finalists.length === 0) {
    const result: ParameterSweepResult = commonResult;
    const error = `Parameter sweep produced no fully evaluated trial: ${trials.map((trial) => `${trial.id}=${trial.evaluation.error ?? trial.status}`).join("; ")}`;
    await writeJsonAtomic(path.join(sweepDir, "result.json"), result);
    return { result, evaluation: failedEvaluation(error), decision: failureDecision(error), snapshot: await snapshotWorkspace(workspacePath) };
  }
  finalists.sort((left, right) => betterSweepTrial(left, right, config.metrics.primary));
  const winner = finalists[0]!;
  winner.status = "winner";
  await applySweepValue(config, workspacePath, resolved.parameter, winner.value);
  const snapshot = await snapshotWorkspace(workspacePath);
  const result: ParameterSweepResult = {
    ...commonResult,
    winnerTrialId: winner.id,
    selectedValue: winner.value,
  };
  await writeJsonAtomic(path.join(sweepDir, "result.json"), result);
  progress(`${experimentId} SWEEP WINNER: ${winner.id}; ${resolved.parameter.name}=${JSON.stringify(winner.value)}; ${formatEvaluation(winner.evaluation, config.metrics.primary.name)}; saved=${formatNumber(result.computeSavedRatio * 100)}% planned evaluator work`);
  return { result, evaluation: winner.evaluation, decision: winner.decision, snapshot };
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

async function materializeEnsembleSources(
  config: HarnessConfig,
  state: RunState,
  workspacePath: string,
  sourceExperimentIds: string[],
): Promise<void> {
  const root = path.join(workspacePath, ".autoresearch-ensemble");
  await ensureDir(root);
  const manifest: Array<{ id: string; workspacePath: string; metrics: Record<string, number> }> = [];
  for (const id of sourceExperimentIds) {
    const node = state.researchGraph?.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Cannot resolve ensemble source ${id}`);
    const target = path.join(root, id);
    const visibleMutableFiles = [...(await snapshotWorkspace(node.workspacePath)).keys()].filter((relativePath) =>
      isPathMatched(relativePath, config.project.mutablePaths)
      && !isPathMatched(relativePath, config.project.protectedPaths)
      && !isPathMatched(relativePath, config.project.hiddenPaths));
    for (const relativePath of visibleMutableFiles) await replaceFromWorkspace(node.workspacePath, target, relativePath);
    manifest.push({ id, workspacePath: `./${id}`, metrics: node.metrics });
  }
  await writeJsonAtomic(path.join(root, "manifest.json"), { schemaVersion: 1, sources: manifest });
}

function searchParameter(parameter: SearchParameterConfig): SearchParameter {
  if (parameter.type === "float") {
    return { type: "float", min: parameter.min!, max: parameter.max!, ...(parameter.scale ? { scale: parameter.scale } : {}) };
  }
  if (parameter.type === "integer") return { type: "integer", min: parameter.min!, max: parameter.max! };
  if (parameter.type === "categorical") return { type: "categorical", values: parameter.values! as JsonValue[] };
  return { type: "boolean" };
}

function searchParameterKey(parameter: SearchParameterConfig): string {
  return `${parameter.file}:${parameter.path}`;
}

function retiredSearchParameterKeys(config: HarnessConfig, state: RunState): Set<string> {
  const threshold = config.search?.retireAfterSemanticNoOps ?? 2;
  if (threshold === 0) return new Set();
  const counts = new Map<string, number>();
  for (const experiment of state.experiments) {
    const keys = Object.keys(experiment.plan?.searchSuggestion ?? {});
    const semantic = experiment.evaluation.semantic;
    const explicitInactive = new Set(experiment.evaluation.inactiveSearchParameters ?? []);
    for (const key of keys) {
      if (explicitInactive.has(key) || (experiment.evaluation.semanticDuplicateOf && keys.length === 1)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      } else if (semantic?.reportedConsumedSearchParameters && !semantic.consumedSearchParameters.includes(key)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
}

function annotateInactiveSearchParameters(evaluation: EvaluationResult, plan: ExperimentPlan): EvaluationResult {
  const keys = Object.keys(plan.searchSuggestion ?? {});
  if (keys.length === 0 || !evaluation.semantic?.reportedConsumedSearchParameters) return evaluation;
  const consumed = evaluationConsumedParameters(evaluation);
  const inactive = keys.filter((key) => !consumed.has(key));
  return inactive.length > 0 ? { ...evaluation, inactiveSearchParameters: inactive } : evaluation;
}

async function prepareAutomatedCandidate(
  config: HarnessConfig,
  state: RunState,
  assignment: ResearchContext["assignment"],
  workspacePath: string,
  experimentIndex: number,
): Promise<ExperimentPlan | undefined> {
  if (assignment.strategy === "optimize" && config.search?.enabled) {
    const retiredKeys = retiredSearchParameterKeys(config, state);
    const fullSuggestion: Record<string, string | number | boolean> = {};
    const surrogateSuggestion = assignment.searchSuggestion
      ? undefined
      : selectSurrogateSuggestion(config, state.experiments, experimentIndex);
    const plannedSuggestion = assignment.searchSuggestion ?? surrogateSuggestion;
    if (plannedSuggestion) {
      const knownKeys = new Set(config.search.parameters.map((parameter) => `${parameter.file}:${parameter.path}`));
      const unknownKeys = Object.keys(plannedSuggestion).filter((key) => !knownKeys.has(key));
      if (unknownKeys.length > 0) throw new Error(`Search ticket contains unknown parameter keys: ${unknownKeys.join(", ")}`);
      const retiredRequested = Object.keys(plannedSuggestion).filter((key) => retiredKeys.has(key));
      if (retiredRequested.length > 0) throw new Error(`Search ticket selects parameter(s) retired after semantic no-ops: ${retiredRequested.join(", ")}`);
    }
    const files = new Map<string, typeof config.search.parameters>();
    for (const parameter of config.search.parameters.filter((candidate) => !retiredKeys.has(searchParameterKey(candidate)))) {
      const existing = files.get(parameter.file) ?? [];
      existing.push(parameter);
      files.set(parameter.file, existing);
    }
    const selectedParameters = config.search.parameters.filter((parameter) => Object.hasOwn(fullSuggestion, searchParameterKey(parameter)));
    const capabilities = checkpointCapabilities(state, assignment.parentId);
    const missingCapabilities = [...new Set(selectedParameters.flatMap((parameter) =>
      parameter.requiresCapability && !capabilities.has(parameter.requiresCapability) ? [parameter.requiresCapability] : []))];
    if (missingCapabilities.length > 0) {
      throw new Error(`Checkpoint ${assignment.parentId} does not declare required search capability/capabilities: ${missingCapabilities.join(", ")}`);
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
      hypothesis: `${surrogateSuggestion ? "Surrogate-guided" : "Deterministic"} search suggestion ${JSON.stringify(fullSuggestion)} will improve the current checkpoint.`,
      changeCategory: "optimization",
      expectedEffect: "Measure the suggested parameter configuration against the current leader with staged paired evidence.",
      notes: [assignment.reason, ...(surrogateSuggestion ? ["Selected by the learned cost-aware surrogate acquisition function."] : [])], lessonsUsed: [], contradictedLessons: [], lessonTests: [], questionsAddressed: [],
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
    if (restored && restored.schemaVersion !== 6) throw new Error("Only future schemaVersion 6 runs can be resumed");
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
    progress(`Run configuration: model=${this.config.agent.model ?? "Pi default"}, reasoning=${this.config.agent.thinkingLevel}, backend=${this.config.agent.backend?.type ?? "pi-sdk"}, budget=${this.config.budget.maxExperiments} experiments / ${wallTime}`);
    progress(`Promotion policy: ${this.config.metrics.primary.direction} ${this.config.metrics.primary.name}, minimum improvement=${formatNumber(this.config.metrics.primary.minimumDelta)}${this.config.metrics.guardrails.length > 0 ? `; guardrails=${this.config.metrics.guardrails.map((guardrail) => guardrail.name).join(", ")}` : "; no guardrails"}`);

    const ignoreRules = [...this.config.project.copyIgnore, ".autoresearch-ensemble"];
    if (this.config.agent.lab?.enabled) {
      const relativeLab = path.relative(this.config.project.sourceDir, this.config.agent.lab.path);
      if (relativeLab && relativeLab !== ".." && !relativeLab.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeLab)) {
        ignoreRules.push(relativeLab);
      }
      progress(`Persistent research lab: ${this.config.agent.lab.runner.mode}; engine=${this.config.agent.lab.engine}; root=${this.config.agent.lab.path}`);
    }
    if (this.config.runtimeDependencies?.enabled) {
      const relativeDependencyCache = path.relative(this.config.project.sourceDir, this.config.runtimeDependencies.cachePath);
      if (relativeDependencyCache && relativeDependencyCache !== ".." && !relativeDependencyCache.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDependencyCache)) {
        ignoreRules.push(relativeDependencyCache);
      }
      progress(`Runtime dependency broker: managers=${this.config.runtimeDependencies.allowedManagers.join(", ") || "none"}; manifest=${this.config.runtimeDependencies.manifestPath}; cache=${this.config.runtimeDependencies.cachePath}`);
    }
    const relativeOutput = path.relative(this.config.project.sourceDir, this.config.outputDir);
    if (relativeOutput && relativeOutput !== ".." && !relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput)) {
      ignoreRules.push(relativeOutput);
    }
    const relativeRun = path.relative(this.config.project.sourceDir, runDir);
    if (relativeRun && relativeRun !== ".." && !relativeRun.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeRun)) {
      ignoreRules.push(relativeRun);
    }
    const sharedCacheDir = this.config.evaluator.cache?.enabled
      ? path.join(this.config.evaluator.cache.path, this.config.evaluator.cache.namespace)
      : undefined;
    if (sharedCacheDir) {
      const relativeCache = path.relative(this.config.project.sourceDir, sharedCacheDir);
      if (relativeCache && relativeCache !== ".." && !relativeCache.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeCache)) {
        ignoreRules.push(relativeCache);
      }
      progress(`Evaluator shared cache: ${sharedCacheDir}${this.config.evaluator.cache!.readOnly ? " (read-only)" : " (read-write)"}`);
    }

    let state: RunState;
    if (restored) {
      state = restored;
      if (!state.researchGraph || !state.researchMemory) throw new Error("Run is missing schemaVersion 6 research state");
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
        schemaVersion: 6, runId, name: this.config.name, status: baseline.ok ? "running" : "failed", startedAt: createdAt,
        configPath: path.resolve(options.configPath), runDir, sourceDir: this.config.project.sourceDir,
        agent: { ...(this.config.agent.model ? { model: this.config.agent.model } : {}), thinkingLevel: this.config.agent.thinkingLevel, backend: this.config.agent.backend?.type ?? "pi-sdk" },
        primaryMetric: this.config.metrics.primary, guardrails: this.config.metrics.guardrails, objectives: this.config.metrics.objectives ?? [], acceptedWorkspacePath: baselineWorkspace, baseline,
        acceptedMetrics: baseline.aggregatedMetrics,
        bestObserved: { experimentId: "baseline", workspacePath: baselineWorkspace, metrics: baseline.aggregatedMetrics, decisionStatus: "baseline" },
        researchMemory: importProjectLessons(recordBaselineFact(createResearchMemory(this.config, createdAt), baseline, baselineFingerprint, new Date().toISOString()), projectKnowledge),
        researchMethods: createResearchMethodState(),
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
      const { id, index, workspacePath, evaluation, decision, workspaceFingerprint = "", pairedEvaluation, parameterSweep, duplicateOf, repeatedHypothesisOf } = record;
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
      state.researchMethods = applyResearchMethodUpdates(state.researchMethods, record, this.config.learning.refinement);
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
          enqueueEnsembleCandidate(state.campaign, state.researchGraph!, state.experiments, this.config);
          enqueueSliceDiscoveries(state.campaign, record, this.config);
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
      events.append("experiment_decided", { id, assignment, decision, evaluation, pairedEvaluation, parameterSweep, accounting: record.accounting, duplicateOf, repeatedHypothesisOf });
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
      let leases = allocateResourceLeases(this.config, Array.from({ length: batchSize }, () => undefined));
      progress(`${firstAssignment.strategy === "optimize" ? "SEARCH" : "AGENT"} FAMILY: preparing ${batchSize} independent candidates in parallel from ${referenceId}`);
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
        const lease = leases[offset]!;
        const resourceSlot = lease.id;
        const agentProfile: AgentProfileConfig = firstAssignment.strategy === "optimize"
          ? { id: "harness-search", thinkingLevel: "off" }
          : selectAgentProfile(this.config, state.metaResearch!);
        let researcher: Awaited<ReturnType<ResearcherFactory>> | undefined;
        try {
          experimentDir = await prepareExperimentDir(experimentId);
          workspacePath = path.join(experimentDir, "workspace");
          progress(`${experimentId} START: ${assignment.strategy} from ${referenceId}; resource=${resourceSlot}`);
          await copyWorkspace(firstAssignment.parentWorkspacePath, workspacePath, ignoreRules);
          if (assignment.strategy === "ensemble" && assignment.ensemble) {
            await materializeEnsembleSources(this.config, state, workspacePath, assignment.ensemble.sourceExperimentIds);
          }
          const before = await snapshotWorkspace(workspacePath);
          events.append("experiment_started", { id: experimentId, index: experimentIndex, workspacePath, assignment, acceptedMetrics: referenceMetrics, parallelBatch: startIndex });
          let plan = await prepareAutomatedCandidate(this.config, state, assignment, workspacePath, experimentIndex);
          let narrative = `# Harness-planned parallel ${assignment.strategy}\n\n${assignment.reason}`;
          if (!plan) {
            researcher = await this.researcherFactory(workspacePath, experimentDir, agentProfile);
            if (researcher.capabilities) state.agent = { ...state.agent!, capabilities: researcher.capabilities };
            const proposal = await researcher.propose({
              experimentId: experimentId,
              experimentIndex,
              workspacePath,
              mutablePaths: this.config.project.mutablePaths,
              protectedPaths: this.config.project.protectedPaths,
              primaryMetric: this.config.metrics.primary,
              guardrails: this.config.metrics.guardrails,
              evaluationRequests: {
                allowPairedComparison: false,
                maxSeeds: 0,
                canonicalSeeds: this.config.evaluator.seeds.slice(0, this.config.evaluator.repetitions),
                allowParameterSweep: false,
                maxSweepValues: 0,
                sweepParameters: [],
              },
              analysis: {
                enabled: this.config.agent.analysis?.enabled ?? false,
                runner: this.config.agent.analysis?.runner.mode ?? "docker",
                maxCalls: this.config.agent.analysis?.maxCalls ?? 0,
                timeoutSeconds: this.config.agent.analysis?.timeoutSeconds ?? 0,
                runtime: {
                  pythonCommand: this.config.agent.analysis?.runtime?.pythonCommand ?? ["python3"],
                  ...(this.config.agent.analysis?.runtime?.testCommand
                    ? { testCommand: this.config.agent.analysis.runtime.testCommand }
                    : {}),
                  projectPathEntries: this.config.agent.analysis?.runtime?.projectPathEntries ?? ["."],
                },
                jobsEnabled: this.config.agent.analysis?.jobs?.enabled ?? true,
                requireFreshEvidenceAfterMutation: this.config.agent.analysis?.evidence?.requireFreshAfterMutation ?? true,
                dependencies: {
                  enabled: this.config.runtimeDependencies?.enabled ?? false,
                  ...(this.config.runtimeDependencies ? { manifestPath: this.config.runtimeDependencies.manifestPath } : {}),
                  allowedManagers: this.config.runtimeDependencies?.allowedManagers ?? [],
                  environmentProfiles: Object.keys(this.config.runtimeDependencies?.environmentProfiles ?? {}),
                },
              },
              acceptedMetrics: referenceMetrics,
              assignment,
              memory: memoryForAgent(state.researchMemory!, this.config.learning.maxContextLessons),
              methods: methodsForAgent(state.researchMethods),
              previousExperiments: await previousContext(state, this.config.learning.recentExperiments),
              researchInstructions: this.config.researchInstructions,
              ...(state.campaign ? { campaign: state.campaign } : {}),
              agentRole: "implementer",
            });
            plan = proposal.plan ?? fallbackPlan(proposal.narrative);
            narrative = proposal.narrative;
          }
          if (assignment.ensemble && !plan.ensemble) plan.ensemble = assignment.ensemble;
          if (state.campaign && !assignment.ticketId) {
            const related = claimRelatedCampaignTicket(
              state.campaign,
              experimentId,
              plan.hypothesis,
              this.config.learning.campaign?.semanticClaimThreshold ?? 0.65,
            );
            if (related) {
              assignment.ticketId = related.id;
              progress(`${experimentId} CAMPAIGN: semantically claimed ${related.id}`);
            }
          }
          await writeFile(proposalPath, `${narrative.trim()}\n`, "utf8");
          await writeJsonAtomic(proposalJsonPath, plan);
          const after = await snapshotWorkspace(workspacePath);
          const workspaceFingerprint = fingerprintSnapshot(after);
          const changedPaths = diffSnapshots(before, after);
          const forbiddenChanges = changedPaths.filter((changedPath) =>
            !isPathMatched(changedPath, this.config.project.mutablePaths)
            || isPathMatched(changedPath, this.config.project.protectedPaths)
            || changedPath === ".autoresearch-ensemble"
            || changedPath.startsWith(".autoresearch-ensemble/"));
          events.append("candidate_prepared", { id: experimentId, changedPaths, forbiddenChanges, workspaceFingerprint, parallelBatch: startIndex });
          progress(`${experimentId} CANDIDATE: ${oneLine(plan.hypothesis)}; changed=${changedPaths.join(", ") || "none"}`);
          return {
            experimentIndex, experimentId, assignment, experimentDir, workspacePath, before, after, startedAt, plan,
            proposalPath, proposalJsonPath, workspaceFingerprint, changedPaths, forbiddenChanges, resourceSlot,
            researcher, agentProfile,
            preparationError: undefined as string | undefined,
          };
        } catch (error) {
          const preparationError = error instanceof Error ? error.message : String(error);
          await researcher?.dispose?.();
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
            researcher: undefined, agentProfile,
          };
        }
      }));
      try {
        leases = allocateResourceLeases(this.config, prepared.map((candidate) => candidate.plan.resourceRequest));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const candidate of prepared) {
          candidate.preparationError = `Resource scheduling failed: ${message}`;
          await candidate.researcher?.dispose?.();
          candidate.researcher = undefined;
        }
      }
      for (let offset = 0; offset < prepared.length; offset += 1) {
        prepared[offset]!.resourceSlot = leases[offset]!.id;
        prepared[offset]!.assignment.resourceId = leases[offset]!.id;
        progress(`${prepared[offset]!.experimentId} RESOURCE: ${leases[offset]!.id} selected for ${JSON.stringify(prepared[offset]!.plan.resourceRequest ?? {})}`);
      }

      const seenFingerprints = new Map(state.researchGraph!.nodes.map((node) => [node.workspaceFingerprint, node.id]));
      const pending = prepared.map((candidate) => {
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
        return { candidate, evaluation: undefined as EvaluationResult | undefined, duplicateOf: undefined as string | undefined };
      });
      const evaluateCandidate = async (
        entry: (typeof pending)[number],
        startStageIndex?: number,
        previousEvaluation?: EvaluationResult,
      ): Promise<(typeof pending)[number]> => {
        const { candidate } = entry;
        try {
          const resource = leases.find((lease) => lease.id === candidate.resourceSlot)!.resource;
          const evaluationConfig: HarnessConfig = {
            ...this.config,
            evaluator: { ...this.config.evaluator, env: {
              ...this.config.evaluator.env,
              AUTORESEARCH_RESOURCE_SLOT: candidate.resourceSlot,
              AUTORESEARCH_RESOURCE_CPU: String(resource.cpu),
              AUTORESEARCH_RESOURCE_MEMORY_GB: String(resource.memoryGb),
              AUTORESEARCH_RESOURCE_GPU: String(resource.gpu),
              AUTORESEARCH_RESOURCE_VRAM_GB: String(resource.vramGb),
            } },
          };
          let evaluation = await evaluateWorkspace(
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
              semanticReferences: candidate.assignment.strategy === "replicate"
                ? []
                : [{ id: candidate.assignment.parentId, evaluation: checkpointEvaluation(state, candidate.assignment.parentId)! }],
              ...(startStageIndex === undefined ? {} : {
                startStageIndex,
                endStageIndex: startStageIndex,
                ...(previousEvaluation ? { previousEvaluation, skipPreflight: true } : {}),
              }),
              onStage: (stage) => progress(`${candidate.experimentId} STAGE ${stage.name}: ${stage.pruned ? "pruned" : stage.ok ? "complete" : "failed"}; samples=${stage.attempts.length}${stage.comparison ? `; evidence=${stage.comparison.status}` : ""}`),
              onPhase: (event, context) => progress(`${candidate.experimentId} EVAL ${context.stage}/${context.repetition + 1} ${event.phase}: ${event.status}${event.progress === undefined ? "" : ` ${formatNumber(event.progress * 100)}%`}${event.durationMs === undefined ? "" : `; ${formatNumber(event.durationMs / 1_000)}s`}`),
            },
          );
          evaluation = annotateInactiveSearchParameters(evaluation, candidate.plan);
          const afterEvaluation = await snapshotWorkspace(candidate.workspacePath);
          const evaluatorMutations = diffSnapshots(candidate.after, afterEvaluation);
          if (evaluatorMutations.length > 0) {
            const error = `Evaluator mutated the candidate workspace: ${evaluatorMutations.join(", ")}`;
            return { candidate, evaluation: { ...evaluation, ok: false, error }, duplicateOf: undefined as string | undefined };
          }
          return { candidate, evaluation, duplicateOf: evaluation.semanticDuplicateOf ?? entry.duplicateOf };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { candidate, evaluation: failedEvaluation(`Candidate evaluation failed: ${message}`), duplicateOf: entry.duplicateOf };
        }
      };
      const asha = this.config.execution?.asha;
      let active = pending.filter((entry) => entry.evaluation === undefined);
      if (asha?.enabled && (this.config.evaluator.stages?.length ?? 0) > 1 && active.length > 1) {
        const stages = this.config.evaluator.stages!;
        for (let stageIndex = 0; stageIndex < stages.length && active.length > 0; stageIndex += 1) {
          progress(`ASHA RUNG ${stageIndex + 1}/${stages.length}: evaluating ${active.length} candidates at budget=${stages[stageIndex]!.budgetRatio}`);
          const rung = await Promise.all(active.map((entry) => evaluateCandidate(entry, stageIndex, entry.evaluation)));
          for (const evaluatedEntry of rung) {
            const index = pending.findIndex((entry) => entry.candidate.experimentId === evaluatedEntry.candidate.experimentId);
            pending[index] = evaluatedEntry;
          }
          if (stageIndex === stages.length - 1) {
            active = rung;
            break;
          }
          const viable = rung.filter((entry) => entry.evaluation?.ok && !entry.evaluation.pruned);
          const primaryName = this.config.metrics.primary.name;
          viable.sort((left, right) => {
            const leftValue = left.evaluation!.aggregatedMetrics[primaryName]!;
            const rightValue = right.evaluation!.aggregatedMetrics[primaryName]!;
            return this.config.metrics.primary.direction === "maximize" ? rightValue - leftValue : leftValue - rightValue;
          });
          const promoted = new Set(viable.slice(0, Math.max(1, Math.ceil(viable.length / asha.reductionFactor)))
            .map((entry) => entry.candidate.experimentId));
          for (const entry of viable.filter((candidate) => !promoted.has(candidate.candidate.experimentId))) {
            entry.evaluation = { ...entry.evaluation!, pruned: true };
            progress(`${entry.candidate.experimentId} ASHA PRUNE: did not advance from rung ${stages[stageIndex]!.name}`);
          }
          active = viable.filter((entry) => promoted.has(entry.candidate.experimentId));
        }
      } else {
        const completed = await Promise.all(active.map((entry) => evaluateCandidate(entry)));
        for (const evaluatedEntry of completed) {
          const index = pending.findIndex((entry) => entry.candidate.experimentId === evaluatedEntry.candidate.experimentId);
          pending[index] = evaluatedEntry;
        }
      }
      const evaluated = pending.map((entry) => ({ ...entry, evaluation: entry.evaluation ?? failedEvaluation("Candidate was not evaluated") }));

      const eligibleNodes = evaluated.flatMap(({ candidate, evaluation }) => evaluation.ok && !evaluation.pruned
        ? [candidateNode(candidate.experimentId, candidate.workspacePath, candidate.workspaceFingerprint, evaluation.aggregatedMetrics, referenceId, candidate.assignment.branchDepth, candidate.assignment.strategy, candidate.plan.changeCategory)]
        : []);
      const paretoIds = new Set(this.config.metrics.pareto?.enabled
        ? paretoFrontier([
          ...state.researchGraph!.nodes.filter((node) => node.status !== "failed" && node.status !== "discarded"),
          ...eligibleNodes,
        ], configuredObjectives(this.config)).map((node) => node.id)
        : []);
      const decisions = evaluated.map(({ candidate, evaluation, duplicateOf }) => {
        if (duplicateOf) return discardDecision(evaluation.semanticDuplicateOf
          ? `Prediction hash matches checkpoint ${duplicateOf}; candidate is a semantic no-op`
          : `Skipped duplicate workspace already evaluated as ${duplicateOf}`);
        if (evaluation.inactiveSearchParameters?.length) {
          return discardDecision(`Evaluator did not consume configured search parameter(s): ${evaluation.inactiveSearchParameters.join(", ")}`);
        }
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
            candidate.assignment.parentId, candidate.assignment.branchDepth, candidate.assignment.strategy, candidate.plan.changeCategory,
          );
          if (!candidateFitsFrontier(state.researchGraph!, prospective, this.config, this.config.metrics.primary)) {
            decision = { ...decision, status: "discard", reasons: [...decision.reasons, `Candidate did not fit beam width ${this.config.learning.beamWidth}`] };
          }
        }
        if (evaluation.ok) progress(`${candidate.experimentId} RESULT: ${formatEvaluation(evaluation, this.config.metrics.primary.name)}`);
        else progress(`${candidate.experimentId} ${evaluation.skipped ? "SKIP" : "EVALUATION FAILED"}: ${evaluation.error ?? "unknown error"}`);
        if (evaluation.semanticDuplicateOf) progress(`${candidate.experimentId} SEMANTIC NO-OP: prediction hashes match ${evaluation.semanticDuplicateOf}; later evaluation stages were skipped`);
        if (evaluation.inactiveSearchParameters?.length) progress(`${candidate.experimentId} INACTIVE SEARCH: evaluator did not consume ${evaluation.inactiveSearchParameters.join(", ")}`);
        let conclusion: ResearchConclusion | undefined;
        let conclusionPath: string | undefined;
        let conclusionJsonPath: string | undefined;
        if (candidate.researcher?.reflect) {
          try {
            conclusion = await candidate.researcher.reflect({
              experimentId: candidate.experimentId,
              changedPaths: candidate.changedPaths,
              acceptedMetricsBefore: referenceMetrics,
              parentMetrics: candidate.assignment.parentMetrics,
              assignment: candidate.assignment,
              plan: candidate.plan,
              evaluation,
              decision,
            });
            conclusionPath = path.join(candidate.experimentDir, "conclusion.md");
            conclusionJsonPath = path.join(candidate.experimentDir, "conclusion.json");
            await writeFile(conclusionPath, `${conclusion.narrative.trim()}\n`, "utf8");
            await writeJsonAtomic(conclusionJsonPath, {
              summary: conclusion.summary,
              notes: conclusion.notes,
              lessonUpdates: conclusion.lessonUpdates,
              methodUpdates: conclusion.methodUpdates ?? [],
              questionUpdates: conclusion.questionUpdates,
              nextHypotheses: conclusion.nextHypotheses,
            });
          } catch (error) {
            progress(`${candidate.experimentId} REFLECTION FAILED: ${oneLine(error instanceof Error ? error.message : String(error))}`);
          }
        }
        const agentUsage = candidate.researcher?.getUsage?.() ?? emptyAgentUsage();
        await candidate.researcher?.dispose?.();
        const finishedAt = new Date().toISOString();
        const accounting = calculateExperimentAccounting({
          startedAt: candidate.startedAt,
          finishedAt,
          primaryDelta: decision.primaryDelta,
          parentPrimaryValue: candidate.assignment.parentMetrics[this.config.metrics.primary.name],
          agentUsage,
          evaluation,
        });
        await writeJsonAtomic(path.join(candidate.experimentDir, "accounting.json"), accounting);
        const runtimeEnvironment = await readRuntimeManifest(this.config, candidate.workspacePath).catch(() => undefined);
        const record: ExperimentRecord = {
          id: candidate.experimentId,
          index: candidate.experimentIndex,
          startedAt: candidate.startedAt,
          finishedAt,
          workspacePath: candidate.workspacePath,
          proposalPath: candidate.proposalPath,
          proposalJsonPath: candidate.proposalJsonPath,
          ...(conclusionPath ? { conclusionPath } : {}),
          ...(conclusionJsonPath ? { conclusionJsonPath } : {}),
          parentId: candidate.assignment.parentId,
          strategy: candidate.assignment.strategy,
          branchDepth: candidate.assignment.branchDepth,
          plan: candidate.plan,
          workspaceFingerprint: candidate.workspaceFingerprint,
          ...(duplicateOf ? { duplicateOf } : {}),
          ...(candidate.assignment.ticketId ? { ticketId: candidate.assignment.ticketId } : {}),
          ...(conclusion ? { conclusion } : {}),
          ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
          agentProfileId: candidate.agentProfile.id,
          executionKind: candidate.agentProfile.id === "harness-search" ? "deterministic-search" : "agent",
          changedPaths: candidate.changedPaths,
          forbiddenChanges: candidate.forbiddenChanges,
          evaluation,
          decision,
          accounting,
        };
        progress(`${candidate.experimentId} EFFICIENCY: duration=${formatNumber(accounting.durationMs / 1_000)}s; agent cost=$${formatNumber(accounting.agentUsage.costUsd)}; ${formatEfficiency(accounting.costPerImprovementUsd, accounting.timePerImprovementMs)}`);
        const profile: AgentProfileConfig = candidate.agentProfile;
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
      const agentFamily = Boolean(this.config.execution?.asha?.enabled && this.config.execution.asha.agentCandidates);
      if (requestedConcurrency > 1 && (assignment.strategy === "optimize" || agentFamily)) {
        const requestedFamilySize = this.config.execution?.asha?.enabled
          ? Math.min(this.config.execution.asha.familySize, requestedConcurrency)
          : requestedConcurrency;
        const batchSize = Math.min(requestedFamilySize, this.config.budget.maxExperiments - index + 1);
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
      const startedAt = new Date().toISOString();
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
      if (assignment.strategy === "ensemble" && assignment.ensemble) {
        await materializeEnsembleSources(this.config, state, workspacePath, assignment.ensemble.sourceExperimentIds);
        progress(`${id} ENSEMBLE: materialized read-only source snapshots [${assignment.ensemble.sourceExperimentIds.join(", ")}] under .autoresearch-ensemble`);
      }
      const before = await snapshotWorkspace(workspacePath);
      events.append("experiment_started", { id, index, workspacePath, assignment, acceptedMetrics: state.acceptedMetrics });

      let proposalPath: string | undefined;
      let proposalJsonPath: string | undefined;
      let conclusionPath: string | undefined;
      let conclusionJsonPath: string | undefined;
      let conclusion: ResearchConclusion | undefined;
      let plan: ExperimentPlan | undefined;
      let evaluation: EvaluationResult = failedEvaluation("Experiment did not reach evaluation");
      let pairedEvaluation: PairedEvaluationResult | undefined;
      let parameterSweep: ParameterSweepResult | undefined;
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
      let agentUsage: AgentUsage = emptyAgentUsage();
      let executionKind: NonNullable<ExperimentRecord["executionKind"]> = assignment.strategy === "replicate" ? "replication" : "agent";
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
            allowParameterSweep: Boolean(this.config.search?.enabled && this.config.search.sweeps?.enabled),
            maxSweepValues: this.config.search?.sweeps?.maxValues ?? 0,
            sweepParameters: (this.config.search?.parameters ?? []).map((parameter) => ({
              name: parameter.name,
              type: parameter.type,
              file: parameter.file,
              path: parameter.path,
              ...(parameter.min === undefined ? {} : { min: parameter.min }),
              ...(parameter.max === undefined ? {} : { max: parameter.max }),
              ...(parameter.values === undefined ? {} : { values: parameter.values }),
            })),
          },
          analysis: {
            enabled: this.config.agent.analysis?.enabled ?? false,
            runner: this.config.agent.analysis?.runner.mode ?? "docker",
            maxCalls: this.config.agent.analysis?.maxCalls ?? 0,
            timeoutSeconds: this.config.agent.analysis?.timeoutSeconds ?? 0,
            runtime: {
              pythonCommand: this.config.agent.analysis?.runtime?.pythonCommand ?? ["python3"],
              ...(this.config.agent.analysis?.runtime?.testCommand
                ? { testCommand: this.config.agent.analysis.runtime.testCommand }
                : {}),
              projectPathEntries: this.config.agent.analysis?.runtime?.projectPathEntries ?? ["."],
            },
            jobsEnabled: this.config.agent.analysis?.jobs?.enabled ?? true,
            requireFreshEvidenceAfterMutation: this.config.agent.analysis?.evidence?.requireFreshAfterMutation ?? true,
            dependencies: {
              enabled: this.config.runtimeDependencies?.enabled ?? false,
              ...(this.config.runtimeDependencies ? { manifestPath: this.config.runtimeDependencies.manifestPath } : {}),
              allowedManagers: this.config.runtimeDependencies?.allowedManagers ?? [],
              environmentProfiles: Object.keys(this.config.runtimeDependencies?.environmentProfiles ?? {}),
            },
          },
          acceptedMetrics: state.acceptedMetrics,
          assignment,
          memory: memoryForAgent(state.researchMemory!, this.config.learning.maxContextLessons),
          methods: methodsForAgent(state.researchMethods),
          previousExperiments: await previousContext(state, this.config.learning.recentExperiments),
          researchInstructions: this.config.researchInstructions,
          ...(state.campaign ? { campaign: state.campaign } : {}),
          agentRole: "implementer",
        };
        if (automatedPlan) {
          executionKind = assignment.strategy === "optimize" ? "deterministic-search" : "harness";
          plan = automatedPlan;
          proposal = { narrative: `# Harness-planned ${assignment.strategy}\n\n${assignment.reason}`, plan };
          progress(`${id} PLANNER: prepared deterministic ${assignment.strategy} candidate without an agent mutation session`);
        } else {
          progress(`${id} AGENT [${agentProfile.id}]: inspecting ${assignment.parentId} and preparing one controlled change`);
          researcher = await this.researcherFactory(workspacePath, experimentDir, agentProfile);
          if (researcher.capabilities) state.agent = { ...state.agent!, capabilities: researcher.capabilities };
          proposal = await researcher.propose(researchContext!);
          if (proposal.agent) state.agent = { ...state.agent, ...proposal.agent };
          plan = proposal.plan ?? fallbackPlan(proposal.narrative);
        }
        if (assignment.ensemble && !plan.ensemble) plan.ensemble = assignment.ensemble;
        if (state.campaign && !assignment.ticketId) {
          const related = claimRelatedCampaignTicket(
            state.campaign,
            id,
            plan.hypothesis,
            this.config.learning.campaign?.semanticClaimThreshold ?? 0.65,
          );
          if (related) {
            assignment.ticketId = related.id;
            progress(`${id} CAMPAIGN: semantically claimed ${related.id}`);
          }
        }
        proposalPath = path.join(experimentDir, "proposal.md");
        proposalJsonPath = path.join(experimentDir, "proposal.json");
        await writeFile(proposalPath, `${proposal.narrative.trim()}\n`, "utf8");
        await writeJsonAtomic(proposalJsonPath, plan);
        progress(`${id} PROPOSAL [${plan.changeCategory}]: ${oneLine(plan.hypothesis)}`);
        progress(`${id} EXPECTED: ${oneLine(plan.expectedEffect)}`);
        const requestedPair = pairedRequest(plan.evaluationRequest);
        const requestedSweep = sweepRequest(plan.evaluationRequest);
        if (requestedPair) progress(`${id} EVALUATION REQUEST: paired against current leader on fresh seeds [${requestedPair.seeds.join(", ")}]; ${oneLine(requestedPair.rationale)}`);
        if (requestedSweep) progress(`${id} EVALUATION REQUEST: sweep ${requestedSweep.parameter} across [${requestedSweep.values.map((value) => JSON.stringify(value)).join(", ")}]; ${oneLine(requestedSweep.rationale)}`);

        let after = await snapshotWorkspace(workspacePath);
        workspaceFingerprint = fingerprintSnapshot(after);
        changedPaths = diffSnapshots(before, after);
        forbiddenChanges = changedPaths.filter((changedPath) =>
          !isPathMatched(changedPath, this.config.project.mutablePaths)
          || isPathMatched(changedPath, this.config.project.protectedPaths)
          || changedPath === ".autoresearch-ensemble"
          || changedPath.startsWith(".autoresearch-ensemble/"));
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
        const evaluationRequestError = validateEvaluationRequest(this.config, plan.evaluationRequest);

        if (proposalReview && !proposalReview.approved) {
          const error = `Proposal review rejected the candidate: ${proposalReview.summary}${proposalReview.concerns.length ? ` (${proposalReview.concerns.join("; ")})` : ""}`;
          evaluation = skippedEvaluation(error);
          decision = discardDecision(error);
        } else if (evaluationRequestError) {
          evaluation = failedEvaluation(evaluationRequestError);
          decision = failureDecision(evaluationRequestError);
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
        } else if (assignment.strategy !== "replicate" && changedPaths.length === 0 && duplicateNode?.id === leaderBefore && requestedPair) {
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
          if (requestedSweep) {
            executionKind = "parameter-sweep";
            const sweepExecution = await executeParameterSweep({
              config: this.config,
              request: requestedSweep,
              experimentId: id,
              experimentDir,
              workspacePath,
              parentEvaluation: checkpointEvaluation(state, leaderBefore)!,
              parentWorkspacePath: state.acceptedWorkspacePath,
              branchDepth: assignment.branchDepth,
              ...(plan.resourceRequest ? { resourceRequest: plan.resourceRequest } : {}),
              ignoreRules,
              progress,
            });
            parameterSweep = sweepExecution.result;
            evaluation = sweepExecution.evaluation;
            decision = sweepExecution.decision;
            after = sweepExecution.snapshot;
            workspaceFingerprint = fingerprintSnapshot(after);
            changedPaths = diffSnapshots(before, after);
            forbiddenChanges = changedPaths.filter((changedPath) =>
              !isPathMatched(changedPath, this.config.project.mutablePaths)
              || isPathMatched(changedPath, this.config.project.protectedPaths));
            events.append("parameter_sweep_completed", { id, parameterSweep, decision });
          } else {
          const lease = allocateResourceLeases(this.config, [plan.resourceRequest])[0]!;
          assignment.resourceId = lease.id;
          const evaluationConfig: HarnessConfig = {
            ...this.config,
            evaluator: { ...this.config.evaluator, env: {
              ...this.config.evaluator.env,
              AUTORESEARCH_RESOURCE_SLOT: lease.id,
              AUTORESEARCH_RESOURCE_CPU: String(lease.resource.cpu),
              AUTORESEARCH_RESOURCE_MEMORY_GB: String(lease.resource.memoryGb),
              AUTORESEARCH_RESOURCE_GPU: String(lease.resource.gpu),
              AUTORESEARCH_RESOURCE_VRAM_GB: String(lease.resource.vramGb),
            } },
          };
          progress(`${id} RESOURCE: ${lease.id} selected for ${JSON.stringify(plan.resourceRequest ?? {})}`);
          if (requestedPair && duplicateNode && assignment.strategy !== "replicate") {
            duplicateOf = duplicateNode.id;
            const reused = checkpointEvaluation(state, duplicateNode.id);
            evaluation = reused ?? failedEvaluation(`Could not reuse canonical evaluation for duplicate checkpoint ${duplicateNode.id}`);
            progress(`${id} EVALUATION: reusing canonical result from ${duplicateNode.id}; fresh-seed comparison will still run`);
          } else {
            progress(`${id} EVALUATION: running ${this.config.evaluator.repetitions} canonical repetition${this.config.evaluator.repetitions === 1 ? "" : "s"} for ${assignment.strategy === "replicate" ? "the unchanged checkpoint" : changedPaths.join(", ")}`);
            evaluation = await evaluateWorkspace(
              evaluationConfig,
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
                semanticReferences: assignment.strategy === "replicate"
                  ? []
                  : [{ id: assignment.parentId, evaluation: checkpointEvaluation(state, assignment.parentId)! }],
                onStage: (stage) => progress(`${id} STAGE ${stage.name}: ${stage.pruned ? "pruned" : stage.ok ? "complete" : "failed"}; budget=${formatNumber(stage.budgetRatio)}; samples=${stage.attempts.length}${stage.comparison ? `; evidence=${stage.comparison.status}; ${stage.comparison.confidenceAvailable ? `CI=[${formatNumber(stage.comparison.confidenceInterval.lower)}, ${formatNumber(stage.comparison.confidenceInterval.upper)}]` : "CI=unavailable (n < 2)"}` : ""}`),
                onPhase: (event, context) => progress(`${id} EVAL ${context.stage}/${context.repetition + 1} ${event.phase}: ${event.status}${event.progress === undefined ? "" : ` ${formatNumber(event.progress * 100)}%`}${event.durationMs === undefined ? "" : `; ${formatNumber(event.durationMs / 1_000)}s`}`),
              },
            );
            evaluation = annotateInactiveSearchParameters(evaluation, plan);
            if (evaluation.semanticDuplicateOf) duplicateOf = evaluation.semanticDuplicateOf;
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
            decision = duplicateOf
              ? discardDecision(`Prediction hash matches checkpoint ${duplicateOf}; candidate is a semantic no-op`)
              : evaluation.inactiveSearchParameters?.length
                ? discardDecision(`Evaluator did not consume configured search parameter(s): ${evaluation.inactiveSearchParameters.join(", ")}`)
                : decideResearchCandidate(
                  state.acceptedMetrics,
                  evaluation,
                  this.config.metrics.primary,
                  this.config.metrics.guardrails,
                  assignment.branchDepth,
                  this.config.learning.maxBranchDepth,
                  this.config.learning.maxTemporaryRegressionRatio,
                  candidateIsPareto,
                );

            if (requestedPair && evaluation.ok) {
              const referenceBefore = await snapshotWorkspace(state.acceptedWorkspacePath);
              progress(`${id} PAIRED EVALUATION: comparing candidate with ${leaderBefore} on seeds [${requestedPair.seeds.join(", ")}]`);
              const reference = await evaluateWorkspace(
                evaluationConfig,
                state.acceptedWorkspacePath,
                path.join(experimentDir, "paired-evaluation", "reference"),
                `${id}-paired-reference`,
                { seeds: requestedPair.seeds },
              );
              const candidate = await evaluateWorkspace(
                evaluationConfig,
                workspacePath,
                path.join(experimentDir, "paired-evaluation", "candidate"),
                `${id}-paired-candidate`,
                {
                  seeds: requestedPair.seeds,
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
                seeds: [...requestedPair.seeds],
                rationale: requestedPair.rationale,
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
        }

        if (evaluation.ok) {
          progress(`${id} RESULT: ${formatEvaluation(evaluation, this.config.metrics.primary.name)}`);
        } else if (evaluation.skipped) {
          progress(`${id} SKIP: ${evaluation.error ?? "candidate was skipped"}; evaluator was not run`);
        } else {
          progress(`${id} EVALUATION FAILED: ${evaluation.error ?? "unknown evaluator error"}`);
        }
        if (evaluation.semanticDuplicateOf) progress(`${id} SEMANTIC NO-OP: prediction hashes match ${evaluation.semanticDuplicateOf}; later evaluation stages were skipped`);
        if (evaluation.inactiveSearchParameters?.length) progress(`${id} INACTIVE SEARCH: evaluator did not consume ${evaluation.inactiveSearchParameters.join(", ")}`);
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
              ...(parameterSweep ? { parameterSweep } : {}),
              decision,
            });
            conclusionPath = path.join(experimentDir, "conclusion.md");
            conclusionJsonPath = path.join(experimentDir, "conclusion.json");
            await writeFile(conclusionPath, `${conclusion.narrative.trim()}\n`, "utf8");
            await writeJsonAtomic(conclusionJsonPath, {
              summary: conclusion.summary,
              notes: conclusion.notes,
              lessonUpdates: conclusion.lessonUpdates,
              methodUpdates: conclusion.methodUpdates ?? [],
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
        try {
          agentUsage = researcher?.getUsage?.() ?? emptyAgentUsage();
        } finally {
          await researcher?.dispose?.();
        }
      }

      const finishedAt = new Date().toISOString();
      const accountingEvaluation = parameterSweep
        ? { ...evaluation, totalDurationMs: parameterSweep.totalDurationMs }
        : evaluation;
      const accounting = calculateExperimentAccounting({
        startedAt,
        finishedAt,
        primaryDelta: decision.primaryDelta,
        parentPrimaryValue: assignment.parentMetrics[this.config.metrics.primary.name],
        agentUsage,
        evaluation: accountingEvaluation,
        ...(pairedEvaluation ? { pairedEvaluation } : {}),
      });
      await writeJsonAtomic(path.join(experimentDir, "accounting.json"), accounting);
      const runtimeEnvironment = await readRuntimeManifest(this.config, workspacePath).catch(() => undefined);
      const record: ExperimentRecord = {
        id,
        index,
        startedAt,
        finishedAt,
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
        executionKind,
        ...(proposalReview ? { proposalReview } : {}),
        ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
        changedPaths,
        forbiddenChanges,
        evaluation,
        ...(pairedEvaluation ? { pairedEvaluation } : {}),
        ...(parameterSweep ? { parameterSweep } : {}),
        decision,
        accounting,
      };
      progress(`${id} EFFICIENCY: duration=${formatNumber(accounting.durationMs / 1_000)}s; evaluator=${formatNumber(accounting.evaluatorDurationMs / 1_000)}s; agent cost=$${formatNumber(accounting.agentUsage.costUsd)}; tokens=${accounting.agentUsage.totalTokens}; ${formatEfficiency(accounting.costPerImprovementUsd, accounting.timePerImprovementMs)}`);
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
