import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentAnalysisConfig } from "./types.js";
import type { ResolvedRuntimeEnvironment } from "./dependency-broker.js";
import { EventLog, ensureDir } from "./io.js";
import { copyWorkspace, resolveSafeWorkspacePath } from "./workspace.js";
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
}

interface RunOptions {
  command: string[];
  cwd?: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onOutput?: (preview: string) => void;
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
  private calls = 0;

  get callCount(): number {
    return this.calls;
  }

  constructor(
    private readonly policy: AgentAnalysisConfig,
    private readonly candidateWorkspacePath: string,
    private readonly experimentDir: string,
    private readonly hiddenPaths: string[],
    private readonly resolveRuntimeEnvironment?: () => Promise<ResolvedRuntimeEnvironment | undefined>,
  ) {
    this.rootPath = path.join(experimentDir, "analysis");
    this.workspacePath = path.join(this.rootPath, "workspace");
    this.scratchPath = path.join(this.workspacePath, ".autoresearch-analysis");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureDir(this.rootPath);
    await copyWorkspace(this.candidateWorkspacePath, this.workspacePath, this.hiddenPaths);
    await ensureDir(this.scratchPath);
    this.initialized = true;
  }

  async syncCandidateFile(relativePath: string): Promise<void> {
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
      await this.initialize();
      return;
    }
    const details = await lstat(source.absolutePath);
    if (details.isSymbolicLink()) throw new Error(`Cannot mirror symlink into analysis workspace: ${relativePath}`);
    await ensureDir(path.dirname(target.absolutePath));
    await rm(target.absolutePath, { recursive: true, force: true });
    await cp(source.absolutePath, target.absolutePath, { recursive: details.isDirectory(), force: false, errorOnExist: true });
  }

  async run(options: RunOptions): Promise<AnalysisCommandResult> {
    await this.initialize();
    if (this.calls >= this.policy.maxCalls) throw new Error(`Open-research command limit reached (${this.policy.maxCalls})`);
    if (options.command.length === 0 || options.command.some((part) => !part || part.includes("\0"))) {
      throw new Error("Analysis command must contain non-empty arguments without NUL bytes");
    }
    this.calls += 1;
    const callId = `call-${String(this.calls).padStart(3, "0")}`;
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
    const hostEnv: NodeJS.ProcessEnv = { ...inheritedEnvironment(this.policy), ...specialEnv };
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
      if (runtimeEnvironment?.pythonPath) containerEnv.PYTHONPATH = `/autoresearch-deps/python${containerEnv.PYTHONPATH ? `:${containerEnv.PYTHONPATH}` : ""}`;
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
    };
    eventLog.append("analysis_command_completed", {
      callId, exitCode: result.exitCode, signal: result.signal, timedOut, aborted, durationMs,
      outputTruncated, stdoutPath, stderrPath,
    });
    return output;
  }
}
