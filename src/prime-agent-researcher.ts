import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentProfileConfig,
  AgentUsage,
  HarnessConfig,
  ProposalReview,
  ResearchConclusion,
  ResearchContext,
  ResearchOutcome,
  ResearchProposal,
  Researcher,
} from "./types.js";
import { AgentTranscriptRecorder } from "./agent-transcript.js";
import { addAgentUsage, emptyAgentUsage } from "./experiment-accounting.js";
import { ensureDir, EventLog } from "./io.js";
import { buildPrompt, parseExperimentPlan, parseProposalReview, parseResearchConclusion } from "./pi-researcher.js";
import type { PersistentResearchLab } from "./research-lab.js";
import { killSubprocessTree, trackSubprocess } from "./subprocess-registry.js";
import { copyWorkspace, diffSnapshots, isPathMatched, snapshotWorkspace } from "./workspace.js";

interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type RpcEventHandler = (event: Record<string, unknown>) => void;

function inheritedEnvironment(config: HarnessConfig["agent"]["backend"]): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(config.inheritEnv
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...config.env,
    PRIME_AGENT_TELEMETRY: config.telemetry?.enabled ? "1" : "0",
  };
}

function safeJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value: String(value) };
  return value as Record<string, unknown>;
}

export class PrimeAgentRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private eventHandlers = new Set<RpcEventHandler>();
  private turnWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(
    private readonly config: HarnessConfig["agent"]["backend"],
    private readonly workspacePath: string,
    private readonly sessionPath: string,
    private readonly stderrPath: string,
    private readonly profile?: AgentProfileConfig,
    private readonly labPath?: string,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    await ensureDir(this.sessionPath);
    await ensureDir(path.dirname(this.stderrPath));
    const backend = this.config;
    const env = inheritedEnvironment(backend);
    if (this.labPath) env.AUTORESEARCH_LAB_DIR = backend.runner.mode === "docker" ? "/research-lab" : this.labPath;
    const model = this.profile?.model;
    const thinkingLevel = this.profile?.thinkingLevel;
    const agentArgs = [
      ...backend.command,
      "--mode", "rpc",
      "--session-dir", backend.runner.mode === "docker" ? "/session" : this.sessionPath,
      ...(model ? ["--model", `${model}${thinkingLevel ? `:${thinkingLevel}` : ""}`] : []),
    ];
    let command = agentArgs[0]!;
    let args = agentArgs.slice(1);
    let cwd = this.workspacePath;
    let childEnv = env;
    if (backend.runner.mode === "docker") {
      const dockerArgs = [
        "run", "--rm", "-i", "--init",
        "--network", backend.runner.network,
        "--pids-limit", String(backend.runner.pidsLimit),
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--mount", `type=bind,src=${path.resolve(this.workspacePath)},dst=/workspace`,
        "--mount", `type=bind,src=${path.resolve(this.sessionPath)},dst=/session`,
        "--workdir", "/workspace",
      ];
      if (this.labPath) dockerArgs.push("--mount", `type=bind,src=${path.resolve(this.labPath)},dst=/research-lab`);
      if (backend.runner.readOnlyRoot) dockerArgs.push("--read-only", "--tmpfs", "/tmp:rw,nosuid,size=2g");
      if (backend.runner.cpus !== undefined) dockerArgs.push("--cpus", String(backend.runner.cpus));
      if (backend.runner.memory) dockerArgs.push("--memory", backend.runner.memory);
      if (backend.runner.gpus) dockerArgs.push("--gpus", backend.runner.gpus);
      for (const [key, value] of Object.entries(env)) if (value !== undefined) dockerArgs.push("--env", `${key}=${value}`);
      dockerArgs.push(backend.runner.image!, ...agentArgs);
      command = "docker";
      args = dockerArgs;
      cwd = this.workspacePath;
      childEnv = { PATH: process.env.PATH };
    }
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env: childEnv, detached, stdio: ["pipe", "pipe", "pipe"] });
    trackSubprocess(child, detached);
    this.child = child;
    const stderr = createWriteStream(this.stderrPath, { flags: "a" });
    child.stderr.pipe(stderr);
    this.decoder = new StringDecoder("utf8");
    this.lineBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(this.decoder.write(chunk)));
    child.stdout.on("end", () => {
      this.consumeStdout(this.decoder.end());
      if (this.lineBuffer) {
        this.handleLine(this.lineBuffer.endsWith("\r") ? this.lineBuffer.slice(0, -1) : this.lineBuffer);
        this.lineBuffer = "";
      }
    });
    child.once("error", (error) => this.failAll(error));
    child.once("close", (code, signal) => {
      stderr.end();
      this.failAll(new Error(`Prime Agent RPC exited with code=${code ?? "null"} signal=${signal ?? "null"}`));
      this.child = undefined;
      this.lineBuffer = "";
    });
  }

  private consumeStdout(chunk: string): void {
    this.lineBuffer += chunk;
    if (Buffer.byteLength(this.lineBuffer) > 16 * 1024 * 1024) {
      const error = new Error("Prime Agent RPC record exceeded 16 MiB");
      this.failAll(error);
      if (this.child) void killSubprocessTree(this.child, process.platform !== "win32", "SIGKILL");
      return;
    }
    while (true) {
      const index = this.lineBuffer.indexOf("\n");
      if (index === -1) break;
      let line = this.lineBuffer.slice(0, index);
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) this.handleLine(line);
    }
  }

  onEvent(handler: RpcEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      for (const handler of this.eventHandlers) handler({ type: "protocol_error", line });
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        const response = message as unknown as RpcResponse;
        if (response.success) pending.resolve(response);
        else pending.reject(new Error(response.error ?? `Prime Agent RPC command ${response.command} failed`));
      }
      return;
    }
    for (const handler of this.eventHandlers) handler(message);
    if (message.type === "agent_end") {
      const waiters = this.turnWaiters.splice(0);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async request(type: string, fields: Record<string, unknown> = {}): Promise<RpcResponse> {
    await this.start();
    const id = `rpc-${++this.sequence}`;
    return await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Prime Agent RPC command ${type} timed out`));
      }, Math.min(this.config.timeoutSeconds, 60) * 1_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  async prompt(message: string): Promise<string> {
    let waiterRef: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters = this.turnWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Prime Agent turn timed out after ${this.config.timeoutSeconds}s`));
      }, this.config.timeoutSeconds * 1_000);
      timer.unref();
      waiterRef = { resolve, reject, timer };
      this.turnWaiters.push(waiterRef);
    });
    try {
      await this.request("prompt", { message });
      await completed;
    } catch (error) {
      const index = this.turnWaiters.indexOf(waiterRef!);
      if (index !== -1) this.turnWaiters.splice(index, 1);
      clearTimeout(waiterRef!.timer);
      throw error;
    }
    const response = await this.request("get_last_assistant_text");
    const data = safeJson(response.data);
    return typeof data.text === "string" ? data.text : "";
  }

  async usage(): Promise<AgentUsage> {
    const response = await this.request("get_session_stats");
    const data = safeJson(response.data);
    const tokens = safeJson(data.tokens);
    return {
      requests: typeof data.assistantMessages === "number" ? data.assistantMessages : 0,
      inputTokens: typeof tokens.input === "number" ? tokens.input : 0,
      outputTokens: typeof tokens.output === "number" ? tokens.output : 0,
      cacheReadTokens: typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0,
      cacheWriteTokens: typeof tokens.cacheWrite === "number" ? tokens.cacheWrite : 0,
      totalTokens: typeof tokens.total === "number" ? tokens.total : 0,
      costUsd: typeof data.cost === "number" ? data.cost : 0,
    };
  }

  async dispose(): Promise<void> {
    if (this.child) {
      this.child.stdin.end();
      killSubprocessTree(this.child, process.platform !== "win32", "SIGTERM");
    }
    this.child = undefined;
    this.lineBuffer = "";
  }
}

