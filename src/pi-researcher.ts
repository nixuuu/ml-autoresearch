import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentUsage,
  AgentProfileConfig,
  AgentRole,
  ExperimentPlan,
  HarnessConfig,
  LessonGuidance,
  LessonUpdate,
  ResearchConclusion,
  ResearchMethodUpdate,
  ResearchContext,
  ResearchOutcome,
  ResearchProposal,
  Researcher,
  ResearchQuestionUpdate,
  AgentEvaluationRequest,
  ProposalReview,
} from "./types.js";
import { EventLog, ensureDir } from "./io.js";
import { addAgentUsage, emptyAgentUsage } from "./experiment-accounting.js";
import { AgentTranscriptRecorder } from "./agent-transcript.js";
import { isPathMatched, listWorkspaceFiles, resolveSafeWorkspacePath } from "./workspace.js";
import { CHANGE_CATEGORIES, normalizeChangeCategory } from "./change-category.js";
import { OpenResearchExecutor } from "./analysis-executor.js";
import { DependencyBroker } from "./dependency-broker.js";
import type { PersistentResearchLab } from "./research-lab.js";

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function isAgentVisiblePath(relativePath: string, hiddenPaths: string[]): boolean {
  return !isPathMatched(relativePath, hiddenPaths);
}

export async function resolveAgentSelection(agent: { model?: string; thinkingLevel: HarnessConfig["agent"]["thinkingLevel"] }): Promise<{
  requestedModel?: string;
  resolvedModel?: string;
  thinkingLevel: HarnessConfig["agent"]["thinkingLevel"];
}> {
  if (!agent.model) return { thinkingLevel: agent.thinkingLevel };
  const modelRuntime = await ModelRuntime.create();
  const resolved = resolveCliModel({
    cliModel: agent.model,
    cliThinking: agent.thinkingLevel,
    modelRuntime,
  });
  if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `Could not resolve model ${agent.model}`);
  return {
    requestedModel: agent.model,
    resolvedModel: `${resolved.model.provider}/${resolved.model.id}`,
    thinkingLevel: resolved.thinkingLevel ?? agent.thinkingLevel,
  };
}

// Pi intentionally loads OAuth flows dynamically under Node. Standalone Bun
// binaries must register the statically bundled implementations up front.
registerBunOAuthFlows();

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactEvent(event: AgentSessionEvent): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(event, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)) as Record<string, unknown>;
  } catch {
    return { type: event.type, serializationError: true };
  }
}

function usageFromSessionStats(stats: SessionStats): AgentUsage {
  return {
    requests: stats.assistantMessages,
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    costUsd: stats.cost,
  };
}

function taggedJson(text: string, tag: string): Record<string, unknown> | undefined {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function textField(value: unknown, fallback: string, maxLength = 2_000): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function textArray(value: unknown, maxItems = 20): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, maxItems).map((item) => item.trim().slice(0, 1_000))
    : [];
}

function parseEvaluationRequest(value: unknown): AgentEvaluationRequest | undefined {
  if (value === undefined) return undefined;
  const invalid = (reason: string): AgentEvaluationRequest => ({
    mode: "paired",
    seeds: [],
    rationale: `Invalid agent evaluation request: ${reason}`,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("expected an object");
  const raw = value as Record<string, unknown>;
  if (raw.mode === "parameter_sweep") {
    if (typeof raw.parameter !== "string" || !raw.parameter.trim()) return invalid("parameter_sweep.parameter must be a non-empty string");
    if (!Array.isArray(raw.values)) return invalid("parameter_sweep.values must be an array");
    if (raw.values.some((entry) => !["string", "number", "boolean"].includes(typeof entry) || (typeof entry === "number" && !Number.isFinite(entry)))) {
      return invalid("parameter_sweep.values must contain finite numbers, strings, or booleans");
    }
    return {
      mode: "parameter_sweep",
      parameter: raw.parameter.trim().slice(0, 120),
      values: raw.values.slice(0, 100) as Array<string | number | boolean>,
      rationale: textField(raw.rationale, "No rationale supplied for parameter sweep.", 2_000),
    };
  }
  if (raw.mode !== "paired") return invalid("mode must be paired or parameter_sweep");
  if (!Array.isArray(raw.seeds)) return invalid("seeds must be an array");
  if (raw.seeds.some((seed) => typeof seed !== "number" || !Number.isSafeInteger(seed) || seed < 0)) {
    return invalid("seeds must be non-negative safe integers");
  }
  return {
    mode: "paired",
    seeds: raw.seeds.slice(0, 100) as number[],
    rationale: textField(raw.rationale, "No rationale supplied for paired evaluation.", 2_000),
  };
}

export function parseExperimentPlan(narrative: string): ExperimentPlan | undefined {
  const raw = taggedJson(narrative, "experiment_proposal");
  if (!raw) return undefined;
  const evaluationRequest = parseEvaluationRequest(raw.evaluationRequest);
  const boundedScore = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
  const nonNegative = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
  const dependencies = textArray(raw.dependencies);
  const followUpHypotheses = textArray(raw.followUpHypotheses, 12);
  const analysisEvidence = textArray(raw.analysisEvidence, 50);
  const resourceRequest = raw.resourceRequest && typeof raw.resourceRequest === "object" && !Array.isArray(raw.resourceRequest)
    ? Object.fromEntries(Object.entries(raw.resourceRequest as Record<string, unknown>)
      .filter(([key, value]) => ["cpu", "memoryGb", "gpu", "vramGb"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0))
    : undefined;
  return {
    hypothesis: textField(raw.hypothesis, "Unstructured hypothesis"),
    changeCategory: normalizeChangeCategory(textField(raw.changeCategory, "other", 120)),
    expectedEffect: textField(raw.expectedEffect, "Unspecified expected effect"),
    notes: textArray(raw.notes),
    lessonsUsed: textArray(raw.lessonsUsed),
    contradictedLessons: textArray(raw.contradictedLessons),
    lessonTests: textArray(raw.lessonTests),
    ...(textArray(raw.methodTests).length ? { methodTests: textArray(raw.methodTests) } : {}),
    questionsAddressed: textArray(raw.questionsAddressed),
    ...(analysisEvidence.length ? { analysisEvidence } : {}),
    ...(nonNegative(raw.expectedGain) === undefined ? {} : { expectedGain: nonNegative(raw.expectedGain)! }),
    ...(boundedScore(raw.probabilityOfSuccess) === undefined ? {} : { probabilityOfSuccess: boundedScore(raw.probabilityOfSuccess)! }),
    ...(boundedScore(raw.informationGain) === undefined ? {} : { informationGain: boundedScore(raw.informationGain)! }),
    ...(nonNegative(raw.estimatedCost) === undefined ? {} : { estimatedCost: nonNegative(raw.estimatedCost)! }),
    ...(typeof raw.falsificationCriterion === "string" && raw.falsificationCriterion.trim()
      ? { falsificationCriterion: textField(raw.falsificationCriterion, "", 2_000) }
      : {}),
    ...(dependencies.length ? { dependencies } : {}),
    ...(followUpHypotheses.length ? { followUpHypotheses } : {}),
    ...(evaluationRequest ? { evaluationRequest } : {}),
    ...(resourceRequest && Object.keys(resourceRequest).length ? { resourceRequest } : {}),
  };
}

function proposalValidationErrors(
  plan: ExperimentPlan | undefined,
  context: ResearchContext,
  analysisExecutor: OpenResearchExecutor | undefined,
): string[] {
  if (!plan) return ["The response does not contain a valid <experiment_proposal> JSON block."];
  const errors: string[] = [];
  const lessonIds = new Set(context.memory.lessons.map((lesson) => lesson.id));
  const methodIds = new Set((context.methods ?? []).map((method) => method.id));
  const questionIds = new Set(context.memory.questions.map((question) => question.id));
  const unknownLessons = plan.lessonTests.filter((id) => !lessonIds.has(id));
  const unknownMethods = (plan.methodTests ?? []).filter((id) => !methodIds.has(id));
  const unknownQuestions = plan.questionsAddressed.filter((id) => !questionIds.has(id));
  if (unknownLessons.length) errors.push(`lessonTests contains unknown ids: ${unknownLessons.join(", ")}`);
  if (unknownMethods.length) errors.push(`methodTests contains unknown ids: ${unknownMethods.join(", ")}`);
  if (unknownQuestions.length) errors.push(`questionsAddressed contains unknown ids: ${unknownQuestions.join(", ")}`);
  if (analysisExecutor?.hasRunningJobs) errors.push("Background analysis jobs are still running; inspect or cancel them before proposing.");
  if (analysisExecutor?.candidateWasMutated && context.analysis.requireFreshEvidenceAfterMutation) {
    const fresh = new Set(analysisExecutor.freshSuccessfulEvidenceIds());
    const cited = plan.analysisEvidence ?? [];
    if (cited.length === 0) errors.push("analysisEvidence must cite successful evidence measured after the final candidate edit.");
    const invalid = cited.filter((id) => !fresh.has(id));
    if (invalid.length) errors.push(`analysisEvidence is stale, failed, or unknown: ${invalid.join(", ")}; fresh ids: ${[...fresh].join(", ") || "none"}`);
  }
  return errors;
}

function parseLessonUpdates(value: unknown): LessonUpdate[] {
  if (!Array.isArray(value)) return [];
  const relations = new Set(["new", "supports", "contradicts", "retire"]);
  const guidances = new Set<LessonGuidance>(["consider", "avoid", "verify"]);
  return value.slice(0, 20).flatMap((entry): LessonUpdate[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const claim = textField(raw.claim, "", 2_000);
    if (!claim) return [];
    const relation = typeof raw.relation === "string" && relations.has(raw.relation) ? raw.relation as LessonUpdate["relation"] : "new";
    const guidance = typeof raw.guidance === "string" && guidances.has(raw.guidance as LessonGuidance)
      ? raw.guidance as LessonGuidance
      : "consider";
    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0.5;
    const evidenceKinds = new Set(["direct", "replication", "contextual"]);
    const evidenceKind = typeof raw.evidenceKind === "string" && evidenceKinds.has(raw.evidenceKind)
      ? raw.evidenceKind as LessonUpdate["evidenceKind"]
      : "contextual";
    return [{
      ...(typeof raw.lessonId === "string" && raw.lessonId.trim() ? { lessonId: raw.lessonId.trim().slice(0, 120) } : {}),
      claim,
      relation,
      guidance,
      confidence,
      evidenceKind,
      evidenceRationale: textField(raw.evidenceRationale, "No evidence rationale supplied.", 2_000),
    }];
  });
}

function parseQuestionUpdates(value: unknown): ResearchQuestionUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry): ResearchQuestionUpdate[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    const questionId = textField(raw.questionId, "", 120);
    const resolution = textField(raw.resolution, "", 2_000);
    if (!questionId || !resolution) return [];
    return [{
      questionId,
      status: raw.status === "invalidated" ? "invalidated" : "resolved",
      resolution,
    }];
  });
}

