import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { ResearchLabConfig } from "./types.js";
import { ensureDir, writeJsonAtomic } from "./io.js";
import { killSubprocessTree, trackSubprocess } from "./subprocess-registry.js";
import { resolveSafeWorkspacePath } from "./workspace.js";

const PYTHON_BRIDGE = String.raw`
import ast, contextlib, io, json, os, pathlib, traceback

os.chdir("/lab" if os.path.isdir("/lab") else os.environ["AUTORESEARCH_LAB_DIR"])
namespace = {"__name__": "__autoresearch_lab__"}
persisted = pathlib.Path("persisted")
persisted.mkdir(exist_ok=True)
restore_errors = []
for cell in sorted(persisted.glob("*.py")):
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            exec(compile(cell.read_text(), str(cell), "exec"), namespace, namespace)
    except Exception:
        restore_errors.append({"cell": str(cell), "error": traceback.format_exc()})

for raw in iter(input, None):
    request = json.loads(raw)
    stdout, stderr, result = io.StringIO(), io.StringIO(), None
    try:
        tree = ast.parse(request["code"], filename=f"<lab-{request['id']}>", mode="exec")
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                expression = tree.body.pop()
                exec(compile(tree, f"<lab-{request['id']}>", "exec"), namespace, namespace)
                result = repr(eval(compile(ast.Expression(expression.value), f"<lab-{request['id']}>", "eval"), namespace, namespace))
            else:
                exec(compile(tree, f"<lab-{request['id']}>", "exec"), namespace, namespace)
        response = {"id": request["id"], "ok": True, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "result": result, "restoreErrors": restore_errors}
        restore_errors = []
    except Exception:
        response = {"id": request["id"], "ok": False, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "error": traceback.format_exc(), "restoreErrors": restore_errors}
        restore_errors = []
    print(json.dumps(response, ensure_ascii=False), flush=True)
`;

export interface ResearchLabResult {
  id: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  result?: string;
  error?: string;
  restoreErrors: Array<{ cell: string; error: string }>;
  outputTruncated: boolean;
}

interface PendingCell {
  resolve: (result: ResearchLabResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  persistCode?: string;
}

function inheritedEnvironment(config: ResearchLabConfig): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(config.inheritEnv
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...config.env,
  };
}

