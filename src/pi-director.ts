import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession, DefaultResourceLoader, defineTool, getAgentDir,
  resolveCliModel, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentTranscriptRecorder } from "./agent-transcript.js";
import { OpenResearchExecutor } from "./analysis-executor.js";
import { DependencyBroker } from "./dependency-broker.js";
import { emptyAgentUsage } from "./experiment-accounting.js";
import { ensureDir, writeJsonAtomic } from "./io.js";
import { parseExperimentPlan, parseProposalReview, parseResearchConclusion } from "./pi-researcher.js";
import { CHANGE_CATEGORIES } from "./change-category.js";
import { isPathMatched, listWorkspaceFiles, resolveSafeWorkspacePath } from "./workspace.js";
import { RecoverableResearcherError } from "./research-errors.js";
import { createAgentModelRuntime } from "./model-runtime.js";
import type { ResearchDirector } from "./directed-researcher.js";
import type {
  AgentProfileConfig, AgentTranscriptPhase, AgentUsage, HarnessConfig, ProposalReview,
  ResearchBrief, ResearchConclusion, ResearchContext, ResearchOutcome, ResearchProposal,
} from "./types.js";

export interface DirectorChat {
  prompt(text: string, phase: AgentTranscriptPhase): Promise<string>;
  getUsage(): AgentUsage;
  dispose(): void;
}

export interface DirectorChatOptions {
  profile: AgentProfileConfig;
  modelsPath?: string | undefined;
  workspacePath: string;
  sessionDir: string;
  tools: ReturnType<typeof defineTool>[];
  transcript: AgentTranscriptRecorder;
}

export type DirectorChatFactory = (options: DirectorChatOptions) => Promise<DirectorChat>;

const createDirectorChat: DirectorChatFactory = async (options) => {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  const loader = new DefaultResourceLoader({
    cwd: options.workspacePath, agentDir: getAgentDir(), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: [
      "You are the research director. Own hypotheses, experimental design, implementation review and interpretation of trusted evaluator results. Delegate code edits to the implementer.",
      "You may read visible source and run bounded scratch-only analyses. You have no candidate mutation tools. Never modify scoring, hidden data, promotion rules or the workspace, and never treat implementer claims as measured improvement.",
      "Use package/workspace-relative paths. Persist scientific conclusions through the structured protocol; the harness owns promotion and durable evidence rules.",
      options.profile.systemPrompt ?? "",
    ].join("\n"),
  });
  await loader.reload();
  const modelRuntime = await createAgentModelRuntime(options);
  const resolved = resolveCliModel({ cliModel: options.profile.model!, cliThinking: options.profile.thinkingLevel, modelRuntime });
  if (resolved.error || !resolved.model) throw new Error(resolved.error ?? "Could not resolve director model");
  const result = await createAgentSession({
    cwd: options.workspacePath, modelRuntime, model: resolved.model,
    thinkingLevel: resolved.thinkingLevel ?? options.profile.thinkingLevel,
    tools: options.tools.map((tool) => tool.name), customTools: options.tools,
    resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(options.workspacePath, options.sessionDir),
  });
  const session = result.session;
  options.transcript.status("planning", "Director session configured", {
    requestedModel: options.profile.model, resolvedModel: `${session.model?.provider}/${session.model?.id}`,
    thinkingLevel: session.thinkingLevel,
  });
  return {
    async prompt(text, phase) {
      let narrative = "";
      const unsubscribe = session.subscribe((event) => {
        options.transcript.record(event, phase);
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") narrative += event.assistantMessageEvent.delta;
      });
      try {
        await session.prompt(text);
      } finally {
        unsubscribe();
      }
      if (session.agent.state.errorMessage) throw new Error(`Director request failed: ${session.agent.state.errorMessage}`);
      return narrative.trim();
    },
    getUsage() {
      const stats = session.getSessionStats();
      return { requests: stats.assistantMessages, inputTokens: stats.tokens.input, outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead, cacheWriteTokens: stats.tokens.cacheWrite,
        totalTokens: stats.tokens.total, costUsd: stats.cost };
    },
    dispose() { session.dispose(); },
  };
};