async function syncAllowedChanges(
  sourceMirror: string,
  candidateWorkspace: string,
  changedPaths: string[],
  mutablePaths: string[],
  protectedPaths: string[],
): Promise<void> {
  const forbidden = changedPaths.filter((changedPath) =>
    !isPathMatched(changedPath, mutablePaths) || isPathMatched(changedPath, protectedPaths));
  if (forbidden.length) throw new Error(`Prime Agent changed forbidden paths in its isolated mirror: ${forbidden.join(", ")}`);
  for (const relativePath of changedPaths) {
    const source = path.join(sourceMirror, relativePath);
    const target = path.join(candidateWorkspace, relativePath);
    const details = await lstat(source).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!details) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    if (details.isSymbolicLink()) throw new Error(`Prime Agent produced a symlink in mutable path: ${relativePath}`);
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: details.isDirectory(), errorOnExist: true, force: false });
  }
}

export class PrimeAgentResearcher implements Researcher {
  readonly capabilities = Object.freeze({
    persistentSession: true,
    subagents: true,
    steer: true,
    followUp: true,
    compaction: true,
    resumable: true,
  });
  private client: PrimeAgentRpcClient | undefined;
  private reviewerClient: PrimeAgentRpcClient | undefined;
  private mirrorPath: string;
  private usageValue: AgentUsage = emptyAgentUsage();
  private reviewerUsage: AgentUsage = emptyAgentUsage();
  private transcript: AgentTranscriptRecorder;
  private reviewerTranscript: AgentTranscriptRecorder;
  private rawEvents: EventLog;