function parseMethodUpdates(value: unknown): ResearchMethodUpdate[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set(["prompt-note", "analysis-recipe", "context-selector", "role-spec", "screening-policy"]);
  const relations = new Set(["new", "supports", "contradicts", "retire"]);
  return value.slice(0, 20).flatMap((entry): ResearchMethodUpdate[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const raw = entry as Record<string, unknown>;
    if (!kinds.has(String(raw.kind)) || !relations.has(String(raw.relation))) return [];
    const content = textField(raw.content, "", 2_000);
    if (!content) return [];
    return [{
      ...(typeof raw.methodId === "string" && raw.methodId.trim() ? { methodId: raw.methodId.trim().slice(0, 120) } : {}),
      kind: raw.kind as ResearchMethodUpdate["kind"],
      content,
      relation: raw.relation as ResearchMethodUpdate["relation"],
      rationale: textField(raw.rationale, "No rationale supplied.", 2_000),
    }];
  });
}

export function parseResearchConclusion(narrative: string): ResearchConclusion {
  const raw = taggedJson(narrative, "experiment_conclusion");
  return {
    narrative,
    summary: textField(raw?.summary, narrative.split("\n").find((line) => line.trim()) ?? "No structured conclusion", 2_000),
    notes: textArray(raw?.notes),
    lessonUpdates: parseLessonUpdates(raw?.lessonUpdates),
    methodUpdates: parseMethodUpdates(raw?.methodUpdates),
    nextHypotheses: textArray(raw?.nextHypotheses),
    questionUpdates: parseQuestionUpdates(raw?.questionUpdates),
  };
}

export function parseProposalReview(narrative: string): ProposalReview {
  const raw = taggedJson(narrative, "proposal_review");
  return {
    approved: raw?.approved === true,
    summary: textField(raw?.summary, narrative.split("\n").find((line) => line.trim()) ?? "Reviewer returned no structured summary", 2_000),
    concerns: textArray(raw?.concerns, 12),
  };
}

export function buildPrompt(context: ResearchContext, advisorNotes: string[] = []): string {
  const history = context.previousExperiments.length === 0
    ? "No previous candidate experiments."
    : context.previousExperiments.map((experiment) => [
      `- ${experiment.id}: strategy=${experiment.strategy ?? "unknown"}; parent=${experiment.parentId ?? "unknown"}; ${experiment.status}; metrics=${JSON.stringify(experiment.metrics)}; primaryDelta=${experiment.primaryDelta ?? "n/a"}`,
      experiment.hypothesis ? `  Hypothesis: ${experiment.hypothesis}` : "",
      experiment.conclusion ? `  Conclusion: ${experiment.conclusion}` : "",
    ].filter(Boolean).join("\n")).join("\n");

  const lessons = context.memory.lessons.length === 0
    ? "No consolidated lessons yet."
    : context.memory.lessons.map((lesson) =>
      `- ${lesson.id} [${lesson.status}; guidance=${lesson.guidance}; confidence=${lesson.confidence}]: ${lesson.claim} (for=${lesson.evidenceFor.join(",") || "none"}; against=${lesson.evidenceAgainst.join(",") || "none"})`,
    ).join("\n");
  const facts = context.memory.facts.length === 0
    ? "No prior harness facts."
    : context.memory.facts.map((fact) => `- ${fact.id}: ${fact.statement}`).join("\n");
  const notes = context.memory.notes.length === 0
    ? "No agent notebook entries."
    : context.memory.notes.map((note) => `- ${note.id} [${note.phase}, agent interpretation, not a fact]: ${note.text}`).join("\n");
  const questions = context.memory.questions.length === 0
    ? "No research questions."
    : context.memory.questions.map((question) =>
      `- ${question.id} [${question.status}]: ${question.text}${question.resolution ? `; resolution=${question.resolution}` : ""}`,
    ).join("\n");
  const evaluationRequestOptions = [
    context.evaluationRequests.allowPairedComparison
      ? `- Paired comparison: compare the candidate and current leader on 1-${context.evaluationRequests.maxSeeds} fresh seeds not present in canonical seeds (${context.evaluationRequests.canonicalSeeds.join(", ")}).`
      : "- Paired comparisons are disabled.",
    context.evaluationRequests.allowParameterSweep
      ? `- Parameter sweep: test 2-${context.evaluationRequests.maxSweepValues} values of exactly one declared parameter as one logical experiment. The harness creates controlled trial workspaces, evaluates the values on identical stages/seeds, prunes weak trials, selects one winner, and returns all trial results to reflection. Declared parameters: ${JSON.stringify(context.evaluationRequests.sweepParameters)}. Do not edit the parameter merely to encode one of the requested values; common code changes are allowed when they apply identically to every trial.`
      : "- Parameter sweeps are disabled.",
  ];
  const evaluationRequests = evaluationRequestOptions.join("\n");
  const analysis = context.analysis.enabled
    ? `Controlled research tools are available (${context.analysis.runner}, at most ${context.analysis.maxCalls} command calls, ${context.analysis.timeoutSeconds}s per call). Start with research_runtime_info; the canonical Python command is ${JSON.stringify(context.analysis.runtime.pythonCommand)}, project PYTHONPATH entries are ${JSON.stringify(context.analysis.runtime.projectPathEntries)}, and the canonical test command is ${JSON.stringify(context.analysis.runtime.testCommand ?? null)}. Prefer this cheapest-first sequence: runtime info -> persistent lab -> code search/ranged reads -> data info -> small analysis -> candidate edit -> exact final-candidate validation -> proposal. Use research_python and research_test instead of rediscovering the interpreter. ${context.analysis.jobsEnabled ? "Long analyses may run as background research jobs; poll their status and preserve restartable checkpoints under .autoresearch-analysis." : "Background jobs are disabled."} Every command result has an evidence id and candidate/runtime fingerprint. Candidate edits make earlier evidence stale.${context.analysis.requireFreshEvidenceAfterMutation ? " A proposal after mutation must cite at least one successful fresh evidence id in analysisEvidence." : " Fresh evidence is recommended but not required."} Command-side file changes are scratch-only; persist final candidate code with research_write/research_replace. Publish reusable observations through the research lab. Never attempt to infer or access hidden holdout data.${context.analysis.dependencies.enabled ? ` A controlled dependency broker is enabled for ${context.analysis.dependencies.allowedManagers.join(", ") || "no managers"}. Dependency info distinguishes packages already present in the runtime from addable or denied packages. Use scope=analysis for disposable diagnostics and scope=candidate when the final model/evaluator must retain the package. Candidate dependencies are locked in ${context.analysis.dependencies.manifestPath}; evaluator execution uses that same immutable overlay. Allowed environment profiles: base${context.analysis.dependencies.environmentProfiles.length ? `, ${context.analysis.dependencies.environmentProfiles.join(", ")}` : ""}.` : " Dynamic dependencies are disabled."}`
    : "Arbitrary analysis commands are disabled for this scenario.";
  const evaluationRequestField = context.evaluationRequests.allowParameterSweep
    ? `,"evaluationRequest":{"mode":"parameter_sweep","parameter":"declared_parameter_name","values":[0.5,1,2],"rationale":"one causal parameter axis; optional, omit unless a bounded sweep is more informative than one value"}`
    : context.evaluationRequests.allowPairedComparison
      ? `,"evaluationRequest":{"mode":"paired","seeds":[59,71,89],"rationale":"optional; omit the entire field unless fresh-seed confirmation is useful"}`
      : "";
  const campaign = context.campaign
    ? context.campaign.tickets.filter((ticket) => ticket.status === "queued" || ticket.status === "running").slice(0, 12)
      .map((ticket) => `- ${ticket.id} [${ticket.kind}/${ticket.status}; priority=${ticket.priority.toFixed(3)}]: ${ticket.hypothesis}`).join("\n") || "No active campaign tickets."
    : "Campaign planning is disabled.";
  const methods = (context.methods ?? []).length === 0
    ? "No active research methods."
    : context.methods!.map((method) => `- ${method.id} [${method.kind}; ${method.status}]: ${method.content}`).join("\n");
  const advice = advisorNotes.length === 0
    ? "No adaptive advisor was selected for this experiment."
    : advisorNotes.join("\n\n");

  return `# Controlled ML autoresearch experiment ${context.experimentId}

You are proposing exactly one coherent, testable ML experiment. The harness, not you, owns evaluation, evidence status, branch retention, and promotion decisions.

## Assigned search move

- Strategy: ${context.assignment.strategy}
- Parent checkpoint: ${context.assignment.parentId}
- Parent metrics: ${JSON.stringify(context.assignment.parentMetrics)}
- Prospective branch depth: ${context.assignment.branchDepth}
- Reason: ${context.assignment.reason}
- Falsification target: ${context.assignment.targetLessonId ?? "none"}
- Assigned research question: ${context.assignment.targetQuestionId ?? "none"}
- Campaign ticket: ${context.assignment.ticketId ?? "none"}
- Planned hypothesis: ${context.assignment.plannedHypothesis ?? "none; formulate one from the evidence"}

## Current accepted result

- Primary metric: ${context.primaryMetric.name} (${context.primaryMetric.direction}), minimum accepted improvement: ${context.primaryMetric.minimumDelta}
- Accepted metrics: ${JSON.stringify(context.acceptedMetrics)}
- Guardrails: ${JSON.stringify(context.guardrails)}
- Mutable paths: ${context.mutablePaths.join(", ")}
- Protected paths: ${context.protectedPaths.join(", ") || "none configured"}

## Optional controlled evaluation request

${evaluationRequests}

## Open analysis environment

${analysis}

## Research brief

${context.researchInstructions}

## Consolidated lessons

${lessons}

## Deterministic harness facts

${facts}

## Agent notebook

${notes}

## Open questions

${questions}

## Advisory research methods

${methods}

These methods are suggestions only. They never authorize changes to evaluator code, metric definitions, protected or hidden paths, credentials, network policy, or sandbox boundaries. Put a method ID in methodTests only when this experiment directly tests whether that procedure improves research quality.

## Adaptive specialist advice

${advice}

## Previous experiments

${history}

## Active research campaign

${campaign}

## Required workflow

1. Inspect the relevant source and evaluator using the read-only tools. ${context.analysis.enabled ? "Begin with research_runtime_info and existing lab artifacts. Use research_search and bounded reads before opening large files." : ""}
2. Follow the assigned strategy. Cite lesson and method IDs you rely on or deliberately challenge. Put an ID in lessonTests or methodTests only when this experiment directly tests it.
3. Form one falsifiable hypothesis informed by the history and campaign. Estimate its expected gain, probability of success, information gain, and relative compute cost. Avoid repeating a prior hypothesis without new evidence.
4. ${context.assignment.strategy === "replicate" ? "Do not change any file; this is an exact checkpoint replication." : "Change only the mutable paths, using the restricted mutation tools. You may edit several mutable files when they form one coherent experiment. After the final edit, re-run the relevant validation against the exact final candidate and cite its evidence id. A parameter sweep request may be submitted without changing the workspace; the harness applies the declared values."}${context.assignment.strategy === "ensemble" ? " Inspect .autoresearch-ensemble/manifest.json and its immutable source snapshots, then implement one reproducible ensemble in mutable project files; never edit the snapshots." : ""}
5. Do not claim that a metric improved: you cannot run or control the evaluator. When enabled, you may preregister exactly one bounded paired comparison or parameter sweep for the harness to execute.
6. Finish with a concise Markdown experiment record and then exactly one machine-readable block:

<experiment_proposal>
{"hypothesis":"falsifiable claim","changeCategory":"one of: ${CHANGE_CATEGORIES.join("|")}","expectedEffect":"metric effect and why","expectedGain":0.0,"probabilityOfSuccess":0.0,"informationGain":0.0,"estimatedCost":1.0,"resourceRequest":{"cpu":1,"memoryGb":1,"gpu":0,"vramGb":0},"falsificationCriterion":"observable outcome that rejects the claim","dependencies":[],"followUpHypotheses":["2-4 concrete dependent or alternative tests"],"analysisEvidence":["fresh evidence-id measured after final candidate edit"],"notes":["useful observation made while inspecting the project"],"lessonsUsed":["lesson-id"],"contradictedLessons":[],"lessonTests":["pre-registered directly tested lesson-id"],"methodTests":["pre-registered directly tested method-id"],"questionsAddressed":["question-id actually addressed by this experiment"]${evaluationRequestField}}
</experiment_proposal>

Do not make unrelated cleanup changes. Do not write metrics or alter evaluation logic. Harness facts outrank agent notes and interpretations.`;
}

