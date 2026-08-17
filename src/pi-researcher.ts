import { readFile, writeFile } from "node:fs/promises";
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
  ExperimentPlan,
  HarnessConfig,
  LessonGuidance,
  LessonUpdate,
  ResearchConclusion,
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

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function isAgentVisiblePath(relativePath: string, hiddenPaths: string[]): boolean {
  return !isPathMatched(relativePath, hiddenPaths);
}

export async function resolveAgentSelection(agent: HarnessConfig["agent"]): Promise<{
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
    questionsAddressed: textArray(raw.questionsAddressed),
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

export function parseResearchConclusion(narrative: string): ResearchConclusion {
  const raw = taggedJson(narrative, "experiment_conclusion");
  return {
    narrative,
    summary: textField(raw?.summary, narrative.split("\n").find((line) => line.trim()) ?? "No structured conclusion", 2_000),
    notes: textArray(raw?.notes),
    lessonUpdates: parseLessonUpdates(raw?.lessonUpdates),
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

function buildPrompt(context: ResearchContext): string {
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
    ? `A controlled research_exec terminal is available (${context.analysis.runner}, at most ${context.analysis.maxCalls} calls, ${context.analysis.timeoutSeconds}s per call). Use it to inspect data, write and run analysis scripts, compare algorithms, probe outliers, test feature transformations, and measure cheap diagnostics before proposing the candidate. Its filesystem is an analysis mirror without hidden paths. Command-side file changes are scratch-only; persist the final candidate with research_write/research_replace. Never attempt to infer or access hidden holdout data.`
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

## Previous experiments

${history}

## Active research campaign

${campaign}

## Required workflow

1. Inspect the relevant source and evaluator using the read-only tools. ${context.analysis.enabled ? "Use research_exec for evidence-driven exploratory analysis before settling on a change; prefer scripts over unsupported intuition." : ""}
2. Follow the assigned strategy. Cite lesson IDs you rely on or deliberately challenge. Put a lesson in lessonTests only when this experiment directly tests it.
3. Form one falsifiable hypothesis informed by the history and campaign. Estimate its expected gain, probability of success, information gain, and relative compute cost. Avoid repeating a prior hypothesis without new evidence.
4. ${context.assignment.strategy === "replicate" ? "Do not change any file; this is an exact checkpoint replication." : "Change only the mutable paths, using the restricted mutation tools. You may edit several mutable files when they form one coherent experiment. A parameter sweep request may be submitted without changing the workspace; the harness applies the declared values."}${context.assignment.strategy === "ensemble" ? " Inspect .autoresearch-ensemble/manifest.json and its immutable source snapshots, then implement one reproducible ensemble in mutable project files; never edit the snapshots." : ""}
5. Do not claim that a metric improved: you cannot run or control the evaluator. When enabled, you may preregister exactly one bounded paired comparison or parameter sweep for the harness to execute.
6. Finish with a concise Markdown experiment record and then exactly one machine-readable block:

<experiment_proposal>
{"hypothesis":"falsifiable claim","changeCategory":"one of: ${CHANGE_CATEGORIES.join("|")}","expectedEffect":"metric effect and why","expectedGain":0.0,"probabilityOfSuccess":0.0,"informationGain":0.0,"estimatedCost":1.0,"resourceRequest":{"cpu":1,"memoryGb":1,"gpu":0,"vramGb":0},"falsificationCriterion":"observable outcome that rejects the claim","dependencies":[],"followUpHypotheses":["2-4 concrete dependent or alternative tests"],"notes":["useful observation made while inspecting the project"],"lessonsUsed":["lesson-id"],"contradictedLessons":[],"lessonTests":["pre-registered directly tested lesson-id"],"questionsAddressed":["question-id actually addressed by this experiment"]${evaluationRequestField}}
</experiment_proposal>

Do not make unrelated cleanup changes. Do not write metrics or alter evaluation logic. Harness facts outrank agent notes and interpretations.`;
}

export class PiResearcher implements Researcher {
  private readonly config: HarnessConfig;
  private readonly workspacePath: string;
  private readonly experimentDir: string;
  private readonly profile: AgentProfileConfig | undefined;
  private readonly implementerTranscript: AgentTranscriptRecorder;
  private readonly reviewerTranscript: AgentTranscriptRecorder;
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  private reviewerUsage = emptyAgentUsage();

  constructor(config: HarnessConfig, workspacePath: string, experimentDir: string, profile?: AgentProfileConfig) {
    this.config = config;
    this.workspacePath = workspacePath;
    this.experimentDir = experimentDir;
    this.profile = profile;
    const transcriptPath = path.join(experimentDir, "agent-transcript.jsonl");
    this.implementerTranscript = new AgentTranscriptRecorder(transcriptPath, "implementer");
    this.reviewerTranscript = new AgentTranscriptRecorder(transcriptPath, "reviewer");
  }

  async propose(context: ResearchContext): Promise<ResearchProposal> {
    await ensureDir(this.experimentDir);
    const piEvents = new EventLog(path.join(this.experimentDir, "pi-events.jsonl"));
    const mutablePaths = this.config.project.mutablePaths;
    const hiddenPaths = this.config.project.hiddenPaths ?? [];
    const protectedPaths = uniquePaths([...this.config.project.protectedPaths, ...hiddenPaths]);
    const analysisExecutor = this.config.agent.analysis?.enabled
      ? new OpenResearchExecutor(this.config.agent.analysis, this.workspacePath, this.experimentDir, hiddenPaths)
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
      description: `Read one UTF-8 file from the isolated workspace (maximum ${MAX_READ_BYTES} bytes).`,
      parameters: Type.Object({ path: Type.String({ description: "Relative workspace path" }) }),
      execute: async (_id, params) => {
        try {
          const resolved = await resolveSafeWorkspacePath(this.workspacePath, params.path);
          if (!isAgentVisiblePath(resolved.relativePath, hiddenPaths)) throw new Error("This path is hidden from the research agent");
          const content = await readFile(resolved.absolutePath);
          if (content.byteLength > MAX_READ_BYTES) throw new Error(`File is larger than ${MAX_READ_BYTES} bytes`);
          return textResult(content.toString("utf8"), { path: resolved.relativePath, bytes: content.byteLength });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    });

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
            `Command ${result.callId} finished in ${(result.durationMs / 1_000).toFixed(2)}s with exit=${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}${result.timedOut ? " timed_out=true" : ""}${result.aborted ? " aborted=true" : ""}.`,
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
          });
        } catch (error) {
          return textResult(`ERROR: ${errorText(error)}`, { isError: true });
        }
      },
    }) : undefined;

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
      ...(analysisExecutor ? ["The research_exec terminal is for exploratory evidence and diagnostics. It never authorizes access to hidden evaluation data, evaluator tampering, metric fabrication, or host escape. Persist only a coherent candidate through the mutation tools."] : []),
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

    const sessionResult = await createAgentSession({
      cwd: this.workspacePath,
      modelRuntime,
      ...(model ? { model } : {}),
      thinkingLevel,
      tools: ["research_list", "research_read", "research_replace", "research_write", ...(execTool ? ["research_exec"] : [])],
      customTools: [listTool, readTool, replaceTool, writeTool, ...(execTool ? [execTool] : [])],
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
    });
    this.implementerTranscript.status("proposal", "Implementer session configured", {
      requestedModel: requestedModel ?? null,
      resolvedModel: this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : null,
      thinkingLevel: this.session.thinkingLevel,
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
      await this.session.prompt(buildPrompt(context));
    } finally {
      unsubscribe();
    }
    if (this.session.agent.state.errorMessage) {
      throw new Error(`Pi agent failed: ${this.session.agent.state.errorMessage}`);
    }
    const finalNarrative = narrative.trim() || "Agent completed without a textual experiment record.";
    const plan = parseExperimentPlan(finalNarrative);
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

You may keep free-form research notes. Clearly distinguish observations from deterministic facts. Finish with exactly one block:

<experiment_conclusion>
{"summary":"short conclusion","notes":["free-form researcher observation"],"lessonUpdates":[{"lessonId":"optional-known-id","claim":"precise scoped claim","relation":"new|supports|contradicts|retire","guidance":"consider|avoid|verify","confidence":0.0,"evidenceKind":"direct|replication|contextual","evidenceRationale":"why this experiment is relevant evidence"}],"questionUpdates":[{"questionId":"question addressed in the proposal","status":"resolved|invalidated","resolution":"what the experiment established"}],"nextHypotheses":["specific next test"]}
</experiment_conclusion>

Known lesson IDs must be used when updating an existing lesson. Pre-registered direct lesson tests affect evidence counters. A harness-controlled paired comparison on fresh seeds may use evidenceKind=replication for a pre-registered existing lesson; ordinary exact replications and contextual observations stay in the audit log. Resolve only questions listed in the proposal. New lessons remain tentative until the harness observes enough independent evidence. Do not reinterpret or override the harness decision.`);
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