  constructor(
    private readonly config: HarnessConfig,
    private readonly workspacePath: string,
    private readonly experimentDir: string,
    private readonly profile?: AgentProfileConfig,
    private readonly researchLab?: PersistentResearchLab,
  ) {
    this.mirrorPath = path.join(experimentDir, "prime-agent", "workspace");
    this.transcript = new AgentTranscriptRecorder(path.join(experimentDir, "agent-transcript.jsonl"), "implementer");
    this.reviewerTranscript = new AgentTranscriptRecorder(path.join(experimentDir, "agent-transcript.jsonl"), "reviewer");
    this.rawEvents = new EventLog(path.join(experimentDir, "prime-agent-events.jsonl"));
  }

  private async prepareClient(): Promise<PrimeAgentRpcClient> {
    if (this.client) return this.client;
    await ensureDir(path.dirname(this.mirrorPath));
    await rm(this.mirrorPath, { recursive: true, force: true });
    await copyWorkspace(this.workspacePath, this.mirrorPath, this.config.project.hiddenPaths);
    const client = new PrimeAgentRpcClient(
      this.config.agent.backend,
      this.mirrorPath,
      path.join(this.experimentDir, "prime-agent", "session"),
      path.join(this.experimentDir, "prime-agent", "stderr.log"),
      this.profile,
      this.researchLab?.rootPath,
    );
    client.onEvent((event) => {
      this.rawEvents.append("prime_agent_event", { event });
      this.transcript.record(event as never, "proposal");
    });
    await client.start();
    this.client = client;
    return client;
  }

  async propose(context: ResearchContext): Promise<ResearchProposal> {
    const before = await snapshotWorkspace(this.workspacePath);
    const client = await this.prepareClient();
    this.transcript.status("proposal", "Prime Agent RPC session configured", {
      backend: this.config.agent.backend.type,
      model: this.profile?.model ?? this.config.agent.model ?? null,
      thinkingLevel: this.profile?.thinkingLevel ?? this.config.agent.thinkingLevel,
      mirrorPath: this.mirrorPath,
    });
    const mirrorBefore = await snapshotWorkspace(this.mirrorPath);
    const adaptiveRoles = this.config.agent.orchestration?.mode === "adaptive"
      ? Object.keys(this.config.agent.roles ?? {}).filter((role) => !["implementer", "reviewer"].includes(role))
      : [];
    const narrative = await client.prompt([
      this.profile?.systemPrompt ?? this.config.agent.roles?.implementer?.systemPrompt ?? this.config.agent.systemPrompt ?? "",
      "You are running in an isolated agent-visible mirror. Hidden evaluator assets are absent. Change only configured mutable paths. The harness will reject every other mirror change and will independently run evaluation after the session.",
      ...(this.researchLab ? [`A durable run-scoped research lab is mounted at ${this.config.agent.backend.runner.mode === "docker" ? "/research-lab" : this.researchLab.rootPath}. It is separate from the candidate and never contains hidden evaluator assets.`] : []),
      ...(adaptiveRoles.length ? [`Adaptive specialist roles are available: ${adaptiveRoles.join(", ")}. Use at most ${this.config.agent.orchestration?.maxAdvisors ?? 1} native read-only subagents only when the current evidence calls for their specialty, then synthesize their advice before editing.`] : []),
      buildPrompt(context),
    ].filter(Boolean).join("\n\n"));
    const mirrorAfter = await snapshotWorkspace(this.mirrorPath);
    const changed = diffSnapshots(mirrorBefore, mirrorAfter);
    await syncAllowedChanges(
      this.mirrorPath,
      this.workspacePath,
      changed,
      this.config.project.mutablePaths,
      this.config.project.protectedPaths,
    );
    const after = await snapshotWorkspace(this.workspacePath);
    const syncedChanges = diffSnapshots(before, after);
    this.rawEvents.append("prime_agent_changes_synced", { mirrorChanges: changed, candidateChanges: syncedChanges });
    this.usageValue = await client.usage();
    const finalNarrative = narrative.trim() || "Prime Agent completed without a textual experiment record.";
    const plan = parseExperimentPlan(finalNarrative);
    return {
      narrative: finalNarrative,
      ...(plan ? { plan } : {}),
      agent: {
        ...(this.profile?.model ?? this.config.agent.model ? { model: this.profile?.model ?? this.config.agent.model } : {}),
        thinkingLevel: this.profile?.thinkingLevel ?? this.config.agent.thinkingLevel,
        ...(this.profile?.id ? { profileId: this.profile.id } : {}),
      },
    };
  }

