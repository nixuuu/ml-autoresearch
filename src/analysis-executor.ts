import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentAnalysisConfig } from "./types.js";
import type { ResolvedRuntimeEnvironment } from "./dependency-broker.js";
import { EventLog, ensureDir } from "./io.js";
import { copyWorkspace, fingerprintSnapshot, isPathMatched, listWorkspaceFiles, resolveSafeWorkspacePath } from "./workspace.js";
import { killSubprocessTree, trackSubprocess } from "./subprocess-registry.js";

export interface AnalysisCommandResult {
  callId: string;
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  stdoutPath: string;
  stderrPath: string;
  evidenceId: string;
  candidateFingerprint: string;
  runtimeFingerprint: string;
}

export interface AnalysisEvidence {
  evidenceId: string;
  callId: string;
  command: string[];
  cwd: string;
  candidateFingerprint: string;
  runtimeFingerprint: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stale: boolean;
  createdAt: string;
}

export interface AnalysisRuntimeInfo {
  runner: "local" | "docker";
  image?: string;
  pythonCommand: string[];
  testCommand?: string[];
  projectPathEntries: string[];
  workspace: string;
  scratch: string;
  environmentFingerprint: string;
  availableDependencies: Record<string, string[]>;
}

export interface AnalysisBudget {
  maxCalls: number;
  usedCalls: number;
  remainingCalls: number;
  finalValidationReserve: number;
  remainingExplorationCalls: number;
  remainingFinalValidationCalls: number;
}

export interface AnalysisJobSnapshot {
  jobId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  preview: string;
  result?: AnalysisCommandResult;
  error?: string;
}

export interface AnalysisRunOptions {
  command: string[];
  cwd?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onOutput?: (preview: string) => void;
}

interface AnalysisJobState extends AnalysisJobSnapshot {
  controller: AbortController;
  promise: Promise<void>;
}

function inheritedEnvironment(policy: AgentAnalysisConfig): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(policy.inheritEnv
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...policy.env,
  };
}

function appendPreview(current: string, chunk: Buffer, limit: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current) >= limit) return { value: current, truncated: true };
  const remaining = limit - Buffer.byteLength(current);
  if (chunk.byteLength <= remaining) return { value: current + chunk.toString("utf8"), truncated: false };
  return { value: current + chunk.subarray(0, remaining).toString("utf8"), truncated: true };
}

/**
 * Persistent, agent-visible analysis mirror. Hidden paths are omitted before
 * the first command. Commands may freely mutate this mirror, but those writes
 * never become candidate changes; durable candidate edits still go through
 * research_write/research_replace and are mirrored explicitly.
 */
export class OpenResearchExecutor {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly scratchPath: string;
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private calls = 0;
  private mutationRevision = 0;
  private cachedCandidateFingerprint: string | undefined;
  private evidenceRecords: AnalysisEvidence[] = [];
  private jobs = new Map<string, AnalysisJobState>();
  private nextJob = 0;

  get callCount(): number {
    return this.calls;
  }

  get candidateMutationRevision(): number {
    return this.mutationRevision;
  }

  constructor(
    private readonly policy: AgentAnalysisConfig,
    private readonly candidateWorkspacePath: string,
    private readonly experimentDir: string,
    private readonly hiddenPaths: string[],
    private readonly resolveRuntimeEnvironment?: () => Promise<ResolvedRuntimeEnvironment | undefined>,
    private readonly publishEvidence?: (evidence: AnalysisEvidence, result: AnalysisCommandResult) => Promise<void>,
    private readonly mutablePaths?: string[],
  ) {
    this.rootPath = path.join(experimentDir, "analysis");
    this.workspacePath = path.join(this.rootPath, "workspace");
    this.scratchPath = path.join(this.workspacePath, ".autoresearch-analysis");
  }

  private runtimePolicy(): Required<Pick<NonNullable<AgentAnalysisConfig["runtime"]>, "pythonCommand" | "projectPathEntries">>
    & Pick<NonNullable<AgentAnalysisConfig["runtime"]>, "testCommand"> {
    return {
      pythonCommand: this.policy.runtime?.pythonCommand ?? ["python3"],
      ...(this.policy.runtime?.testCommand ? { testCommand: this.policy.runtime.testCommand } : {}),
      projectPathEntries: this.policy.runtime?.projectPathEntries ?? ["."],
    };
  }

