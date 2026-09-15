import path from "node:path";
import { writeFile } from "node:fs/promises";
import { ensureDir, EventLog, writeJsonAtomic } from "./io.js";
import { addAgentUsage, emptyAgentUsage } from "./experiment-accounting.js";
import { diffSnapshots, isPathMatched, snapshotWorkspace } from "./workspace.js";
import { RecoverableResearcherError } from "./research-errors.js";
import type {
  AgentUsage, HarnessConfig, ProposalReview, ResearchBrief, ResearchConclusion,
  ResearchContext, Researcher, ResearchOutcome, ResearchProposal,
} from "./types.js";

export interface ResearchDirector {
  plan(context: ResearchContext): Promise<ResearchBrief>;
  review(context: ResearchContext, brief: ResearchBrief, proposal: ResearchProposal, changedPaths: string[]): Promise<ProposalReview>;
  reflect(context: ResearchContext, brief: ResearchBrief | undefined, outcome: ResearchOutcome): Promise<ResearchConclusion>;
  getUsage(): AgentUsage;
  dispose(): void | Promise<void>;
}

/** Coordinator owns control flow; models cannot grant themselves evaluation. */
export class DirectedResearcher implements Researcher {
  readonly capabilities = Object.freeze({ persistentSession: true, subagents: true,
    steer: false, followUp: false, compaction: true, resumable: false });
  private context: ResearchContext | undefined;
  private brief: ResearchBrief | undefined;
  private workerUsage = emptyAgentUsage();
  private readonly events: EventLog;

  constructor(
    private readonly config: HarnessConfig,
    private readonly workspacePath: string,
    private readonly experimentDir: string,
    private readonly director: ResearchDirector,
    private readonly createWorker: (attempt: number, attemptDir: string) => Promise<Researcher>,
  ) {
    this.events = new EventLog(path.join(experimentDir, "directed-events.jsonl"));
  }

  private async readOnly<T>(phase: string, action: () => Promise<T>): Promise<T> {
    const before = await snapshotWorkspace(this.workspacePath);
    try {
      return await action();
    } finally {
      const changed = diffSnapshots(before, await snapshotWorkspace(this.workspacePath));
      if (changed.length) {
        this.events.append("director_mutation_rejected", { phase, changedPaths: changed });
        throw new RecoverableResearcherError(`Director ${phase} mutated the workspace: ${changed.join(", ")}`, "director_mutation");
      }
    }
  }