  async review(_context: ResearchContext, proposal: ResearchProposal, changedPaths: string[]): Promise<ProposalReview> {
    const reviewer = this.config.agent.roles?.reviewer;
    if (!reviewer) return { approved: true, summary: "No independent reviewer role is configured", concerns: [] };
    const client = new PrimeAgentRpcClient(
      this.config.agent.backend,
      this.mirrorPath,
      path.join(this.experimentDir, "prime-agent", "reviewer-session"),
      path.join(this.experimentDir, "prime-agent", "reviewer-stderr.log"),
      reviewer,
      this.researchLab?.rootPath,
    );
    client.onEvent((event) => {
      this.rawEvents.append("prime_agent_reviewer_event", { event });
      this.reviewerTranscript.record(event as never, "proposal_review");
    });
    await client.start();
    this.reviewerClient = client;
    const before = await snapshotWorkspace(this.mirrorPath);
    const narrative = await client.prompt(`Independently review this completed candidate. Do not edit files. Changed paths: ${changedPaths.join(", ") || "none"}. Proposal: ${proposal.narrative}\n\nFinish with exactly <proposal_review>{"approved":true,"summary":"short verdict","concerns":[]}</proposal_review>.`);
    const after = await snapshotWorkspace(this.mirrorPath);
    const changes = diffSnapshots(before, after);
    if (changes.length) throw new Error(`Prime Agent modified its mirror during read-only review: ${changes.join(", ")}`);
    this.reviewerUsage = await client.usage();
    return parseProposalReview(narrative);
  }

  async reflect(outcome: ResearchOutcome): Promise<ResearchConclusion> {
    const client = await this.prepareClient();
    const before = await snapshotWorkspace(this.mirrorPath);
    const narrative = await client.prompt(`# Experiment outcome: ${outcome.experimentId}\n\nCandidate evaluation: ${JSON.stringify(outcome.evaluation)}\nPaired evaluation: ${JSON.stringify(outcome.pairedEvaluation ?? null)}\nParameter sweep: ${JSON.stringify(outcome.parameterSweep ?? null)}\nHarness decision: ${JSON.stringify(outcome.decision)}\n\nDo not edit files and do not override the harness decision. Explain the evidence and finish with exactly one <experiment_conclusion> JSON block using the established schema.`);
    const after = await snapshotWorkspace(this.mirrorPath);
    const changes = diffSnapshots(before, after);
    if (changes.length) throw new Error(`Prime Agent modified its mirror during reflection: ${changes.join(", ")}`);
    this.usageValue = await client.usage();
    return parseResearchConclusion(narrative);
  }

  getUsage(): AgentUsage {
    return addAgentUsage(this.usageValue, this.reviewerUsage);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.client?.dispose(), this.reviewerClient?.dispose()]);
    this.client = undefined;
    this.reviewerClient = undefined;
  }
}