export class PiResearcher implements Researcher {
  readonly capabilities = Object.freeze({
    persistentSession: false,
    subagents: false,
    steer: false,
    followUp: false,
    compaction: true,
    resumable: false,
  });
  private readonly config: HarnessConfig;
  private readonly workspacePath: string;
  private readonly experimentDir: string;
  private readonly profile: AgentProfileConfig | undefined;
  private readonly implementerTranscript: AgentTranscriptRecorder;
  private readonly reviewerTranscript: AgentTranscriptRecorder;
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  private reviewerUsage = emptyAgentUsage();

  constructor(
    config: HarnessConfig,
    workspacePath: string,
    experimentDir: string,
    profile?: AgentProfileConfig,
    private readonly researchLab?: PersistentResearchLab,
  ) {
    this.config = config;
    this.workspacePath = workspacePath;
    this.experimentDir = experimentDir;
    this.profile = profile;
    const transcriptPath = path.join(experimentDir, "agent-transcript.jsonl");
    this.implementerTranscript = new AgentTranscriptRecorder(transcriptPath, "implementer");
    this.reviewerTranscript = new AgentTranscriptRecorder(transcriptPath, "reviewer");
  }

  private async runAdaptiveAdvisors(context: ResearchContext): Promise<string[]> {
    const policy = this.config.agent.orchestration;
    if (policy?.mode !== "adaptive") return [];
    const profiles = this.config.agent.roles ?? {};
    const selected: AgentRole[] = [];
    const add = (role: AgentRole, condition: boolean) => {
      if (condition && profiles[role] && !selected.includes(role)) selected.push(role);
    };
    const trailingFailures = [...context.previousExperiments].reverse().findIndex((experiment) => experiment.status !== "failure");
    const failureCount = trailingFailures === -1 ? context.previousExperiments.length : trailingFailures;
    const last = context.previousExperiments.at(-1);
    add("failure-analyst", failureCount >= policy.failureAnalystAfter);
    add("statistician", last?.status === "inconclusive" || context.assignment.strategy === "replicate" || context.assignment.strategy === "falsify");
    add("hypothesis-generator", !context.assignment.plannedHypothesis);
    add("implementation-critic", context.assignment.branchDepth > 1 || failureCount > 0);
    const roles = selected.slice(0, policy.maxAdvisors);
    const outputs: string[] = [];
    for (let offset = 0; offset < roles.length; offset += policy.maxParallel) {
      const batch = roles.slice(offset, offset + policy.maxParallel);
      outputs.push(...await Promise.all(batch.map(async (role) => {
        const profile = profiles[role]!;
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
        const loader = new DefaultResourceLoader({
          cwd: this.workspacePath,
          agentDir: getAgentDir(),
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: profile.systemPrompt ?? `You are the ${role} advisor in a controlled ML research system. Give concise, read-only advice. Never request changes to evaluator code, metrics, hidden or protected paths, credentials, networking, or sandbox policy.`,
        });
        await loader.reload();
        const modelRuntime = await ModelRuntime.create();
        const resolved = profile.model ? resolveCliModel({ cliModel: profile.model, cliThinking: profile.thinkingLevel, modelRuntime }) : undefined;
        if (resolved?.error || (profile.model && !resolved?.model)) throw new Error(resolved?.error ?? `Could not resolve ${role} model ${profile.model}`);
        const result = await createAgentSession({
          cwd: this.workspacePath,
          modelRuntime,
          ...(resolved?.model ? { model: resolved.model } : {}),
          thinkingLevel: resolved?.thinkingLevel ?? profile.thinkingLevel,
          tools: [],
          customTools: [],
          resourceLoader: loader,
          sessionManager: SessionManager.create(this.workspacePath, path.join(this.experimentDir, `advisor-${role}-session`)),
          settingsManager,
        });
        const transcript = new AgentTranscriptRecorder(path.join(this.experimentDir, "agent-transcript.jsonl"), role);
        let narrative = "";
        const unsubscribe = result.session.subscribe((event) => {
          transcript.record(event, "proposal_advice");
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") narrative += event.assistantMessageEvent.delta;
        });
        try {
          await result.session.prompt(`Advise the implementer for ${context.experimentId}.\n\nAssignment: ${JSON.stringify(context.assignment)}\nMetrics: ${JSON.stringify({ primary: context.primaryMetric, accepted: context.acceptedMetrics, guardrails: context.guardrails })}\nRecent experiments: ${JSON.stringify(context.previousExperiments)}\nLessons: ${JSON.stringify(context.memory.lessons)}\nMethods: ${JSON.stringify(context.methods ?? [])}\n\nReturn at most 8 concise bullets. You are advisory only and have no tools.`);
        } finally {
          unsubscribe();
          this.reviewerUsage = addAgentUsage(this.reviewerUsage, usageFromSessionStats(result.session.getSessionStats()));
          result.session.dispose();
        }
        if (result.session.agent.state.errorMessage) throw new Error(`${role} advisor failed: ${result.session.agent.state.errorMessage}`);
        return `### ${role}\n${narrative.trim() || "No advice produced."}`;
      })));
    }
    return outputs;
  }