  async propose(context: ResearchContext): Promise<ResearchProposal> {
    await ensureDir(this.experimentDir);
    this.context = structuredClone(context);
    const initial = await snapshotWorkspace(this.workspacePath);
    this.events.append("director_planning_started", { experimentId: context.experimentId });
    this.brief = structuredClone(await this.readOnly("planning", () => this.director.plan(structuredClone(context))));
    await writeJsonAtomic(path.join(this.experimentDir, "research-brief.json"), this.brief);
    this.events.append("director_plan_completed", { hypothesis: this.brief.plan.hypothesis });
    const maxRevisions = this.config.agent.orchestration?.maxRevisions ?? 2;
    let feedback: ProposalReview | undefined;

    for (let attempt = 0; attempt <= maxRevisions; attempt += 1) {
      const attemptDir = path.join(this.experimentDir, "implementation-attempts", `attempt-${attempt}`);
      await ensureDir(attemptDir);
      const workerContext: ResearchContext = {
        ...structuredClone(context),
        agentRole: "implementer",
        assignment: { ...structuredClone(context.assignment), plannedHypothesis: this.brief.plan.hypothesis },
        researchBrief: structuredClone(this.brief),
        ...(feedback ? { implementationFeedback: structuredClone(feedback) } : {}),
        researchInstructions: `${context.researchInstructions}\n\nThe director's researchBrief is the preregistered scientific contract. Implement its instructions; do not replace its hypothesis, falsification criterion, lesson tests or evaluation design. Your proposal reports implementation details and fresh validation evidence. Review feedback, if present, must be addressed within this same brief.`,
      };
      await writeJsonAtomic(path.join(attemptDir, "handoff.json"), {
        brief: this.brief, feedback: feedback ?? null, attempt,
      });
      this.events.append("implementation_started", { attempt, path: path.relative(this.experimentDir, attemptDir) });
      let proposal: ResearchProposal;
      let implementationError: string | undefined;
      const worker = await this.createWorker(attempt, attemptDir);
      try {
        proposal = await worker.propose(workerContext);
        if (!proposal.plan) throw new RecoverableResearcherError("Implementation did not return a structured proposal", "missing_worker_plan");
      } catch (error) {
        if (!(error instanceof RecoverableResearcherError)) throw error;
        implementationError = error.message;
        proposal = { narrative: `Implementation failed: ${error.message}`, plan: structuredClone(this.brief.plan) };
      } finally {
        try {
          const usage = worker.getUsage?.() ?? emptyAgentUsage();
          this.workerUsage = addAgentUsage(this.workerUsage, usage);
          await writeJsonAtomic(path.join(attemptDir, "usage.json"), usage);
        } finally {
          await worker.dispose?.();
        }
      }
      const changedPaths = diffSnapshots(initial, await snapshotWorkspace(this.workspacePath));
      const forbidden = changedPaths.filter((file) => !isPathMatched(file, this.config.project.mutablePaths)
        || isPathMatched(file, [...this.config.project.protectedPaths, ...(this.config.project.hiddenPaths ?? [])])
        || file === ".autoresearch-ensemble" || file.startsWith(".autoresearch-ensemble/"));
      if (forbidden.length) throw new RecoverableResearcherError(`Implementation changed forbidden paths: ${forbidden.join(", ")}`, "worker_forbidden_mutation");
      if (context.assignment.strategy === "replicate" && changedPaths.length) {
        throw new RecoverableResearcherError("Replication changed the workspace", "worker_replication_mutation");
      }
      await writeJsonAtomic(path.join(attemptDir, "proposal.json"), proposal);
      this.events.append("director_review_started", { attempt, changedPaths, implementationError: implementationError ?? null });
      const review = await this.readOnly("review", () => this.director.review(
        structuredClone(context), structuredClone(this.brief!), structuredClone(proposal), changedPaths,
      ));
      feedback = implementationError
        ? { approved: false, summary: "Implementation validation failed", concerns: [implementationError, review.summary, ...review.concerns] }
        : review;
      await writeJsonAtomic(path.join(attemptDir, "director-review.json"), feedback);
      this.events.append("director_review_completed", { attempt, review: feedback });
      if (!feedback.approved) continue;

      // Only the director owns scientific/preregistration fields. Preserve the
      // worker report separately and attach only its actual validation evidence.
      const plan = {
        ...structuredClone(this.brief.plan),
        notes: [...this.brief.plan.notes, ...(proposal.plan?.notes ?? [])],
        ...(proposal.plan?.analysisEvidence ? { analysisEvidence: proposal.plan.analysisEvidence } : {}),
      };
      const narrative = `# Director-approved experiment\n\n${plan.hypothesis}\n\nImplementation report: implementation-attempts/attempt-${attempt}/proposal.json\n\n<experiment_proposal>\n${JSON.stringify(plan)}\n</experiment_proposal>`;
      await writeFile(path.join(this.experimentDir, "director-approved-proposal.md"), `${narrative}\n`, "utf8");
      await writeJsonAtomic(path.join(this.experimentDir, "proposal-review.json"), feedback);
      return { narrative, plan, review: feedback, ...(proposal.agent ? { agent: proposal.agent } : {}) };
    }
    // Return a rejected, structured proposal so the harness skips measurement
    // and still asks the director to record conclusions and next hypotheses.
    const review: ProposalReview = { approved: false,
      summary: `Director did not approve implementation after ${maxRevisions + 1} attempt(s): ${feedback?.summary ?? "no review"}`,
      concerns: feedback?.concerns ?? [] };
    await writeJsonAtomic(path.join(this.experimentDir, "proposal-review.json"), review);
    return { narrative: `${review.summary}\n\n<experiment_proposal>\n${JSON.stringify(this.brief.plan)}\n</experiment_proposal>`,
      plan: structuredClone(this.brief.plan), review };
  }

  async reflect(outcome: ResearchOutcome): Promise<ResearchConclusion> {
    if (!this.context) throw new Error("Director reflection requires experiment context");
    this.events.append("director_reflection_started", { experimentId: outcome.experimentId, decision: outcome.decision.status });
    const conclusion = await this.readOnly("reflection", () => this.director.reflect(
      structuredClone(this.context!), this.brief ? structuredClone(this.brief) : undefined, structuredClone(outcome),
    ));
    this.events.append("director_reflection_completed", { summary: conclusion.summary });
    return conclusion;
  }

  getUsage(): AgentUsage {
    return addAgentUsage(this.workerUsage, this.director.getUsage());
  }

  async dispose(): Promise<void> {
    await this.director.dispose();
  }
}
