import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DecisionResult,
  EvaluationResult,
  ExperimentPlan,
  ExperimentRecord,
  HarnessConfig,
  PairedEvaluationRequest,
  PairedEvaluationResult,
  ResearchConclusion,
  ResearchContext,
  ResearchMemory,
  ResearchNode,
  ResearcherFactory,
  RunState,
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
import {
  assertWorkspace,
  copyWorkspace,
  diffSnapshots,
  fingerprintSnapshot,
  isPathMatched,
  snapshotWorkspace,
} from "./workspace.js";

export interface HarnessRunOptions {
  configPath: string;
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
      status: paired.status === "retain" ? "retain" : "discard",
      primaryDelta: canonical.primaryDelta,
      reasons: [...canonical.reasons, confirmation, "Promotion blocked because fresh-seed confirmation did not satisfy promotion policy"],
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
  await writeJsonAtomic(path.join(state.runDir, "accepted.json"), {
    experimentId: state.researchGraph?.leaderId ?? "baseline",
    workspacePath: state.acceptedWorkspacePath,
    metrics: state.acceptedMetrics,
    policy: "promotion-threshold leader",
  });
  if (state.bestObserved) {
    await writeJsonAtomic(path.join(state.runDir, "best-observed.json"), state.bestObserved);
    await writeJsonAtomic(path.join(state.runDir, "best.json"), state.bestObserved);
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

export class AutoresearchHarness {
  private readonly config: HarnessConfig;
  private readonly researcherFactory: ResearcherFactory;

  constructor(config: HarnessConfig, researcherFactory: ResearcherFactory) {
    this.config = config;
    this.researcherFactory = researcherFactory;
  }

  async run(options: HarnessRunOptions): Promise<RunState> {
    await assertWorkspace(this.config.project.sourceDir);
    const runStartedAtMs = Date.now();
    const runId = makeRunId(this.config.name);
    const runDir = path.join(this.config.outputDir, runId);
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
    events.append("run_started", { runId, configPath: path.resolve(options.configPath) });
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

    const baselineWorkspace = path.join(runDir, "baseline", "workspace");
    progress("Creating isolated baseline workspace");
    await copyWorkspace(this.config.project.sourceDir, baselineWorkspace, ignoreRules);
    const baselineFingerprint = fingerprintSnapshot(await snapshotWorkspace(baselineWorkspace));
    progress("Running baseline evaluation");
    const baseline = await evaluateWorkspace(
      this.config,
      baselineWorkspace,
      path.join(runDir, "baseline", "evaluation"),
      "baseline",
    );
    events.append("baseline_evaluated", { evaluation: baseline, workspaceFingerprint: baselineFingerprint });

    const state: RunState = {
      schemaVersion: 3,
      runId,
      name: this.config.name,
      status: baseline.ok ? "running" : "failed",
      startedAt: new Date(runStartedAtMs).toISOString(),
      configPath: path.resolve(options.configPath),
      runDir,
      sourceDir: this.config.project.sourceDir,
      agent: { ...(this.config.agent.model ? { model: this.config.agent.model } : {}), thinkingLevel: this.config.agent.thinkingLevel },
      primaryMetric: this.config.metrics.primary,
      acceptedWorkspacePath: baselineWorkspace,
      baseline,
      acceptedMetrics: baseline.aggregatedMetrics,
      bestObserved: {
        experimentId: "baseline",
        workspacePath: baselineWorkspace,
        metrics: baseline.aggregatedMetrics,
        decisionStatus: "baseline",
      },
      researchMemory: recordBaselineFact(
        createResearchMemory(this.config, new Date(runStartedAtMs).toISOString()),
        baseline,
        baselineFingerprint,
        new Date().toISOString(),
      ),
      researchGraph: createResearchGraph(baselineWorkspace, baselineFingerprint, baseline.aggregatedMetrics),
      experiments: [],
      ...(!baseline.ok ? { stopReason: `Baseline failed: ${baseline.error ?? "unknown evaluator error"}` } : {}),
    };
    await persistState(state);
    if (!baseline.ok) {
      state.finishedAt = new Date().toISOString();
      await persistState(state);
      events.append("run_failed", { reason: state.stopReason });
      progress(`Run failed: ${state.stopReason}`);
      return state;
    }
    progress(`Baseline result: ${formatEvaluation(baseline, this.config.metrics.primary.name)}`);
    progress(`Baseline accepted; leader=${formatCheckpoint("baseline", state.acceptedMetrics, this.config.metrics.primary.name)}; best-observed=${formatCheckpoint("baseline", state.acceptedMetrics, this.config.metrics.primary.name)}`);

    const deadline = this.config.budget.maxWallTimeMinutes === 0
      ? undefined
      : runStartedAtMs + this.config.budget.maxWallTimeMinutes * 60_000;
    let consecutiveFailures = 0;
    for (let index = 1; index <= this.config.budget.maxExperiments; index += 1) {
      if (options.signal?.aborted) {
        state.status = "interrupted";
        state.stopReason = "Received interruption signal";
        break;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        state.stopReason = `Reached wall-time budget of ${this.config.budget.maxWallTimeMinutes} minutes`;
        break;
      }

      const id = `exp-${String(index).padStart(4, "0")}`;
      const assignment = chooseResearchAssignment(state, this.config);
      const leaderBefore = state.researchGraph!.leaderId;
      const acceptedMetricsBefore = { ...state.acceptedMetrics };
      const bestObservedBefore = state.bestObserved
        ? { ...state.bestObserved, metrics: { ...state.bestObserved.metrics } }
        : undefined;
      const memoryBefore = state.researchMemory!;
      const experimentDir = path.join(runDir, "experiments", id);
      const workspacePath = path.join(experimentDir, "workspace");
      await ensureDir(experimentDir);
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
      let researcher;

      try {
        progress(`${id} AGENT: inspecting ${assignment.parentId} and preparing one controlled change`);
        researcher = await this.researcherFactory(workspacePath, experimentDir);
        const proposal = await researcher.propose({
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
        });
        if (proposal.agent) state.agent = proposal.agent;
        plan = proposal.plan ?? fallbackPlan(proposal.narrative);
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

        const duplicateNode = state.researchGraph!.nodes.find((node) => node.workspaceFingerprint === workspaceFingerprint);
        const repeatedExperiment = state.experiments.find((experiment) =>
          experiment.plan && normalizeClaim(experiment.plan.hypothesis) === normalizeClaim(plan!.hypothesis));
        const pairedRequestError = validatePairedRequest(this.config, plan.evaluationRequest);

        if (pairedRequestError) {
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
            );
          }
          const afterEvaluation = await snapshotWorkspace(workspacePath);
          const evaluatorMutations = diffSnapshots(after, afterEvaluation);
          if (evaluatorMutations.length > 0) {
            const error = `Evaluator mutated the candidate workspace: ${evaluatorMutations.join(", ")}`;
            evaluation = { ...evaluation, ok: false, error };
            decision = failureDecision(error);
          } else {
            decision = decideResearchCandidate(
              state.acceptedMetrics,
              evaluation,
              this.config.metrics.primary,
              this.config.metrics.guardrails,
              assignment.branchDepth,
              this.config.learning.maxBranchDepth,
              this.config.learning.maxTemporaryRegressionRatio,
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
                { seeds: plan.evaluationRequest.seeds },
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
            } else if (decision.status === "retain" && !duplicateOf) {
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

        if (researcher.reflect) {
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
        changedPaths,
        forbiddenChanges,
        evaluation,
        ...(pairedEvaluation ? { pairedEvaluation } : {}),
        decision,
      };
      state.experiments.push(record);

      if (evaluation.ok && state.bestObserved && primaryImprovement(
        state.bestObserved.metrics,
        evaluation.aggregatedMetrics,
        this.config.metrics.primary,
      ) > 0) {
        state.bestObserved = {
          experimentId: id,
          workspacePath,
          metrics: evaluation.aggregatedMetrics,
          decisionStatus: decision.status === "keep" ? "promote" : decision.status === "reject" ? "discard" : decision.status,
        };
      }

      const node = candidateNode(
        id,
        workspacePath,
        workspaceFingerprint,
        evaluation.aggregatedMetrics,
        assignment.parentId,
        assignment.branchDepth,
        assignment.strategy,
        plan?.changeCategory ?? "other",
      );
      if (!(pairedEvaluation && duplicateOf)) {
        applyGraphDecision(state.researchGraph!, node, decision, this.config, this.config.metrics.primary);
      }
      const leader = state.researchGraph!.nodes.find((candidate) => candidate.id === state.researchGraph!.leaderId)!;
      state.acceptedWorkspacePath = leader.workspacePath;
      state.acceptedMetrics = leader.metrics;
      state.researchMemory = applyExperimentKnowledge(state.researchMemory!, record, conclusion, this.config);
      events.append("experiment_decided", { id, assignment, decision, evaluation, pairedEvaluation, duplicateOf, repeatedHypothesisOf });

      if (decision.status === "failure") consecutiveFailures += 1;
      else consecutiveFailures = 0;
      progress(`${id} DECISION: ${decision.status}; primary improvement=${formatSigned(decision.primaryDelta)}; ${decision.reasons.map((reason) => oneLine(reason)).join("; ")}`);
      if (leaderBefore !== leader.id) {
        progress(`${id} NEW LEADER: ${formatCheckpoint(leaderBefore, acceptedMetricsBefore, this.config.metrics.primary.name)} -> ${formatCheckpoint(leader.id, leader.metrics, this.config.metrics.primary.name)}`);
      }
      if (bestObservedBefore?.experimentId !== state.bestObserved?.experimentId && state.bestObserved) {
        progress(`${id} NEW BEST-OBSERVED: ${bestObservedBefore ? formatCheckpoint(bestObservedBefore.experimentId, bestObservedBefore.metrics, this.config.metrics.primary.name) : "none"} -> ${formatCheckpoint(state.bestObserved.experimentId, state.bestObserved.metrics, this.config.metrics.primary.name)} (decision=${state.bestObserved.decisionStatus})`);
      }
      progress(`${id} STATE: leader=${formatCheckpoint(leader.id, leader.metrics, this.config.metrics.primary.name)}; best-observed=${state.bestObserved ? formatCheckpoint(state.bestObserved.experimentId, state.bestObserved.metrics, this.config.metrics.primary.name) : "none"}; frontier=[${state.researchGraph!.frontierIds.join(", ") || "empty"}]`);
      for (const change of memoryChanges(memoryBefore, state.researchMemory, id)) {
        progress(`${id} MEMORY: ${change}`);
      }
      await persistState(state);

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
    state.finishedAt = new Date().toISOString();
    await persistState(state);
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