  async propose(context: ResearchContext): Promise<ResearchProposal> {
    await ensureDir(this.experimentDir);
    const advisorNotes = await this.runAdaptiveAdvisors(context);
    if (this.researchLab) {
      const knownToolFacts = await this.researchLab.read("system/tool-facts.jsonl").catch(() => "");
      if (knownToolFacts.trim()) advisorNotes.push(`### Known analysis-runtime facts from earlier experiments\n${knownToolFacts.trim().split(/\r?\n/u).slice(-20).join("\n")}`);
    }
    const piEvents = new EventLog(path.join(this.experimentDir, "pi-events.jsonl"));
    const mutablePaths = this.config.project.mutablePaths;
    const hiddenPaths = this.config.project.hiddenPaths ?? [];
    const protectedPaths = uniquePaths([...this.config.project.protectedPaths, ...hiddenPaths]);
    const dependencyBroker = this.config.runtimeDependencies?.enabled
      ? new DependencyBroker(this.config, this.workspacePath, this.experimentDir)
      : undefined;
    const analysisExecutor = this.config.agent.analysis?.enabled
      ? new OpenResearchExecutor(
        this.config.agent.analysis,
        this.workspacePath,
        this.experimentDir,
        hiddenPaths,
        dependencyBroker ? () => dependencyBroker.environment() : undefined,
        async (evidence, result) => {
          if (!this.researchLab || this.config.agent.analysis?.evidence?.autoPublishToLab === false) return;
          await this.researchLab.write(`evidence/${context.experimentId}/${evidence.evidenceId}.json`, JSON.stringify({
            schemaVersion: 1,
            experimentId: context.experimentId,
            evidence,
            stdoutPreview: result.stdout.slice(0, 32_768),
            stderrPreview: result.stderr.slice(0, 32_768),
          }, null, 2));
          const facts = [
            ...(result.timedOut ? [`Command ${JSON.stringify(result.command)} timed out; use a checkpointed background job and resume from its durable partial output.`] : []),
            ...(/ModuleNotFoundError|No module named/u.test(result.stderr) ? [`Python import failed for ${JSON.stringify(result.command)}. Use research_runtime_info and the canonical research_python tool instead of system Python.`] : []),
            ...(/command not found|not found$/imu.test(result.stderr) ? [`Executable discovery failed for ${JSON.stringify(result.command)}. Inspect research_runtime_info before retrying.`] : []),
          ];
          if (facts.length) {
            const current = await this.researchLab.read("system/tool-facts.jsonl").catch(() => "");
            const lines = facts.map((fact) => JSON.stringify({ timestamp: new Date().toISOString(), experimentId: context.experimentId, fact }));
            await this.researchLab.write("system/tool-facts.jsonl", `${current}${current && !current.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`);
          }
        },
        mutablePaths,
      )
      : undefined;

    const listTool = defineTool({
      name: "research_list",
      label: "List workspace files",
      description: "List files in the isolated experiment workspace. This tool is read-only.",
      parameters: Type.Object({}),
      execute: async () => textResult((await listWorkspaceFiles(this.workspacePath))
        .filter((filePath) => isAgentVisiblePath(filePath, hiddenPaths)).join("\n")),
    });

    const readTool = defineTool({
      name: "research_read",
      label: "Read workspace file",
      description: `Read a bounded byte range from one UTF-8 file in the isolated workspace (maximum ${MAX_READ_BYTES} bytes). Prefer ranges for large files.`,
      parameters: Type.Object({
        path: Type.String({ description: "Relative workspace path" }),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset; defaults to 0" })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_BYTES, description: "Maximum bytes to return" })),
      }),
      execute: async (_id, params) => {
        try {
          const resolved = await resolveSafeWorkspacePath(this.workspacePath, params.path);
          if (!isAgentVisiblePath(resolved.relativePath, hiddenPaths)) throw new Error("This path is hidden from the research agent");
          const content = await readFile(resolved.absolutePath);
          const offset = Math.min(params.offset ?? 0, content.byteLength);
          const maximum = params.maxBytes ?? MAX_READ_BYTES;
          const selected = content.subarray(offset, Math.min(content.byteLength, offset + maximum));
          return textResult(selected.toString("utf8"), {
            path: resolved.relativePath,
            offset,
            returnedBytes: selected.byteLength,
            totalBytes: content.byteLength,
            hasMore: offset + selected.byteLength < content.byteLength,
          });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    });

    const searchTool = defineTool({
      name: "research_search",
      label: "Search visible workspace text",
      description: "Search visible UTF-8 workspace files before reading large files. Results include file and line number and are bounded.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "Literal case-insensitive text" }),
        path: Type.Optional(Type.String({ description: "Optional visible path prefix" })),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      execute: async (_id, params) => {
        try {
          const prefix = params.path?.replace(/^\.\//u, "").replace(/\/$/u, "");
          const files = (await listWorkspaceFiles(this.workspacePath)).filter((filePath) =>
            isAgentVisiblePath(filePath, hiddenPaths) && (!prefix || filePath === prefix || filePath.startsWith(`${prefix}/`)));
          const needle = params.query.toLocaleLowerCase();
          const maximum = params.maxResults ?? 80;
          const matches: string[] = [];
          for (const filePath of files) {
            if (matches.length >= maximum) break;
            const resolved = await resolveSafeWorkspacePath(this.workspacePath, filePath);
            const details = await stat(resolved.absolutePath);
            if (details.size > 2 * 1024 * 1024) continue;
            const content = await readFile(resolved.absolutePath, "utf8").catch(() => "");
            for (const [index, line] of content.split(/\r?\n/u).entries()) {
              if (line.toLocaleLowerCase().includes(needle)) matches.push(`${filePath}:${index + 1}:${line.slice(0, 500)}`);
              if (matches.length >= maximum) break;
            }
          }
          return textResult(matches.join("\n") || "<no matches>", { matches: matches.length, truncated: matches.length >= maximum });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    });

    const dataInfoTool = defineTool({
      name: "research_data_info",
      label: "Inspect visible data file",
      description: "Return a safe structural profile for one visible data file: size, SHA-256, format, and bounded schema/preview information. This never reads hidden evaluator data.",
      parameters: Type.Object({ path: Type.String({ description: "Relative visible data path" }) }),
      execute: async (_id, params) => {
        try {
          const resolved = await resolveSafeWorkspacePath(this.workspacePath, params.path);
          if (!isAgentVisiblePath(resolved.relativePath, hiddenPaths)) throw new Error("This path is hidden from the research agent");
          const content = await readFile(resolved.absolutePath);
          const extension = path.extname(resolved.relativePath).toLowerCase();
          const details: Record<string, unknown> = {
            path: resolved.relativePath,
            extension: extension || null,
            bytes: content.byteLength,
            sha256: createHash("sha256").update(content).digest("hex"),
          };
          if ([".csv", ".tsv"].includes(extension)) {
            const text = content.subarray(0, Math.min(content.byteLength, 256 * 1024)).toString("utf8");
            const delimiter = extension === ".tsv" ? "\t" : ",";
            const lines = text.split(/\r?\n/u).filter(Boolean);
            details.columns = (lines[0] ?? "").split(delimiter);
            details.previewRows = lines.slice(1, 6).map((line) => line.split(delimiter));
            details.sampledRows = Math.max(0, lines.length - 1);
            details.completeRowCount = content.byteLength <= 256 * 1024;
          } else if (extension === ".json") {
            const parsed = JSON.parse(content.toString("utf8")) as unknown;
            details.rootType = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
            if (Array.isArray(parsed)) {
              details.rows = parsed.length;
              details.sample = parsed.slice(0, 3);
            } else if (parsed && typeof parsed === "object") {
              details.keys = Object.keys(parsed as Record<string, unknown>).slice(0, 200);
            }
          } else if ([".txt", ".md", ".jsonl", ".yaml", ".yml"].includes(extension)) {
            details.preview = content.subarray(0, Math.min(content.byteLength, 16_384)).toString("utf8");
          } else {
            details.hint = "Use research_python with the canonical runtime for format-specific schema inspection.";
          }
          return textResult(JSON.stringify(details, null, 2), details);
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    });

    const labListTool = this.researchLab ? defineTool({
      name: "research_lab_list",
      label: "List persistent research lab files",
      description: "List durable files shared across experiments in this run. The lab never contains hidden evaluator data or candidate files unless you explicitly copy observations into it.",
      parameters: Type.Object({}),
      execute: async () => textResult((await this.researchLab!.listFiles()).join("\n") || "<empty lab>"),
    }) : undefined;

    const labReadTool = this.researchLab ? defineTool({
      name: "research_lab_read",
      label: "Read persistent research lab file",
      description: `Read one durable UTF-8 lab file (maximum ${MAX_READ_BYTES} bytes).`,
      parameters: Type.Object({ path: Type.String({ description: "Relative path inside the durable lab files directory" }) }),
      execute: async (_id, params) => {
        try {
          const content = await this.researchLab!.read(params.path);
          if (Buffer.byteLength(content) > MAX_READ_BYTES) throw new Error(`Lab file is larger than ${MAX_READ_BYTES} bytes`);
          return textResult(content, { path: params.path });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const labWriteTool = this.researchLab ? defineTool({
      name: "research_lab_write",
      label: "Write persistent research lab file",
      description: "Write a durable analysis recipe, parsed observation, or reusable helper shared by later experiments. This does not modify the candidate.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative path inside the durable lab files directory" }),
        content: Type.String({ description: "Complete UTF-8 content" }),
      }),
      execute: async (_id, params) => {
        try {
          if (Buffer.byteLength(params.content) > MAX_WRITE_BYTES) throw new Error(`Lab content is larger than ${MAX_WRITE_BYTES} bytes`);
          await this.researchLab!.write(params.path, params.content);
          return textResult(`Wrote durable lab file ${params.path}`, { path: params.path });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const labPythonTool = this.researchLab ? defineTool({
      name: "research_lab_python",
      label: "Run persistent research Python",
      description: "Execute Python in the run-scoped persistent kernel. Variables survive later calls. Set persist=true only for deterministic definitions that are safe to replay after process restart. The kernel has no candidate or evaluator mount.",
      parameters: Type.Object({
        code: Type.String({ description: "Python cell" }),
        persist: Type.Optional(Type.Boolean({ description: "Replay this successful cell when the lab kernel restarts" })),
      }),
      execute: async (_id, params) => {
        try {
          const result = await this.researchLab!.execute(params.code, { persist: params.persist === true });
          return textResult([
            result.stdout ? `STDOUT:\n${result.stdout}` : "STDOUT: <empty>",
            result.stderr ? `STDERR:\n${result.stderr}` : "",
            result.result ? `RESULT:\n${result.result}` : "",
            result.error ? `ERROR:\n${result.error}` : "",
            result.restoreErrors.length ? `RESTORE WARNINGS:\n${JSON.stringify(result.restoreErrors)}` : "",
            result.outputTruncated ? "Output preview was truncated; keep large results in durable lab files." : "",
          ].filter(Boolean).join("\n\n"), { id: result.id, ok: result.ok, outputTruncated: result.outputTruncated, isError: !result.ok });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const replaceTool = defineTool({
      name: "research_replace",
      label: "Replace text in mutable file",
      description: "Replace one exact text occurrence in a mutable file. Fails if the old text is absent or occurs more than once.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative mutable file path" }),
        oldText: Type.String({ description: "Exact existing text" }),
        newText: Type.String({ description: "Replacement text" }),
      }),
      execute: async (_id, params) => {
        try {
          const resolved = await resolveSafeWorkspacePath(this.workspacePath, params.path, { requireMutable: mutablePaths, protectedPaths });
          const content = await readFile(resolved.absolutePath, "utf8");
          const first = content.indexOf(params.oldText);
          const last = content.lastIndexOf(params.oldText);
          if (first === -1) throw new Error("oldText was not found");
          if (first !== last) throw new Error("oldText occurs more than once; provide more surrounding context");
          const updated = `${content.slice(0, first)}${params.newText}${content.slice(first + params.oldText.length)}`;
          if (Buffer.byteLength(updated) > MAX_WRITE_BYTES) throw new Error(`Updated file is larger than ${MAX_WRITE_BYTES} bytes`);
          await writeFile(resolved.absolutePath, updated, "utf8");
          await analysisExecutor?.syncCandidateFile(resolved.relativePath);
          return textResult(`Updated ${resolved.relativePath}`, { path: resolved.relativePath });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    });

    const writeTool = defineTool({
      name: "research_write",
      label: "Write mutable file",
      description: "Create or fully replace a file under a configured mutable path.",
      parameters: Type.Object({
        path: Type.String({ description: "Relative mutable file path" }),
        content: Type.String({ description: "Complete UTF-8 file content" }),
      }),
      execute: async (_id, params) => {
        try {
          if (Buffer.byteLength(params.content) > MAX_WRITE_BYTES) throw new Error(`Content is larger than ${MAX_WRITE_BYTES} bytes`);
          const resolved = await resolveSafeWorkspacePath(this.workspacePath, params.path, { allowMissing: true, requireMutable: mutablePaths, protectedPaths });
          await ensureDir(path.dirname(resolved.absolutePath));
          await writeFile(resolved.absolutePath, params.content, { encoding: "utf8", flag: "w" });
          await analysisExecutor?.syncCandidateFile(resolved.relativePath);
          return textResult(`Wrote ${resolved.relativePath}`, { path: resolved.relativePath });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    });

    const execTool = analysisExecutor ? defineTool({
      name: "research_exec",
      label: "Run open-research analysis",
      description: "Run an arbitrary command in the controlled analysis mirror. Use an argument array (no implicit shell). Docker mode has no hidden paths, no host mounts, and no network by default. Command-side file changes stay in the analysis mirror; persist candidate code with research_write/research_replace. Full stdout/stderr is audited under the experiment analysis directory.",
      parameters: Type.Object({
        command: Type.Array(Type.String(), { minItems: 1, description: "Executable and arguments, e.g. [\"python3\",\"candidate/analyze.py\"] or [\"bash\",\"-lc\",\"python3 script.py | tail\"]" }),
        cwd: Type.Optional(Type.String({ description: "Relative directory inside the analysis workspace; defaults to workspace root" })),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, description: "Per-call timeout capped by agent.analysis.timeoutSeconds" })),
      }),
      execute: async (_id, params, signal, onUpdate) => {
        try {
          const result = await analysisExecutor.run({
            command: params.command,
            ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
            ...(params.timeoutSeconds === undefined ? {} : { timeoutSeconds: params.timeoutSeconds }),
            ...(signal === undefined ? {} : { signal }),
            onOutput: (preview) => onUpdate?.(textResult(preview || "Command is running...")),
          });
          const summary = [
            `Command ${result.callId} (${result.evidenceId}) finished in ${(result.durationMs / 1_000).toFixed(2)}s with exit=${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}${result.timedOut ? " timed_out=true" : ""}${result.aborted ? " aborted=true" : ""}.`,
            `Candidate fingerprint: ${result.candidateFingerprint}; runtime fingerprint: ${result.runtimeFingerprint}.`,
            result.stdout ? `STDOUT:\n${result.stdout}` : "STDOUT: <empty>",
            result.stderr ? `STDERR:\n${result.stderr}` : "STDERR: <empty>",
            result.outputTruncated ? "Preview was truncated; full logs are preserved in the experiment analysis artifacts." : "",
            "Filesystem writes made by this command remain scratch-only. Use research_write/research_replace for the final candidate.",
          ].filter(Boolean).join("\n\n");
          return textResult(summary, {
            callId: result.callId,
            command: result.command,
            cwd: result.cwd,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            aborted: result.aborted,
            durationMs: result.durationMs,
            outputTruncated: result.outputTruncated,
            evidenceId: result.evidenceId,
            candidateFingerprint: result.candidateFingerprint,
            runtimeFingerprint: result.runtimeFingerprint,
          });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const runtimeInfoTool = analysisExecutor ? defineTool({
      name: "research_runtime_info",
      label: "Inspect canonical research runtime",
      description: "Inspect the exact analysis runtime, canonical Python/test commands, project import paths, dependency overlay and environment fingerprint before running commands.",
      parameters: Type.Object({}),
      execute: async () => {
        try {
          const info = await analysisExecutor.runtimeInfo();
          return textResult(JSON.stringify(info, null, 2), { ...info });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const pythonTool = analysisExecutor ? defineTool({
      name: "research_python",
      label: "Run canonical research Python",
      description: "Run Python with the configured canonical interpreter and project PYTHONPATH. Prefer this over invoking python/python3 through research_exec.",
      parameters: Type.Object({
        arguments: Type.Array(Type.String(), { description: "Arguments after the configured Python command, e.g. [\"script.py\",\"--limit\",\"50\"]" }),
        cwd: Type.Optional(Type.String()),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, params, signal, onUpdate) => {
        try {
          const runtime = await analysisExecutor.runtimeInfo();
          const result = await analysisExecutor.run({
            command: [...runtime.pythonCommand, ...params.arguments],
            ...(params.cwd ? { cwd: params.cwd } : {}),
            ...(params.timeoutSeconds ? { timeoutSeconds: params.timeoutSeconds } : {}),
            ...(signal ? { signal } : {}),
            onOutput: (preview) => onUpdate?.(textResult(preview || "Python is running...")),
          });
          return textResult([
            `${result.evidenceId}: exit=${result.exitCode ?? "null"}; duration=${(result.durationMs / 1_000).toFixed(2)}s; candidate=${result.candidateFingerprint}; runtime=${result.runtimeFingerprint}`,
            result.stdout ? `STDOUT:\n${result.stdout}` : "STDOUT: <empty>",
            result.stderr ? `STDERR:\n${result.stderr}` : "STDERR: <empty>",
          ].join("\n\n"), { ...result });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const testTool = analysisExecutor ? defineTool({
      name: "research_test",
      label: "Run canonical candidate tests",
      description: "Run the configured test command in the same analysis runtime and import-path contract used for candidate analysis.",
      parameters: Type.Object({
        arguments: Type.Optional(Type.Array(Type.String(), { description: "Additional test arguments" })),
        cwd: Type.Optional(Type.String()),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, params, signal, onUpdate) => {
        try {
          const runtime = await analysisExecutor.runtimeInfo();
          if (!runtime.testCommand) throw new Error("No agent.analysis.runtime.testCommand is configured");
          const result = await analysisExecutor.run({
            command: [...runtime.testCommand, ...(params.arguments ?? [])],
            ...(params.cwd ? { cwd: params.cwd } : {}),
            ...(params.timeoutSeconds ? { timeoutSeconds: params.timeoutSeconds } : {}),
            ...(signal ? { signal } : {}),
            onOutput: (preview) => onUpdate?.(textResult(preview || "Tests are running...")),
          });
          return textResult([
            `${result.evidenceId}: tests exit=${result.exitCode ?? "null"}; duration=${(result.durationMs / 1_000).toFixed(2)}s; candidate=${result.candidateFingerprint}`,
            result.stdout ? `STDOUT:\n${result.stdout}` : "STDOUT: <empty>",
            result.stderr ? `STDERR:\n${result.stderr}` : "STDERR: <empty>",
          ].join("\n\n"), { ...result });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const execStartTool = analysisExecutor && this.config.agent.analysis?.jobs?.enabled !== false ? defineTool({
      name: "research_exec_start",
      label: "Start background research job",
      description: "Start a long-running analysis job without blocking the agent turn. Write restartable checkpoints under .autoresearch-analysis, then poll with research_exec_status.",
      parameters: Type.Object({
        command: Type.Array(Type.String(), { minItems: 1 }),
        cwd: Type.Optional(Type.String()),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, params) => {
        try {
          const job = await analysisExecutor.start({
            command: params.command,
            ...(params.cwd ? { cwd: params.cwd } : {}),
            ...(params.timeoutSeconds ? { timeoutSeconds: params.timeoutSeconds } : {}),
          });
          return textResult(`Started ${job.jobId}. Poll it with research_exec_status.`, { ...job });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const execStatusTool = analysisExecutor && this.config.agent.analysis?.jobs?.enabled !== false ? defineTool({
      name: "research_exec_status",
      label: "Inspect research job",
      description: "Inspect one background analysis job, or list every job when jobId is omitted. Completed jobs expose their evidence id and fingerprints.",
      parameters: Type.Object({ jobId: Type.Optional(Type.String()) }),
      execute: async (_id, params) => {
        try {
          const snapshot = params.jobId ? analysisExecutor.job(params.jobId) : analysisExecutor.jobsSnapshot();
          return textResult(JSON.stringify(snapshot, null, 2), { snapshot });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const execCancelTool = analysisExecutor && this.config.agent.analysis?.jobs?.enabled !== false ? defineTool({
      name: "research_exec_cancel",
      label: "Cancel research job",
      description: "Cancel a running background analysis job and terminate its subprocess tree.",
      parameters: Type.Object({ jobId: Type.String() }),
      execute: async (_id, params) => {
        try {
          const snapshot = analysisExecutor.cancel(params.jobId);
          return textResult(`Cancellation requested for ${params.jobId}.`, { ...snapshot });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const evidenceTool = analysisExecutor ? defineTool({
      name: "research_evidence",
      label: "Inspect analysis evidence",
      description: "List analysis evidence ids, candidate/runtime fingerprints and stale state. Cite fresh successful ids in the proposal.",
      parameters: Type.Object({}),
      execute: async () => textResult(JSON.stringify({
        currentFreshEvidenceIds: analysisExecutor.freshSuccessfulEvidenceIds(),
        evidence: analysisExecutor.evidence(),
      }, null, 2)),
    }) : undefined;

    const compareTool = analysisExecutor ? defineTool({
      name: "research_compare",
      label: "Compare analysis metric artifacts",
      description: "Compare two visible JSON metric artifacts produced inside the analysis mirror. Accepts either a flat numeric object or an object with a metrics field; reports raw deltas and direction-aware primary improvement.",
      parameters: Type.Object({
        referencePath: Type.String({ description: "Reference JSON path inside the analysis workspace" }),
        candidatePath: Type.String({ description: "Candidate JSON path inside the analysis workspace" }),
      }),
      execute: async (_id, params) => {
        try {
          const parseMetrics = (text: string): Record<string, number> => {
            const parsed = JSON.parse(text) as unknown;
            const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "metrics" in parsed
              ? (parsed as { metrics: unknown }).metrics
              : parsed;
            if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Metric artifact must be a numeric object or contain metrics");
            return Object.fromEntries(Object.entries(source as Record<string, unknown>)
              .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
          };
          const reference = parseMetrics(await analysisExecutor.readAnalysisText(params.referencePath));
          const candidate = parseMetrics(await analysisExecutor.readAnalysisText(params.candidatePath));
          const names = [...new Set([...Object.keys(reference), ...Object.keys(candidate)])].sort();
          const comparison = names.map((name) => {
            const referenceValue = reference[name];
            const candidateValue = candidate[name];
            if (referenceValue === undefined || candidateValue === undefined) return { name, reference: referenceValue ?? null, candidate: candidateValue ?? null, delta: null };
            const delta = candidateValue - referenceValue;
            const configured = [context.primaryMetric, ...context.guardrails].find((metric) => metric.name === name);
            const improvement = configured?.direction === "minimize" ? -delta : delta;
            return { name, reference: referenceValue, candidate: candidateValue, delta, ...(configured ? { direction: configured.direction, improvement } : {}) };
          });
          return textResult(JSON.stringify({ referencePath: params.referencePath, candidatePath: params.candidatePath, comparison }, null, 2), { comparison });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const dependencyInfoTool = dependencyBroker ? defineTool({
      name: "research_dependency_info",
      label: "Inspect dependency versions",
      description: "Inspect allowlisted package versions through the controlled registry broker. This does not modify the candidate environment.",
      parameters: Type.Object({
        manager: Type.Union([Type.Literal("python"), Type.Literal("bun")]),
        package: Type.String({ description: "Registry package name" }),
      }),
      execute: async (_id, params) => {
        try {
          const result = await dependencyBroker.availability(params.manager, params.package);
          return textResult([
            `${result.status.toUpperCase()}: ${result.message}`,
            result.registry?.stdout ? `REGISTRY:\n${result.registry.stdout}` : "",
            result.registry?.stderr ? `REGISTRY STDERR:\n${result.registry.stderr}` : "",
          ].filter(Boolean).join("\n\n"), { ...result });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const addDependencyTool = dependencyBroker ? defineTool({
      name: "research_add_dependency",
      label: "Add locked dependency",
      description: "Install an allowlisted package through the broker. scope=analysis is disposable for diagnostics; scope=candidate writes a locked manifest and makes the identical overlay available to research_exec and the evaluator.",
      parameters: Type.Object({
        manager: Type.Union([Type.Literal("python"), Type.Literal("bun")]),
        package: Type.String({ description: "Registry package name" }),
        version: Type.Optional(Type.String({ description: "Exact version or allowed manager-specific version specifier" })),
        scope: Type.Union([Type.Literal("analysis"), Type.Literal("candidate")]),
        reason: Type.String({ description: "Why this dependency is needed for the experiment" }),
      }),
      execute: async (_id, params) => {
        try {
          const result = await dependencyBroker.add({
            manager: params.manager,
            package: params.package,
            ...(params.version === undefined ? {} : { version: params.version }),
            scope: params.scope,
            reason: params.reason,
          });
          if (result.candidateChanged) await analysisExecutor?.syncCandidateFile(dependencyBroker.manifestPath);
          else analysisExecutor?.invalidateRuntimeEvidence(`Dependency ${params.manager}/${params.package} added to analysis scope`);
          return textResult(
            `${params.manager}/${params.package} is available in ${params.scope} scope. Environment fingerprint: ${result.environment.fingerprint ?? "base-image-only"}.${result.candidateChanged ? " The locked candidate manifest was updated; evaluator runs will mount the same overlay." : " The dependency is disposable and will not be mounted by the evaluator."}`,
            { candidateChanged: result.candidateChanged, manifest: result.environment.manifest },
          );
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const removeDependencyTool = dependencyBroker ? defineTool({
      name: "research_remove_dependency",
      label: "Remove locked dependency",
      description: "Remove a direct dependency from analysis or candidate scope and rebuild the controlled overlay.",
      parameters: Type.Object({
        manager: Type.Union([Type.Literal("python"), Type.Literal("bun")]),
        package: Type.String({ description: "Registry package name" }),
        scope: Type.Union([Type.Literal("analysis"), Type.Literal("candidate")]),
        reason: Type.String({ description: "Why the dependency is no longer needed" }),
      }),
      execute: async (_id, params) => {
        try {
          const result = await dependencyBroker.remove(params.manager, params.package, params.scope, params.reason);
          if (result.candidateChanged) await analysisExecutor?.syncCandidateFile(dependencyBroker.manifestPath);
          else analysisExecutor?.invalidateRuntimeEvidence(`Dependency ${params.manager}/${params.package} removed from analysis scope`);
          return textResult(
            `${params.manager}/${params.package} was removed from ${params.scope} scope. Environment fingerprint: ${result.environment.fingerprint ?? "base-image-only"}.`,
            { candidateChanged: result.candidateChanged, manifest: result.environment.manifest },
          );
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const selectRuntimeProfileTool = dependencyBroker ? defineTool({
      name: "research_select_runtime_profile",
      label: "Select runtime profile",
      description: "Select one pre-approved Docker runtime profile for candidate analysis and evaluation. Arbitrary images are never accepted.",
      parameters: Type.Object({
        profile: Type.String({ description: "Configured environment profile id, or base to return to the scenario's default image" }),
        reason: Type.String({ description: "Why the experiment needs this profile" }),
      }),
      execute: async (_id, params) => {
        try {
          const environment = await dependencyBroker.selectProfile(params.profile, params.reason);
          await analysisExecutor?.syncCandidateFile(dependencyBroker.manifestPath);
          return textResult(
            `Runtime profile ${params.profile} selected and locked to ${environment.imageId}. Candidate analysis and evaluator runs will use the same image and dependency overlay.`,
            { manifest: environment.manifest },
          );
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

    const dependencyTools = [dependencyInfoTool, addDependencyTool, removeDependencyTool, selectRuntimeProfileTool]
      .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });
    const roleProfile = this.config.agent.roles?.implementer;
    const baseSystemPrompt = this.profile?.systemPrompt ?? roleProfile?.systemPrompt ?? this.config.agent.systemPrompt ?? [
      "You are a careful machine-learning researcher operating inside a controlled experiment.",
      "Use only the provided research tools. Treat evaluator files and metrics as immutable ground truth.",
      "Make one small, reviewable experiment at a time and explain the causal hypothesis.",
    ].join(" ");
    const systemPrompt = [
      baseSystemPrompt,
      ...(analysisExecutor ? [`The research_exec terminal is for exploratory evidence and diagnostics. It never authorizes access to hidden evaluation data, evaluator tampering, metric fabrication, or host escape. Persist only a coherent candidate through the mutation tools.${(this.config.agent.analysis?.minimumCallsBeforeProposal ?? 0) > 0 ? ` You must use research_exec at least ${this.config.agent.analysis!.minimumCallsBeforeProposal} time(s) before finalizing the proposal.` : ""}`] : []),
      ...(dependencyBroker ? ["Never install packages directly. Use the dependency broker. Choose analysis scope for temporary investigation and candidate scope only when candidate code or evaluation requires the dependency; candidate scope is locked and reproduced by the evaluator."] : []),
      ...(this.researchLab ? ["A persistent research lab is available across experiments. Use it for reusable analysis code and durable observations, never for fabricated metrics or copies of hidden data. Lab writes do not modify the candidate."] : []),
    ].join(" ");
    const loader = new DefaultResourceLoader({
      cwd: this.workspacePath,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await loader.reload();

    const modelRuntime = await ModelRuntime.create();
    let model;
    let thinkingLevel = this.profile?.thinkingLevel ?? roleProfile?.thinkingLevel ?? this.config.agent.thinkingLevel;
    const requestedModel = this.profile?.model ?? roleProfile?.model ?? this.config.agent.model;
    if (requestedModel) {
      const resolved = resolveCliModel({
        cliModel: requestedModel,
        cliThinking: thinkingLevel,
        modelRuntime,
      });
      if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `Could not resolve model ${this.config.agent.model}`);
      model = resolved.model;
      thinkingLevel = resolved.thinkingLevel ?? thinkingLevel;
      if (resolved.warning) piEvents.append("model_warning", { warning: resolved.warning });
    }

    const availableTools = [
      "research_list", "research_read", "research_search", "research_data_info", "research_replace", "research_write",
      ...(execTool ? ["research_runtime_info", "research_exec", "research_python", "research_compare", "research_evidence"] : []),
      ...(testTool ? ["research_test"] : []),
      ...(execStartTool ? ["research_exec_start", "research_exec_status", "research_exec_cancel"] : []),
      ...(dependencyBroker ? ["research_dependency_info", "research_add_dependency", "research_remove_dependency", "research_select_runtime_profile"] : []),
      ...(this.researchLab ? ["research_lab_list", "research_lab_read", "research_lab_write", "research_lab_python"] : []),
    ];
    const sessionResult = await createAgentSession({
      cwd: this.workspacePath,
      modelRuntime,
      ...(model ? { model } : {}),
      thinkingLevel,
      tools: availableTools,
      customTools: [
        listTool, readTool, searchTool, dataInfoTool, replaceTool, writeTool,
        ...[runtimeInfoTool, execTool, pythonTool, testTool, execStartTool, execStatusTool, execCancelTool, compareTool, evidenceTool]
          .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined),
        ...dependencyTools,
        ...[labListTool, labReadTool, labWriteTool, labPythonTool].filter((tool): tool is NonNullable<typeof tool> => tool !== undefined),
      ],
      resourceLoader: loader,
      sessionManager: SessionManager.create(this.workspacePath, path.join(this.experimentDir, "pi-session")),
      settingsManager,
    });
    this.session = sessionResult.session;
    piEvents.append("agent_session_configured", {
      requestedModel: requestedModel ?? null,
      resolvedModel: this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : null,
      requestedThinkingLevel: this.config.agent.thinkingLevel,
      effectiveThinkingLevel: this.session.thinkingLevel,
      availableTools,
    });
    this.implementerTranscript.status("proposal", "Implementer session configured", {
      requestedModel: requestedModel ?? null,
      resolvedModel: this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : null,
      thinkingLevel: this.session.thinkingLevel,
      availableTools,
    });
    if (sessionResult.modelFallbackMessage) piEvents.append("model_fallback", { message: sessionResult.modelFallbackMessage });

    let narrative = "";
    const unsubscribe = this.session.subscribe((event) => {
      piEvents.append("pi_event", { event: compactEvent(event) });
      this.implementerTranscript.record(event, "proposal");
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        narrative += event.assistantMessageEvent.delta;
      }
    });
    try {
      await this.session.prompt(buildPrompt(context, advisorNotes));
    } finally {
      unsubscribe();
    }
    if (this.session.agent.state.errorMessage) {
      throw new Error(`Pi agent failed: ${this.session.agent.state.errorMessage}`);
    }
    const minimumAnalysisCalls = this.config.agent.analysis?.minimumCallsBeforeProposal ?? 0;
    if (analysisExecutor && analysisExecutor.callCount < minimumAnalysisCalls) {
      throw new Error(`Agent proposal used research_exec ${analysisExecutor.callCount} time(s); configuration requires at least ${minimumAnalysisCalls}`);
    }
    let finalNarrative = narrative.trim() || "Agent completed without a textual experiment record.";
    let plan = parseExperimentPlan(finalNarrative);
    let validationErrors = proposalValidationErrors(plan, context, analysisExecutor);
    if (validationErrors.length) {
      piEvents.append("proposal_validation_failed", { errors: validationErrors, repairAttempt: 1 });
      this.implementerTranscript.status("proposal", "Proposal requires repair", { errors: validationErrors });
      let repairedNarrative = "";
      const repairSubscription = this.session.subscribe((event) => {
        piEvents.append("pi_event", { phase: "proposal", repairAttempt: 1, event: compactEvent(event) });
        this.implementerTranscript.record(event, "proposal");
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") repairedNarrative += event.assistantMessageEvent.delta;
      });
      try {
        await this.session.prompt(`Your proposal failed the harness pre-submit validator:\n- ${validationErrors.join("\n- ")}\n\nUse the available research tools to fix missing final-candidate evidence or settle running jobs. Then return a complete replacement Markdown record ending with exactly one valid <experiment_proposal> block. Existing lesson, method and question updates must reference ids shown in the experiment prompt.`);
      } finally {
        repairSubscription();
      }
      if (this.session.agent.state.errorMessage) throw new Error(`Pi proposal repair failed: ${this.session.agent.state.errorMessage}`);
      finalNarrative = repairedNarrative.trim() || finalNarrative;
      plan = parseExperimentPlan(finalNarrative);
      validationErrors = proposalValidationErrors(plan, context, analysisExecutor);
      if (validationErrors.length) throw new Error(`Agent proposal failed pre-submit validation after repair: ${validationErrors.join("; ")}`);
      piEvents.append("proposal_validation_repaired", { analysisEvidence: plan?.analysisEvidence ?? [] });
    }
    return {
      narrative: finalNarrative,
      ...(plan ? { plan } : {}),
      agent: {
        ...(this.session.model ? { model: `${this.session.model.provider}/${this.session.model.id}` } : {}),
        thinkingLevel: this.session.thinkingLevel,
        ...(this.profile?.id ? { profileId: this.profile.id } : {}),
      },
    };
  }

  async review(context: ResearchContext, proposal: ResearchProposal, changedPaths: string[]): Promise<ProposalReview> {
    const reviewer = this.config.agent.roles?.reviewer;
    if (!reviewer) return { approved: true, summary: "No independent reviewer role is configured", concerns: [] };
    const piEvents = new EventLog(path.join(this.experimentDir, "reviewer-events.jsonl"));
    const hiddenPaths = this.config.project.hiddenPaths ?? [];
    const listTool = defineTool({
      name: "review_list",
      label: "List workspace files",
      description: "List files in the candidate workspace. This tool is read-only.",
      parameters: Type.Object({}),
      execute: async () => textResult((await listWorkspaceFiles(this.workspacePath)).filter((filePath) => isAgentVisiblePath(filePath, hiddenPaths)).join("\n")),
    });
    const readTool = defineTool({
      name: "review_read",
      label: "Read workspace file",
      description: `Read one UTF-8 candidate file (maximum ${MAX_READ_BYTES} bytes).`,
      parameters: Type.Object({ path: Type.String({ description: "Relative workspace path" }) }),
      execute: async (_id, params) => {
        try {
          const resolved = await resolveSafeWorkspacePath(this.workspacePath, params.path);
          if (!isAgentVisiblePath(resolved.relativePath, hiddenPaths)) throw new Error("This path is hidden from the reviewer");
          const content = await readFile(resolved.absolutePath);
          if (content.byteLength > MAX_READ_BYTES) throw new Error(`File is larger than ${MAX_READ_BYTES} bytes`);
          return textResult(content.toString("utf8"), { path: resolved.relativePath, bytes: content.byteLength });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
    const loader = new DefaultResourceLoader({
      cwd: this.workspacePath,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: reviewer.systemPrompt ?? "You are an independent ML experiment reviewer. Reject unsafe, confounded, duplicate, or unfalsifiable proposals. You have read-only tools and cannot modify the candidate.",
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create();
    const resolved = reviewer.model ? resolveCliModel({ cliModel: reviewer.model, cliThinking: reviewer.thinkingLevel, modelRuntime }) : undefined;
    if (resolved?.error || (reviewer.model && !resolved?.model)) throw new Error(resolved?.error ?? `Could not resolve reviewer model ${reviewer.model}`);
    const result = await createAgentSession({
      cwd: this.workspacePath,
      modelRuntime,
      ...(resolved?.model ? { model: resolved.model } : {}),
      thinkingLevel: resolved?.thinkingLevel ?? reviewer.thinkingLevel,
      tools: ["review_list", "review_read"],
      customTools: [listTool, readTool],
      resourceLoader: loader,
      sessionManager: SessionManager.create(this.workspacePath, path.join(this.experimentDir, "reviewer-session")),
      settingsManager,
    });
    this.reviewerTranscript.status("proposal_review", "Reviewer session configured", {
      requestedModel: reviewer.model ?? null,
      resolvedModel: result.session.model ? `${result.session.model.provider}/${result.session.model.id}` : null,
      thinkingLevel: result.session.thinkingLevel,
    });
    let narrative = "";
    const unsubscribe = result.session.subscribe((event) => {
      piEvents.append("pi_event", { phase: "proposal_review", event: compactEvent(event) });
      this.reviewerTranscript.record(event, "proposal_review");
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") narrative += event.assistantMessageEvent.delta;
    });
    try {
      await result.session.prompt(`# Independent review of ${context.experimentId}\n\nStrategy: ${context.assignment.strategy}\nParent: ${context.assignment.parentId}\nPrimary metric policy: ${JSON.stringify(context.primaryMetric)}\nGuardrails: ${JSON.stringify(context.guardrails)}\nMutable paths: ${context.mutablePaths.join(", ")}\nChanged paths: ${changedPaths.join(", ") || "none"}\nStructured plan: ${JSON.stringify(proposal.plan ?? null)}\n\nProposal:\n${proposal.narrative}\n\nInspect changed files as needed. Approve only when the experiment is scoped, falsifiable, allowed, causally interpretable, and does not tamper with evaluation. A valid parameter_sweep request may intentionally have no workspace edit because the harness applies the declared values after review; verify that it uses exactly one declared parameter instead of rejecting it for an empty diff. Finish with exactly:\n<proposal_review>\n{"approved":true,"summary":"short verdict","concerns":[]}\n</proposal_review>`);
    } finally {
      unsubscribe();
      try {
        this.reviewerUsage = addAgentUsage(this.reviewerUsage, usageFromSessionStats(result.session.getSessionStats()));
      } finally {
        result.session.dispose();
      }
    }
    if (result.session.agent.state.errorMessage) throw new Error(`Pi reviewer failed: ${result.session.agent.state.errorMessage}`);
    return parseProposalReview(narrative.trim() || "Reviewer completed without a textual verdict.");
  }

  async reflect(outcome: ResearchOutcome): Promise<ResearchConclusion> {
    if (!this.session) throw new Error("Cannot reflect before an agent session exists");
    this.session.agent.state.tools = [];
    const piEvents = new EventLog(path.join(this.experimentDir, "pi-events.jsonl"));
    let conclusion = "";
    const unsubscribe = this.session.subscribe((event) => {
      piEvents.append("pi_event", { phase: "reflection", event: compactEvent(event) });
      this.implementerTranscript.record(event, "reflection");
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        conclusion += event.assistantMessageEvent.delta;
      }
    });
    try {
      await this.session.prompt(`# Experiment outcome: ${outcome.experimentId}

- Changed paths: ${outcome.changedPaths.join(", ") || "none"}
- Assigned strategy: ${outcome.assignment.strategy}
- Parent checkpoint: ${outcome.assignment.parentId}
- Parent metrics: ${JSON.stringify(outcome.parentMetrics)}
- Structured hypothesis: ${outcome.plan?.hypothesis ?? "unstructured"}
- Previously accepted metrics: ${JSON.stringify(outcome.acceptedMetricsBefore)}
- Candidate evaluation: ${JSON.stringify(outcome.evaluation)}
${outcome.pairedEvaluation ? `- Paired evaluation against ${outcome.pairedEvaluation.referenceId}: ${JSON.stringify(outcome.pairedEvaluation)}` : "- Paired evaluation: not requested"}
${outcome.parameterSweep ? `- Parameter sweep (all controlled trials and selected winner): ${JSON.stringify(outcome.parameterSweep)}` : "- Parameter sweep: not requested"}
- Harness decision: ${outcome.decision.status}
- Decision reasons: ${outcome.decision.reasons.join("; ")}

You have no tools in this reflection phase. Write a concise Markdown conclusion covering what the result supports or falsifies, likely explanation, confidence/caveats including measurement noise, and the most useful next hypothesis.

Existing lessons eligible for direct evidence updates in this experiment: ${JSON.stringify(outcome.plan?.lessonTests ?? [])}. Existing methods eligible for updates: ${JSON.stringify(outcome.plan?.methodTests ?? [])}. Do not emit supports/contradicts/retire for any other existing id. You may still create a genuinely new tentative lesson with relation=new.

You may keep free-form research notes. Clearly distinguish observations from deterministic facts. Finish with exactly one block:

<experiment_conclusion>
{"summary":"short conclusion","notes":["free-form researcher observation"],"lessonUpdates":[{"lessonId":"optional-known-id","claim":"precise scoped claim","relation":"new|supports|contradicts|retire","guidance":"consider|avoid|verify","confidence":0.0,"evidenceKind":"direct|replication|contextual","evidenceRationale":"why this experiment is relevant evidence"}],"methodUpdates":[{"methodId":"optional-known-id","kind":"prompt-note|analysis-recipe|context-selector|role-spec|screening-policy","content":"bounded advisory research procedure","relation":"new|supports|contradicts|retire","rationale":"why the procedure affected research quality"}],"questionUpdates":[{"questionId":"question addressed in the proposal","status":"resolved|invalidated","resolution":"what the experiment established"}],"nextHypotheses":["specific next test"]}
</experiment_conclusion>

Known lesson and method IDs must be used when updating existing records. Pre-registered direct tests affect evidence counters. New methods remain trial-only until the harness observes enough independent evidence. Methods are advisory and cannot modify evaluator code, metric definitions, protected or hidden paths, credentials, networking, or sandbox policy. A harness-controlled paired comparison on fresh seeds may use evidenceKind=replication for a pre-registered existing lesson; ordinary exact replications and contextual observations stay in the audit log. Resolve only questions listed in the proposal. New lessons remain tentative until the harness observes enough independent evidence. Do not reinterpret or override the harness decision.`);
    } finally {
      unsubscribe();
    }
    if (this.session.agent.state.errorMessage) {
      throw new Error(`Pi reflection failed: ${this.session.agent.state.errorMessage}`);
    }
    return parseResearchConclusion(conclusion.trim() || "No textual conclusion was produced.");
  }

  async dispose(): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
  }

  getUsage(): AgentUsage {
    const implementerUsage = this.session
      ? usageFromSessionStats(this.session.getSessionStats())
      : emptyAgentUsage();
    return addAgentUsage(implementerUsage, this.reviewerUsage);
  }
}