  private async candidateFingerprint(): Promise<string> {
    if (this.cachedCandidateFingerprint) return this.cachedCandidateFingerprint;
    const snapshot = new Map<string, string>();
    for (const relativePath of await listWorkspaceFiles(this.candidateWorkspacePath)) {
      if (this.mutablePaths && !isPathMatched(relativePath, this.mutablePaths)) continue;
      const absolutePath = path.join(this.candidateWorkspacePath, relativePath);
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) throw new Error(`Cannot fingerprint mutable symlink: ${relativePath}`);
      snapshot.set(relativePath, createHash("sha256").update(await readFile(absolutePath)).digest("hex"));
    }
    this.cachedCandidateFingerprint = fingerprintSnapshot(snapshot);
    return this.cachedCandidateFingerprint;
  }

  async runtimeInfo(): Promise<AnalysisRuntimeInfo> {
    await this.initialize();
    const runtime = await this.resolveRuntimeEnvironment?.();
    const policy = this.runtimePolicy();
    const fingerprint = runtime?.fingerprint ?? createHash("sha256").update(JSON.stringify({
      runner: this.policy.runner.mode,
      image: this.policy.runner.image ?? null,
      pythonCommand: policy.pythonCommand,
      testCommand: policy.testCommand ?? null,
      projectPathEntries: policy.projectPathEntries,
    })).digest("hex");
    return {
      runner: this.policy.runner.mode,
      ...(runtime?.image ?? this.policy.runner.image ? { image: runtime?.image ?? this.policy.runner.image } : {}),
      pythonCommand: [...policy.pythonCommand],
      ...(policy.testCommand ? { testCommand: [...policy.testCommand] } : {}),
      projectPathEntries: [...policy.projectPathEntries],
      workspace: this.policy.runner.mode === "docker" ? "/workspace" : this.workspacePath,
      scratch: this.policy.runner.mode === "docker" ? "/workspace/.autoresearch-analysis" : this.scratchPath,
      environmentFingerprint: fingerprint,
      availableDependencies: Object.fromEntries(Object.entries(runtime?.manifest.resolved ?? {}).map(([manager, packages]) => [
        manager,
        (packages ?? []).map((entry) => `${entry.name}==${entry.version}`),
      ])),
    };
  }

  evidence(): AnalysisEvidence[] {
    return this.evidenceRecords.map((entry) => ({ ...entry, command: [...entry.command] }));
  }

  budget(): AnalysisBudget {
    const finalValidationReserve = Math.min(this.policy.finalValidationReserve ?? 0, this.policy.maxCalls);
    const remainingCalls = Math.max(0, this.policy.maxCalls - this.calls);
    return {
      maxCalls: this.policy.maxCalls,
      usedCalls: this.calls,
      remainingCalls,
      finalValidationReserve,
      remainingExplorationCalls: Math.max(0, this.policy.maxCalls - finalValidationReserve - this.calls),
      remainingFinalValidationCalls: Math.min(finalValidationReserve, remainingCalls),
    };
  }

  freshSuccessfulEvidenceIds(): string[] {
    return this.evidenceRecords.filter((entry) => !entry.stale && entry.exitCode === 0 && !entry.timedOut && !entry.aborted).map((entry) => entry.evidenceId);
  }

  get candidateWasMutated(): boolean {
    return this.mutationRevision > 0;
  }

  get hasRunningJobs(): boolean {
    return [...this.jobs.values()].some((job) => job.status === "running");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = (async () => {
        await ensureDir(this.rootPath);
        await copyWorkspace(this.candidateWorkspacePath, this.workspacePath, this.hiddenPaths);
        await ensureDir(this.scratchPath);
        this.initialized = true;
      })();
    }
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  async readAnalysisText(relativePath: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    await this.initialize();
    const resolved = await resolveSafeWorkspacePath(this.workspacePath, relativePath);
    const content = await readFile(resolved.absolutePath);
    if (content.byteLength > maxBytes) throw new Error(`Analysis file is larger than ${maxBytes} bytes`);
    return content.toString("utf8");
  }

  async syncCandidateFile(relativePath: string): Promise<void> {
    this.mutationRevision += 1;
    this.cachedCandidateFingerprint = undefined;
    for (const evidence of this.evidenceRecords) evidence.stale = true;
    await ensureDir(this.rootPath);
    new EventLog(path.join(this.rootPath, "commands.jsonl")).append("analysis_evidence_invalidated", {
      relativePath,
      mutationRevision: this.mutationRevision,
      evidenceIds: this.evidenceRecords.map((entry) => entry.evidenceId),
    });
    if (!this.initialized) return;
    const source = await resolveSafeWorkspacePath(this.candidateWorkspacePath, relativePath);
    let target: Awaited<ReturnType<typeof resolveSafeWorkspacePath>>;
    try {
      target = await resolveSafeWorkspacePath(this.workspacePath, relativePath, { allowMissing: true });
    } catch {
      // An analysis command may have replaced a candidate path or one of its
      // parents with a symlink. Rebuild the disposable mirror rather than
      // following it or leaving the durable candidate out of sync.
      await rm(this.workspacePath, { recursive: true, force: true });
      this.initialized = false;
      this.initialization = undefined;
      await this.initialize();
      return;
    }
    const details = await lstat(source.absolutePath);
    if (details.isSymbolicLink()) throw new Error(`Cannot mirror symlink into analysis workspace: ${relativePath}`);
    await ensureDir(path.dirname(target.absolutePath));
    await rm(target.absolutePath, { recursive: true, force: true });
    await cp(source.absolutePath, target.absolutePath, { recursive: details.isDirectory(), force: false, errorOnExist: true });
  }

  invalidateRuntimeEvidence(reason: string): void {
    for (const evidence of this.evidenceRecords) evidence.stale = true;
    new EventLog(path.join(this.rootPath, "commands.jsonl")).append("analysis_runtime_evidence_invalidated", {
      reason,
      evidenceIds: this.evidenceRecords.map((entry) => entry.evidenceId),
    });
  }

  private assertExplorationBudget(): void {
    const budget = this.budget();
    if (budget.remainingExplorationCalls > 0) return;
    const reserved = budget.remainingFinalValidationCalls > 0
      ? `; ${budget.remainingFinalValidationCalls} call(s) are reserved for harness-run final candidate validation`
      : "";
    throw new Error(`Open-research exploration command limit reached (${budget.usedCalls}/${budget.maxCalls})${reserved}`);
  }

  async run(options: AnalysisRunOptions): Promise<AnalysisCommandResult> {
    await this.initialize();
    this.assertExplorationBudget();
    return this.execute(options);
  }

  async runFinalValidation(options: AnalysisRunOptions): Promise<AnalysisCommandResult> {
    await this.initialize();
    const budget = this.budget();
    if (budget.remainingCalls <= 0) {
      throw new Error(`Final candidate validation budget exhausted (${budget.usedCalls}/${budget.maxCalls})`);
    }
    return this.execute(options);
  }

  private async execute(options: AnalysisRunOptions): Promise<AnalysisCommandResult> {
    if (options.command.length === 0 || options.command.some((part) => !part || part.includes("\0"))) {
      throw new Error("Analysis command must contain non-empty arguments without NUL bytes");
    }
    this.calls += 1;
    const mutationRevision = this.mutationRevision;
    const callId = `call-${String(this.calls).padStart(3, "0")}`;
    const evidenceId = `evidence-${String(this.calls).padStart(4, "0")}`;
    const candidateFingerprint = await this.candidateFingerprint();
    const runtimeInfo = await this.runtimeInfo();
    const callDir = path.join(this.rootPath, "calls", callId);
    await ensureDir(callDir);
    const requestedCwd = options.cwd ?? ".";
    const resolvedCwd = requestedCwd === "."
      ? { absolutePath: this.workspacePath, relativePath: "." }
      : await resolveSafeWorkspacePath(this.workspacePath, requestedCwd);
    const timeoutSeconds = Math.min(options.timeoutSeconds ?? this.policy.timeoutSeconds, this.policy.timeoutSeconds);
    const stdoutPath = path.join(callDir, "stdout.log");
    const stderrPath = path.join(callDir, "stderr.log");
    const stdoutFile = createWriteStream(stdoutPath, { flags: "wx" });
    const stderrFile = createWriteStream(stderrPath, { flags: "wx" });
    const streamsClosed = Promise.all([
      new Promise<void>((resolve, reject) => { stdoutFile.once("close", resolve); stdoutFile.once("error", reject); }),
      new Promise<void>((resolve, reject) => { stderrFile.once("close", resolve); stderrFile.once("error", reject); }),
    ]);
    const specialEnv = {
      AUTORESEARCH_OPEN_RESEARCH: "1",
      AUTORESEARCH_ANALYSIS_DIR: this.policy.runner.mode === "docker" ? "/workspace/.autoresearch-analysis" : this.scratchPath,
    };
    const runtimePolicy = this.runtimePolicy();
    const localProjectPaths = runtimePolicy.projectPathEntries.map((entry) => path.resolve(this.workspacePath, entry));
    const inherited = inheritedEnvironment(this.policy);
    const hostEnv: NodeJS.ProcessEnv = {
      ...inherited,
      ...specialEnv,
      PYTHONPATH: [...localProjectPaths, inherited.PYTHONPATH].filter(Boolean).join(path.delimiter),
    };
    let command = options.command[0]!;
    let args = options.command.slice(1);
    let cwd = resolvedCwd.absolutePath;
    let env = hostEnv;

    if (this.policy.runner.mode === "docker") {
      const runtimeEnvironment = await this.resolveRuntimeEnvironment?.();
      const containerEnv: NodeJS.ProcessEnv = { ...hostEnv };
      for (const hostSpecific of ["PATH", "HOME", "TMPDIR", "VIRTUAL_ENV"]) delete containerEnv[hostSpecific];
      containerEnv.HOME = "/tmp";
      containerEnv.TMPDIR = "/tmp";
      const projectPaths = runtimePolicy.projectPathEntries.map((entry) => entry === "." ? "/workspace" : `/workspace/${entry.replace(/^\.\//u, "")}`);
      containerEnv.PYTHONPATH = [
        ...(runtimeEnvironment?.pythonPath ? ["/autoresearch-deps/python"] : []),
        ...projectPaths,
        containerEnv.PYTHONPATH,
      ].filter(Boolean).join(":");
      if (runtimeEnvironment?.bunNodeModulesPath) containerEnv.NODE_PATH = `/workspace/node_modules${containerEnv.NODE_PATH ? `:${containerEnv.NODE_PATH}` : ""}`;
      const dockerArgs = [
        "run", "--rm", "--init",
        "--network", this.policy.runner.network,
        "--pids-limit", String(this.policy.runner.pidsLimit),
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--mount", `type=bind,src=${path.resolve(this.workspacePath)},dst=/workspace`,
        "--workdir", requestedCwd === "." ? "/workspace" : `/workspace/${resolvedCwd.relativePath}`,
      ];
      if (runtimeEnvironment?.pythonPath) {
        dockerArgs.push("--mount", `type=bind,src=${path.resolve(runtimeEnvironment.pythonPath)},dst=/autoresearch-deps/python,readonly`);
      }
      if (runtimeEnvironment?.bunNodeModulesPath) {
        dockerArgs.push("--mount", `type=bind,src=${path.resolve(runtimeEnvironment.bunNodeModulesPath)},dst=/workspace/node_modules,readonly`);
      }
      if (this.policy.runner.readOnlyRoot) dockerArgs.push("--read-only", "--tmpfs", "/tmp:rw,nosuid,size=2g");
      const cpus = runtimeEnvironment?.cpus ?? this.policy.runner.cpus;
      const memory = runtimeEnvironment?.memory ?? this.policy.runner.memory;
      const gpus = runtimeEnvironment?.gpus ?? this.policy.runner.gpus;
      if (cpus !== undefined) dockerArgs.push("--cpus", String(cpus));
      if (memory) dockerArgs.push("--memory", memory);
      if (gpus) dockerArgs.push("--gpus", gpus);
      for (const [key, value] of Object.entries(containerEnv)) if (value !== undefined) dockerArgs.push("--env", `${key}=${value}`);
      dockerArgs.push(runtimeEnvironment?.image ?? this.policy.runner.image!, ...options.command);
      command = "docker";
      args = dockerArgs;
      cwd = this.workspacePath;
      env = { PATH: process.env.PATH, HOME: process.env.HOME };
    }

    const eventLog = new EventLog(path.join(this.rootPath, "commands.jsonl"));
    eventLog.append("analysis_command_started", { callId, command: options.command, cwd: requestedCwd, runner: this.policy.runner.mode, timeoutSeconds });
    const detached = process.platform !== "win32";
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, shell: false, detached, stdio: ["ignore", "pipe", "pipe"] });
    trackSubprocess(child, detached);
    child.stdout.pipe(stdoutFile);
    child.stderr.pipe(stderrFile);

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let aborted = false;
    let terminating = false;
    let hardKill: NodeJS.Timeout | undefined;
    let lastUpdate = 0;
    const previewLimit = Math.max(512, Math.floor(this.policy.maxOutputBytes / 2));
    const update = () => {
      const now = Date.now();
      if (now - lastUpdate < 250) return;
      lastUpdate = now;
      options.onOutput?.(`${stdout}${stderr ? `${stdout ? "\n" : ""}[stderr]\n${stderr}` : ""}`);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendPreview(stdout, chunk, previewLimit);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
      update();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendPreview(stderr, chunk, previewLimit);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
      update();
    });

    const terminate = (reason: "timeout" | "abort") => {
      if (terminating) return;
      terminating = true;
      if (reason === "timeout") timedOut = true;
      else aborted = true;
      killSubprocessTree(child, detached, "SIGTERM");
      hardKill = setTimeout(() => killSubprocessTree(child, detached, "SIGKILL"), 5_000);
      hardKill.unref();
    };
    const timeout = setTimeout(() => terminate("timeout"), timeoutSeconds * 1_000);
    timeout.unref();
    const abortHandler = () => terminate("abort");
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: string }>((resolve) => {
      child.once("error", (error) => resolve({ exitCode: null, signal: null, spawnError: error.message }));
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    clearTimeout(timeout);
    if (hardKill) clearTimeout(hardKill);
    options.signal?.removeEventListener("abort", abortHandler);
    stdoutFile.end();
    stderrFile.end();
    await streamsClosed;
    if (result.spawnError) stderr = `${stderr}${stderr ? "\n" : ""}${result.spawnError}`;
    update();
    const durationMs = Date.now() - started;
    const output: AnalysisCommandResult = {
      callId,
      command: options.command,
      cwd: requestedCwd,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      aborted,
      durationMs,
      stdout,
      stderr,
      outputTruncated,
      stdoutPath,
      stderrPath,
      evidenceId,
      candidateFingerprint,
      runtimeFingerprint: runtimeInfo.environmentFingerprint,
    };
    const evidence: AnalysisEvidence = {
      evidenceId,
      callId,
      command: [...options.command],
      cwd: requestedCwd,
      candidateFingerprint,
      runtimeFingerprint: runtimeInfo.environmentFingerprint,
      exitCode: result.exitCode,
      timedOut,
      aborted,
      durationMs,
      stale: mutationRevision !== this.mutationRevision,
      createdAt: new Date().toISOString(),
    };
    this.evidenceRecords.push(evidence);
    eventLog.append("analysis_command_completed", {
      callId, exitCode: result.exitCode, signal: result.signal, timedOut, aborted, durationMs,
      outputTruncated, stdoutPath, stderrPath, evidenceId, candidateFingerprint,
      runtimeFingerprint: runtimeInfo.environmentFingerprint,
    });
    try {
      await this.publishEvidence?.(evidence, output);
    } catch (error) {
      eventLog.append("analysis_evidence_publish_failed", { evidenceId, error: error instanceof Error ? error.message : String(error) });
    }
    return output;
  }

  async start(options: AnalysisRunOptions): Promise<AnalysisJobSnapshot> {
    if (this.policy.jobs?.enabled === false) throw new Error("Background analysis jobs are disabled");
    this.assertExplorationBudget();
    const active = [...this.jobs.values()].filter((job) => job.status === "running").length;
    const maximum = this.policy.jobs?.maxConcurrent ?? 2;
    if (active >= maximum) throw new Error(`Background analysis job limit reached (${maximum})`);
    this.nextJob += 1;
    const jobId = `job-${String(this.nextJob).padStart(3, "0")}`;
    const controller = new AbortController();
    const now = new Date().toISOString();
    const state: AnalysisJobState = {
      jobId,
      status: "running",
      startedAt: now,
      updatedAt: now,
      preview: "Job is starting...",
      controller,
      promise: Promise.resolve(),
    };
    state.promise = this.run({
      ...options,
      signal: controller.signal,
      onOutput: (preview) => {
        state.preview = preview;
        state.updatedAt = new Date().toISOString();
        options.onOutput?.(preview);
      },
    }).then((result) => {
      state.result = result;
      state.status = result.aborted ? "cancelled" : result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
      state.updatedAt = new Date().toISOString();
    }, (error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = controller.signal.aborted ? "cancelled" : "failed";
      state.updatedAt = new Date().toISOString();
    });
    this.jobs.set(jobId, state);
    return this.job(jobId);
  }

  job(jobId: string): AnalysisJobSnapshot {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error(`Unknown analysis job ${jobId}`);
    return {
      jobId: state.jobId,
      status: state.status,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      preview: state.preview,
      ...(state.result ? { result: state.result } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  }

  jobsSnapshot(): AnalysisJobSnapshot[] {
    return [...this.jobs.keys()].map((jobId) => this.job(jobId));
  }

  cancel(jobId: string): AnalysisJobSnapshot {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error(`Unknown analysis job ${jobId}`);
    if (state.status === "running") state.controller.abort();
    return this.job(jobId);
  }
}