function tagged(text: string, tag: string): Record<string, unknown> {
  const matches = [...text.matchAll(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "gi"))];
  if (matches.length !== 1) throw new Error(`Expected exactly one <${tag}> block`);
  const raw: unknown = JSON.parse(matches[0]![1]!);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${tag} must contain an object`);
  return raw as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}

function requiredList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new Error(`${field} must have 1-30 entries`);
  return value.map((entry) => requiredText(entry, field));
}

export function parseDirectorBrief(text: string, context: ResearchContext): ResearchBrief {
  const raw = tagged(text, "research_brief");
  if (!raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)) throw new Error("research_brief.plan is required");
  const planRaw = raw.plan as Record<string, unknown>;
  for (const field of ["hypothesis", "expectedEffect", "falsificationCriterion"]) requiredText(planRaw[field], `plan.${field}`);
  if (!CHANGE_CATEGORIES.includes(planRaw.changeCategory as typeof CHANGE_CATEGORIES[number])) throw new Error("Invalid plan.changeCategory");
  const plan = parseExperimentPlan(`<experiment_proposal>${JSON.stringify(planRaw)}</experiment_proposal>`)!;
  const knownLessons = new Set(context.memory.lessons.map((item) => item.id));
  const knownMethods = new Set((context.methods ?? []).map((item) => item.id));
  const knownQuestions = new Set(context.memory.questions.map((item) => item.id));
  if (plan.lessonTests.some((id) => !knownLessons.has(id))) throw new Error("Director preregistered an unknown lesson");
  if ((plan.methodTests ?? []).some((id) => !knownMethods.has(id))) throw new Error("Director preregistered an unknown method");
  if (plan.questionsAddressed.some((id) => !knownQuestions.has(id))) throw new Error("Director preregistered an unknown question");
  delete plan.analysisEvidence; // Only final implementer validation can supply it.
  return { plan, implementationInstructions: requiredList(raw.implementationInstructions, "implementationInstructions"),
    acceptanceChecks: requiredList(raw.acceptanceChecks, "acceptanceChecks") };
}

export class PiResearchDirector implements ResearchDirector {
  private chat: DirectorChat | undefined;
  private analysis: OpenResearchExecutor | undefined;
  private analysisUsed = 0;
  private phaseIndex = 0;
  private readonly transcript: AgentTranscriptRecorder;

  constructor(
    private readonly config: HarnessConfig,
    private readonly workspacePath: string,
    private readonly experimentDir: string,
    private readonly chatFactory: DirectorChatFactory = createDirectorChat,
  ) {
    this.transcript = new AgentTranscriptRecorder(path.join(experimentDir, "agent-transcript.jsonl"), "director");
  }

  private tools(): ReturnType<typeof defineTool>[] {
    const visible = (name: string) => !isPathMatched(name, this.config.project.hiddenPaths ?? []);
    const output = (value: unknown, error = false) => ({
      content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
      details: { isError: error },
      ...(error ? { isError: true } : {}),
    });
    const readVisible = async (relative: string) => {
      const resolved = await resolveSafeWorkspacePath(this.workspacePath, relative);
      if (!visible(resolved.relativePath)) throw new Error("This path is hidden from the director");
      if ((await stat(resolved.absolutePath)).size > 512 * 1024) throw new Error("File exceeds 512 KiB; inspect structured data through scratch analysis");
      return readFile(resolved.absolutePath, "utf8");
    };
    const tools = [
      defineTool({ name: "director_list", label: "List visible source", description: "List workspace-relative visible paths.",
        parameters: Type.Object({}), execute: async () => output((await listWorkspaceFiles(this.workspacePath)).filter(visible)) }),
      defineTool({ name: "director_read", label: "Read source", description: "Read a visible UTF-8 file, at most 512 KiB. No hidden paths.",
        parameters: Type.Object({ path: Type.String() }), execute: async (_id, params) => {
          try { return output(await readVisible(params.path)); } catch (error) { return output(String(error), true); }
        } }),
      defineTool({ name: "director_search", label: "Search visible source", description: "Literal text search with at most 50 matching visible source lines.",
        parameters: Type.Object({ text: Type.String({ minLength: 1 }) }), execute: async (_id, params) => {
          const matches: string[] = [];
          for (const name of (await listWorkspaceFiles(this.workspacePath)).filter(visible)) {
            if (!/\.(?:py|ts|js|json|md|ya?ml|toml|txt|sql)$/i.test(name)) continue;
            const content = await readVisible(name).catch(() => "");
            const lines = content.split(/\r?\n/u);
            for (let index = 0; index < lines.length && matches.length < 50; index += 1) {
              if (lines[index]!.includes(params.text)) matches.push(`${name}:${index + 1}:${lines[index]!.slice(0, 1000)}`);
            }
            if (matches.length === 50) break;
          }
          return output(matches);
        } }),
    ];
    if (this.config.agent.analysis?.enabled) {
      const run = async (command: string[]) => {
        try {
          if (!this.analysis) throw new Error("Director analysis budget exhausted or no phase is active");
          const result = await this.analysis.run({ command });
          return output({ evidenceRef: `director/phase-${this.phaseIndex}/${result.evidenceId}`,
            candidateFingerprint: result.candidateFingerprint, runtimeFingerprint: result.runtimeFingerprint,
            exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr,
            outputTruncated: result.outputTruncated });
        } catch (error) { return output(String(error), true); }
      };
      tools.push(
        defineTool({ name: "director_runtime_info", label: "Director analysis runtime", description: "Inspect the canonical interpreter and remaining director analysis budget.",
          parameters: Type.Object({}), execute: async () => output({
            remainingCalls: Math.max(0, (this.config.agent.orchestration?.directorMaxAnalysisCalls ?? 20) - this.analysisUsed - (this.analysis?.callCount ?? 0)),
            pythonCommand: this.config.agent.analysis?.runtime?.pythonCommand ?? ["python3"],
            workspace: ".", scratch: ".autoresearch-analysis", candidateMutationAllowed: false,
          }) }),
        defineTool({ name: "director_exec", label: "Scratch analysis", description: "Run argv in an isolated visible-data mirror. All command writes are scratch-only; results cannot promote candidates.",
          parameters: Type.Object({ command: Type.Array(Type.String(), { minItems: 1 }) }), execute: async (_id, params) => run(params.command) }),
        defineTool({ name: "director_python", label: "Python analysis", description: "Run Python in the scratch mirror with the canonical interpreter. The actual candidate cannot be edited.",
          parameters: Type.Object({ code: Type.String({ minLength: 1 }) }), execute: async (_id, params) => run([
            ...(this.config.agent.analysis?.runtime?.pythonCommand ?? ["python3"]), "-c", params.code,
          ]) }),
      );
    }
    return tools;
  }

  private async phase<T>(phase: AgentTranscriptPhase, prompt: string, parse: (text: string) => T): Promise<T> {
    this.phaseIndex += 1;
    const directory = path.join(this.experimentDir, "director", `phase-${this.phaseIndex}`);
    await ensureDir(directory);
    if (!this.chat) {
      this.chat = await this.chatFactory({ profile: this.config.agent.roles!.director!, workspacePath: this.workspacePath,
        modelsPath: this.config.agent.modelsPath,
        sessionDir: path.join(this.experimentDir, "director", "session"), tools: this.tools(), transcript: this.transcript });
    }
    const remaining = (this.config.agent.orchestration?.directorMaxAnalysisCalls ?? 20) - this.analysisUsed;
    if (this.config.agent.analysis?.enabled && remaining > 0) {
      const broker = this.config.runtimeDependencies?.enabled
        ? new DependencyBroker(this.config, this.workspacePath, directory) : undefined;
      this.analysis = new OpenResearchExecutor({ ...this.config.agent.analysis, maxCalls: remaining,
        finalValidationReserve: 0, minimumCallsBeforeProposal: 0, jobs: { enabled: false, maxConcurrent: 1 } },
      this.workspacePath, directory, this.config.project.hiddenPaths ?? [],
      broker ? () => broker.environment() : undefined, undefined, this.config.project.mutablePaths);
    }
    try {
      const text = await this.chat.prompt(prompt, phase);
      try { return parse(text); } catch (error) {
        const repair = await this.chat.prompt(`Your ${phase} response failed protocol validation: ${String(error)}. Return a complete corrected response with exactly one required JSON block. Do not change the experiment or infer missing evidence.`, phase);
        try { return parse(repair); } catch (repairError) {
          throw new RecoverableResearcherError(`Director ${phase} protocol failed: ${String(repairError)}`, "director_protocol_error");
        }
      }
    } finally {
      this.analysisUsed += this.analysis?.callCount ?? 0;
      await this.analysis?.dispose();
      await writeJsonAtomic(path.join(directory, "phase.json"), { phase,
        analysisCalls: this.analysis?.callCount ?? 0, totalAnalysisCalls: this.analysisUsed,
        cumulativeAgentUsage: this.chat.getUsage(),
        evidence: this.analysis?.evidence() ?? [] });
      this.analysis = undefined;
    }
  }

  async plan(context: ResearchContext): Promise<ResearchBrief> {
    const assignment = { ...context.assignment, parentWorkspacePath: ".",
      activeCampaignTickets: context.campaign?.tickets.filter((ticket) => ticket.status === "queued" || ticket.status === "running") ?? [],
    };
    return this.phase("planning", `Design the next experiment before code changes. Follow the assigned strategy and the controlled campaign; refine its hypothesis into a falsifiable test. Inspect visible source/data as needed. Delegate code changes to the implementer.\n\nInstructions: ${context.researchInstructions}\nAssignment: ${JSON.stringify(assignment)}\nPrimary/guardrails: ${JSON.stringify({ primary: context.primaryMetric, guardrails: context.guardrails })}\nAccepted metrics: ${JSON.stringify(context.acceptedMetrics)}\nRecent experiments: ${JSON.stringify(context.previousExperiments)}\nResearch memory: ${JSON.stringify(context.memory)}\nMethods: ${JSON.stringify(context.methods ?? [])}\nMutable paths: ${context.mutablePaths.join(", ")}\nEvaluation request policy: ${JSON.stringify(context.evaluationRequests)}\n\nReturn exactly one <research_brief> JSON block with: {"plan":{"hypothesis":"...","changeCategory":"${CHANGE_CATEGORIES.join("|")}","expectedEffect":"...","falsificationCriterion":"...","notes":[],"lessonsUsed":[],"contradictedLessons":[],"lessonTests":[],"questionsAddressed":[],"followUpHypotheses":[]},"implementationInstructions":["concrete steps"],"acceptanceChecks":["specific checks"]}. The plan may include bounded expectedGain/probabilityOfSuccess/informationGain/estimatedCost, resourceRequest, methodTests and a permitted evaluationRequest. Do not invent post-edit analysisEvidence or measured improvements.`,
    (text) => parseDirectorBrief(text, context));
  }

  async review(_context: ResearchContext, brief: ResearchBrief, proposal: ResearchProposal, changedPaths: string[]): Promise<ProposalReview> {
    return this.phase("proposal_review", `Review implementation against the immutable scientific brief. Read current files and independently run cheap scratch checks if useful. Request concrete corrections when needed; do not redesign the hypothesis inside a repair attempt.\n\nBrief: ${JSON.stringify(brief)}\nWorker report: ${JSON.stringify(proposal)}\nChanged paths: ${changedPaths.join(", ") || "none"}\n\nReturn exactly <proposal_review>{"approved":true,"summary":"...","concerns":[]}</proposal_review>. Approve only if implementation and final validation support the brief. Worker-reported metrics are not trusted evaluator results.`, (text) => {
      const raw = tagged(text, "proposal_review");
      if (typeof raw.approved !== "boolean") throw new Error("review.approved must be boolean");
      requiredText(raw.summary, "review.summary");
      if (!Array.isArray(raw.concerns)) throw new Error("review.concerns must be an array");
      return parseProposalReview(text);
    });
  }

  async reflect(context: ResearchContext, brief: ResearchBrief | undefined, outcome: ResearchOutcome): Promise<ResearchConclusion> {
    return this.phase("reflection", `Interpret the trusted evaluator outcome and decide the most informative next hypotheses. You, not the implementer, own the scientific conclusion. Do not edit candidate files or override the harness decision. A failed/skipped measurement is not evidence of improvement.\n\nInstructions: ${context.researchInstructions}\nBrief: ${JSON.stringify(brief ?? null)}\nKnown memory: ${JSON.stringify(context.memory)}\nMethods: ${JSON.stringify(context.methods ?? [])}\nOutcome: ${JSON.stringify(outcome, (key, value: unknown) =>
      key.toLowerCase().includes("path") || key.endsWith("Dir")
        ? (typeof value === "string" && path.isAbsolute(value) ? path.relative(this.experimentDir, value) : value)
        : value)}\n\nUse only preregistered lessonTests/methodTests/questionsAddressed for existing evidence updates. Separate facts, hypotheses and uncertainty. Return exactly one <experiment_conclusion> block with {"summary":"...","notes":[],"lessonUpdates":[],"methodUpdates":[],"questionUpdates":[],"nextHypotheses":["specific next test"]}. Optional update record shapes: lessonUpdates={lessonId?:known-id,claim,relation:new|supports|contradicts|retire,guidance:consider|avoid|verify,confidence:0..1,evidenceKind:direct|replication|contextual,evidenceRationale}; methodUpdates={methodId?:known-id,kind:prompt-note|analysis-recipe|context-selector|role-spec|screening-policy,content,relation:new|supports|contradicts|retire,rationale}; questionUpdates={questionId:known-id,status:resolved|invalidated,resolution}. Do not invent existing IDs.`, (text) => {
      const raw = tagged(text, "experiment_conclusion");
      requiredText(raw.summary, "conclusion.summary");
      for (const key of ["notes", "lessonUpdates", "methodUpdates", "questionUpdates", "nextHypotheses"]) {
        if (!Array.isArray(raw[key])) throw new Error(`conclusion.${key} must be an array`);
      }
      return parseResearchConclusion(text);
    });
  }

  getUsage(): AgentUsage { return this.chat?.getUsage() ?? emptyAgentUsage(); }

  dispose(): void { this.chat?.dispose(); this.chat = undefined; }
}