function bounded(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export class PersistentResearchLab {
  readonly rootPath: string;
  readonly capabilities = Object.freeze({ persistentKernel: true, durableFiles: true, replayableCells: true });
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private calls = 0;
  private callCountRestored = false;
  private pending = new Map<string, PendingCell>();

  constructor(private readonly config: ResearchLabConfig, runDir: string) {
    this.rootPath = path.join(config.path, path.basename(runDir));
  }

  private async start(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    await ensureDir(this.rootPath);
    await ensureDir(path.join(this.rootPath, "persisted"));
    await ensureDir(path.join(this.rootPath, "files"));
    if (!this.callCountRestored) {
      const cells = await readFile(path.join(this.rootPath, "cells.jsonl"), "utf8").catch(() => "");
      this.calls = cells.split(/\r?\n/u).filter(Boolean).reduce((maximum, line) => {
        try {
          const id = String((JSON.parse(line) as { id?: unknown }).id ?? "");
          const number = Number(id.match(/^cell-(\d+)$/u)?.[1] ?? 0);
          return Math.max(maximum, Number.isSafeInteger(number) ? number : 0);
        } catch {
          return maximum;
        }
      }, this.calls);
      this.callCountRestored = true;
    }
    const env: NodeJS.ProcessEnv = {
      ...inheritedEnvironment(this.config),
      AUTORESEARCH_LAB_DIR: this.rootPath,
      PYTHONUNBUFFERED: "1",
    };
    let command = "python3";
    let args = ["-u", "-c", PYTHON_BRIDGE];
    let cwd = this.rootPath;
    let childEnv = env;
    if (this.config.runner.mode === "docker") {
      const dockerArgs = [
        "run", "--rm", "-i", "--init",
        "--network", this.config.runner.network,
        "--pids-limit", String(this.config.runner.pidsLimit),
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--mount", `type=bind,src=${path.resolve(this.rootPath)},dst=/lab`,
        "--workdir", "/lab",
      ];
      if (this.config.runner.readOnlyRoot) dockerArgs.push("--read-only", "--tmpfs", "/tmp:rw,nosuid,size=1g");
      if (this.config.runner.cpus !== undefined) dockerArgs.push("--cpus", String(this.config.runner.cpus));
      if (this.config.runner.memory) dockerArgs.push("--memory", this.config.runner.memory);
      if (this.config.runner.gpus) dockerArgs.push("--gpus", this.config.runner.gpus);
      for (const [key, value] of Object.entries(env)) if (value !== undefined) dockerArgs.push("--env", `${key}=${value}`);
      dockerArgs.push(this.config.runner.image!, "python3", "-u", "-c", PYTHON_BRIDGE);
      command = "docker";
      args = dockerArgs;
      cwd = this.rootPath;
      childEnv = { PATH: process.env.PATH };
    }
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env: childEnv, detached, stdio: ["pipe", "pipe", "pipe"] });
    trackSubprocess(child, detached);
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      void appendFile(path.join(this.rootPath, "kernel.stderr.log"), chunk);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("close", (code, signal) => {
      this.failAll(new Error(`Research lab kernel exited with code=${code ?? "null"} signal=${signal ?? "null"}`));
      if (this.child === child) {
        this.child = undefined;
        this.lines = undefined;
      }
    });
    await writeJsonAtomic(path.join(this.rootPath, "state.json"), {
      version: 1,
      engine: this.config.engine,
      runner: this.config.runner.mode,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      calls: this.calls,
    });
  }

  private handleLine(line: string): void {
    let parsed: Omit<ResearchLabResult, "outputTruncated">;
    try {
      parsed = JSON.parse(line) as Omit<ResearchLabResult, "outputTruncated">;
    } catch {
      void appendFile(path.join(this.rootPath, "kernel.protocol-errors.log"), `${line}\n`, "utf8");
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    const perFieldLimit = Math.max(1, Math.floor(this.config.maxOutputBytes / 3));
    const stdout = bounded(parsed.stdout ?? "", perFieldLimit);
    const stderr = bounded(parsed.stderr ?? "", perFieldLimit);
    const expressionResult = bounded(parsed.result ?? "", perFieldLimit);
    const result = {
      ...parsed,
      stdout: stdout.value,
      stderr: stderr.value,
      ...(parsed.result === undefined ? {} : { result: expressionResult.value }),
      outputTruncated: stdout.truncated || stderr.truncated || expressionResult.truncated,
    };
    if (parsed.ok && pending.persistCode !== undefined) {
      void writeFile(path.join(this.rootPath, "persisted", `${parsed.id}.py`), pending.persistCode, "utf8")
        .then(() => pending.resolve(result), (error: Error) => pending.reject(error));
    } else {
      pending.resolve(result);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async execute(code: string, options: { persist?: boolean } = {}): Promise<ResearchLabResult> {
    if (!code.trim()) throw new Error("Research lab code cannot be empty");
    await this.start();
    if (this.calls >= this.config.maxCalls) throw new Error(`Research lab call limit reached (${this.config.maxCalls})`);
    this.calls += 1;
    const id = `cell-${String(this.calls).padStart(5, "0")}`;
    await appendFile(path.join(this.rootPath, "cells.jsonl"), `${JSON.stringify({
      timestamp: new Date().toISOString(), id, persist: options.persist === true, code,
    })}\n`, "utf8");
    return await new Promise<ResearchLabResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.child) killSubprocessTree(this.child, process.platform !== "win32", "SIGKILL");
        reject(new Error(`Research lab cell ${id} timed out after ${this.config.timeoutSeconds}s`));
      }, this.config.timeoutSeconds * 1_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, ...(options.persist ? { persistCode: code } : {}) });
      this.child!.stdin.write(`${JSON.stringify({ id, code })}\n`);
    });
  }

  async listFiles(): Promise<string[]> {
    await ensureDir(path.join(this.rootPath, "files"));
    const walk = async (directory: string): Promise<string[]> => {
      const output: string[] = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) output.push(...await walk(absolute));
        else if (entry.isFile()) output.push(path.relative(path.join(this.rootPath, "files"), absolute).replaceAll("\\", "/"));
      }
      return output;
    };
    return (await walk(path.join(this.rootPath, "files"))).sort();
  }

  async read(relativePath: string): Promise<string> {
    const root = path.join(this.rootPath, "files");
    await ensureDir(root);
    const resolved = await resolveSafeWorkspacePath(root, relativePath);
    return readFile(resolved.absolutePath, "utf8");
  }

  async write(relativePath: string, content: string): Promise<void> {
    const root = path.join(this.rootPath, "files");
    await ensureDir(root);
    const resolved = await resolveSafeWorkspacePath(root, relativePath, { allowMissing: true });
    await ensureDir(path.dirname(resolved.absolutePath));
    await writeFile(resolved.absolutePath, content, "utf8");
  }

  async dispose(): Promise<void> {
    this.lines?.close();
    if (this.child) {
      const child = this.child;
      child.stdin.end();
      killSubprocessTree(child, process.platform !== "win32", "SIGTERM");
    }
    this.child = undefined;
    this.lines = undefined;
  }
}

export class ResearchLabPool {
  private labs = new Map<string, PersistentResearchLab>();

  constructor(private readonly config: ResearchLabConfig | undefined) {}

  forExperiment(experimentDir: string): PersistentResearchLab | undefined {
    if (!this.config?.enabled) return undefined;
    const runDir = path.dirname(path.dirname(experimentDir));
    let lab = this.labs.get(runDir);
    if (!lab) {
      lab = new PersistentResearchLab(this.config, runDir);
      this.labs.set(runDir, lab);
    }
    return lab;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.labs.values()].map((lab) => lab.dispose()));
    this.labs.clear();
  }
}
