import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type {
  HarnessConfig,
  ResolvedRuntimePackage,
  RuntimeDependencyManager,
  RuntimeDependencyRequest,
  RuntimeDependencyScope,
  RuntimeDirectDependency,
  RuntimeEnvironmentManifest,
} from "./types.js";
import { ensureDir, EventLog, writeJsonAtomic } from "./io.js";
import { killSubprocessTree, trackSubprocess } from "./subprocess-registry.js";
import { resolveSafeWorkspacePath } from "./workspace.js";

export interface ResolvedRuntimeEnvironment {
  image: string;
  imageId: string;
  selectedProfile?: string;
  fingerprint?: string;
  pythonPath?: string;
  bunNodeModulesPath?: string;
  cpus?: number;
  memory?: string;
  gpus?: string;
  manifest: RuntimeEnvironmentManifest;
}

interface BrokerCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeDependencyAvailability {
  status: "installed" | "addable" | "denied" | "unavailable";
  manager: RuntimeDependencyManager;
  package: string;
  version?: string;
  source?: "locked-overlay" | "base-image" | "registry" | "policy";
  message: string;
  registry?: BrokerCommandResult;
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function environmentFingerprint(
  imageId: string,
  selectedProfile: string | undefined,
  resources: { cpus?: number; memory?: string; gpus?: string },
  direct: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>>,
  resolved: Partial<Record<RuntimeDependencyManager, ResolvedRuntimePackage[]>>,
): string {
  return hash({
    version: 1,
    imageId,
    selectedProfile: selectedProfile ?? null,
    resources,
    direct,
    resolved,
  });
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDirect(value: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>>): Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>> {
  const output: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>> = {};
  for (const manager of ["python", "bun"] as const) {
    const entries = value[manager] ?? [];
    if (entries.length > 0) output[manager] = [...entries]
      .map((entry) => ({ name: normalizeName(entry.name), version: entry.version.trim() || "*" }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  return output;
}

function mergeDirect(
  candidate: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>>,
  analysis: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>>,
): Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>> {
  const output: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>> = {};
  for (const manager of ["python", "bun"] as const) {
    const entries = new Map<string, RuntimeDirectDependency>();
    for (const item of [...(candidate[manager] ?? []), ...(analysis[manager] ?? [])]) entries.set(normalizeName(item.name), item);
    if (entries.size > 0) output[manager] = [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
  return normalizeDirect(output);
}

function directCount(value: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>>): number {
  return Object.values(value).reduce((sum, entries) => sum + (entries?.length ?? 0), 0);
}

function pythonSpecifier(entry: RuntimeDirectDependency): string {
  if (entry.version === "*") return entry.name;
  return `${entry.name}${/^[<>=!~]/u.test(entry.version) ? entry.version : `==${entry.version}`}`;
}

function bunSpecifier(entry: RuntimeDirectDependency): string {
  return entry.version === "*" ? entry.name : `${entry.name}@${entry.version}`;
}

function manifestShape(value: unknown): RuntimeEnvironmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime dependency manifest must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.baseImage !== "string" || typeof raw.baseImageId !== "string" || typeof raw.createdAt !== "string") {
    throw new Error("Runtime dependency manifest has an unsupported shape");
  }
  const direct = normalizeDirect((raw.direct ?? {}) as Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>>);
  return {
    version: 1,
    ...(typeof raw.selectedProfile === "string" ? { selectedProfile: raw.selectedProfile } : {}),
    baseImage: raw.baseImage,
    baseImageId: raw.baseImageId,
    direct,
    resolved: (raw.resolved ?? {}) as Partial<Record<RuntimeDependencyManager, ResolvedRuntimePackage[]>>,
    ...(typeof raw.environmentFingerprint === "string" ? { environmentFingerprint: raw.environmentFingerprint } : {}),
    createdAt: raw.createdAt,
  };
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) total += (await stat(target)).size;
    }
  };
  await visit(root);
  return total;
}

async function collectBunPackages(root: string): Promise<ResolvedRuntimePackage[]> {
  const packages = new Map<string, string>();
  const visitNodeModules = async (nodeModules: string): Promise<void> => {
    for (const entry of await readdir(nodeModules, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path.join(nodeModules, entry.name), { withFileTypes: true }).catch(() => [])) {
          if (scoped.isDirectory()) await inspectPackage(path.join(nodeModules, entry.name, scoped.name));
        }
      } else {
        await inspectPackage(path.join(nodeModules, entry.name));
      }
    }
  };
  const inspectPackage = async (packageRoot: string): Promise<void> => {
    try {
      const raw = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (typeof raw.name === "string" && typeof raw.version === "string") packages.set(raw.name, raw.version);
    } catch {
      // Ignore non-package directories placed under node_modules.
    }
    await visitNodeModules(path.join(packageRoot, "node_modules"));
  };
  await visitNodeModules(root);
  return [...packages].map(([name, version]) => ({ name, version })).sort((left, right) => left.name.localeCompare(right.name));
}

export async function readRuntimeManifest(config: HarnessConfig, workspacePath: string): Promise<RuntimeEnvironmentManifest | undefined> {
  if (!config.runtimeDependencies?.enabled) return undefined;
  const resolved = await resolveSafeWorkspacePath(workspacePath, config.runtimeDependencies.manifestPath, { allowMissing: true });
  const content = await readFile(resolved.absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return content === undefined ? undefined : manifestShape(JSON.parse(content) as unknown);
}

export async function resolveRuntimeEnvironment(config: HarnessConfig, workspacePath: string): Promise<ResolvedRuntimeEnvironment | undefined> {
  const policy = config.runtimeDependencies;
  if (!policy?.enabled) return undefined;
  const manifest = await readRuntimeManifest(config, workspacePath);
  if (!manifest) return undefined;
  const profile = manifest.selectedProfile ? policy.environmentProfiles[manifest.selectedProfile] : undefined;
  if (manifest.selectedProfile && !profile) throw new Error(`Runtime environment profile is no longer allowed: ${manifest.selectedProfile}`);
  const expectedImage = profile?.image ?? config.evaluator.runner.image!;
  if (manifest.baseImage !== expectedImage) throw new Error(`Runtime manifest image ${manifest.baseImage} does not match configured image ${expectedImage}`);
  if (!manifest.environmentFingerprint) throw new Error("Runtime manifest is missing its locked environment fingerprint");
  const resources = profile ? {
    ...(profile.cpus === undefined ? {} : { cpus: profile.cpus }),
    ...(profile.memory === undefined ? {} : { memory: profile.memory }),
    ...(profile.gpus === undefined ? {} : { gpus: profile.gpus }),
  } : {};
  const expectedFingerprint = environmentFingerprint(manifest.baseImageId, manifest.selectedProfile, resources, manifest.direct, manifest.resolved);
  if (manifest.environmentFingerprint !== expectedFingerprint) throw new Error("Runtime manifest fingerprint does not match its locked contents");
  const environmentRoot = path.join(policy.cachePath, "environments", manifest.environmentFingerprint);
  if (!(await stat(environmentRoot).catch(() => undefined))?.isDirectory()) {
    throw new Error(`Locked runtime environment is missing from cache: ${manifest.environmentFingerprint}`);
  }
  const cachedManifest = manifestShape(JSON.parse(await readFile(path.join(environmentRoot, "environment.json"), "utf8")) as unknown);
  const comparable = (value: RuntimeEnvironmentManifest) => ({
    selectedProfile: value.selectedProfile ?? null,
    baseImage: value.baseImage,
    baseImageId: value.baseImageId,
    direct: value.direct,
    resolved: value.resolved,
    environmentFingerprint: value.environmentFingerprint,
  });
  if (hash(comparable(cachedManifest)) !== hash(comparable(manifest))) {
    throw new Error("Runtime manifest does not match the broker-owned locked environment");
  }
  return {
    image: manifest.baseImageId,
    imageId: manifest.baseImageId,
    ...(manifest.selectedProfile ? { selectedProfile: manifest.selectedProfile } : {}),
    fingerprint: manifest.environmentFingerprint,
    ...((await stat(path.join(environmentRoot, "python")).catch(() => undefined))?.isDirectory()
      ? { pythonPath: path.join(environmentRoot, "python") } : {}),
    ...((await stat(path.join(environmentRoot, "bun", "node_modules")).catch(() => undefined))?.isDirectory()
      ? { bunNodeModulesPath: path.join(environmentRoot, "bun", "node_modules") } : {}),
    ...(profile?.cpus === undefined ? {} : { cpus: profile.cpus }),
    ...(profile?.memory === undefined ? {} : { memory: profile.memory }),
    ...(profile?.gpus === undefined ? {} : { gpus: profile.gpus }),
    manifest,
  };
}

export class DependencyBroker {
  private candidateDirect: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>> = {};
  private analysisDirect: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>> = {};
  private selectedProfile: string | undefined;
  private current: ResolvedRuntimeEnvironment | undefined;
  private initialized = false;
  private calls = 0;
  private readonly audit: EventLog;

  constructor(
    private readonly config: HarnessConfig,
    private readonly workspacePath: string,
    private readonly experimentDir: string,
  ) {
    if (!config.runtimeDependencies?.enabled) throw new Error("Runtime dependency broker is disabled");
    this.audit = new EventLog(path.join(experimentDir, "analysis", "dependencies", "events.jsonl"));
  }

  get manifestPath(): string {
    return this.config.runtimeDependencies!.manifestPath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureDir(path.join(this.experimentDir, "analysis", "dependencies"));
    const manifest = await readRuntimeManifest(this.config, this.workspacePath);
    if (manifest) {
      this.candidateDirect = normalizeDirect(manifest.direct);
      this.selectedProfile = manifest.selectedProfile;
      this.current = await resolveRuntimeEnvironment(this.config, this.workspacePath);
    }
    this.initialized = true;
  }

  async environment(): Promise<ResolvedRuntimeEnvironment | undefined> {
    await this.initialize();
    return this.current;
  }

  private policyRule(manager: RuntimeDependencyManager, packageName: string) {
    const policy = this.config.runtimeDependencies!;
    if (!policy.allowedManagers.includes(manager)) throw new Error(`Dependency manager is not allowed: ${manager}`);
    const normalized = normalizeName(packageName);
    if (!PACKAGE_NAME.test(normalized)) throw new Error(`Unsafe registry package name: ${packageName}`);
    const denied = policy.deny.find((rule) => rule.manager === manager && (rule.package === "*" || normalizeName(rule.package) === normalized));
    if (denied) throw new Error(`Dependency is denied by policy: ${manager}/${packageName}`);
    const allowed = policy.allow.find((rule) => rule.manager === manager && (rule.package === "*" || normalizeName(rule.package) === normalized));
    if (!allowed) throw new Error(`Dependency is not allowlisted: ${manager}/${packageName}`);
    return allowed;
  }

  private imageReference(): { image: string; cpus?: number; memory?: string; gpus?: string } {
    const profile = this.selectedProfile ? this.config.runtimeDependencies!.environmentProfiles[this.selectedProfile] : undefined;
    if (this.selectedProfile && !profile) throw new Error(`Unknown runtime environment profile: ${this.selectedProfile}`);
    return {
      image: profile?.image ?? this.config.agent.analysis!.runner.image!,
      ...(profile?.cpus === undefined ? {} : { cpus: profile.cpus }),
      ...(profile?.memory === undefined ? {} : { memory: profile.memory }),
      ...(profile?.gpus === undefined ? {} : { gpus: profile.gpus }),
    };
  }

  private async runDocker(label: string, args: string[], timeoutSeconds: number): Promise<BrokerCommandResult> {
    this.calls += 1;
    const callId = `call-${String(this.calls).padStart(3, "0")}-${label}`;
    const callDir = path.join(this.experimentDir, "analysis", "dependencies", "calls", callId);
    await ensureDir(callDir);
    const stdoutPath = path.join(callDir, "stdout.log");
    const stderrPath = path.join(callDir, "stderr.log");
    const stdoutFile = createWriteStream(stdoutPath, { flags: "wx" });
    const stderrFile = createWriteStream(stderrPath, { flags: "wx" });
    const streamsClosed = Promise.all([
      new Promise<void>((resolve, reject) => { stdoutFile.once("close", resolve); stdoutFile.once("error", reject); }),
      new Promise<void>((resolve, reject) => { stderrFile.once("close", resolve); stderrFile.once("error", reject); }),
    ]);
    let stdout = "";
    let stderr = "";
    const started = Date.now();
    const child = spawn("docker", args, {
      cwd: this.workspacePath,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackSubprocess(child, process.platform !== "win32");
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.stdout.pipe(stdoutFile);
    child.stderr.pipe(stderrFile);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killSubprocessTree(child, process.platform !== "win32", "SIGKILL");
    }, timeoutSeconds * 1_000);
    timer.unref();
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
      child.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    clearTimeout(timer);
    stdoutFile.end();
    stderrFile.end();
    await streamsClosed;
    if (result.error) stderr += `${stderr ? "\n" : ""}${result.error}`;
    const output = { exitCode: result.exitCode, signal: result.signal, timedOut, durationMs: Date.now() - started, stdout, stderr };
    this.audit.append("dependency_command", { callId, label, args, ...output, stdoutPath, stderrPath });
    return output;
  }

  private async imageId(image: string): Promise<string> {
    const result = await this.runDocker("image-inspect", ["image", "inspect", "--format", "{{.Id}}", image], 30);
    if (result.exitCode !== 0) throw new Error(`Could not inspect runtime image ${image}: ${result.stderr.trim()}`);
    const imageId = result.stdout.trim();
    if (!imageId.startsWith("sha256:")) throw new Error(`Docker returned an invalid image id for ${image}`);
    return imageId;
  }

  private dockerSandbox(image: string, network: string, mountRoot?: string): string[] {
    const runtime = this.imageReference();
    const args = [
      "run", "--rm", "--init", "--network", network,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.config.agent.analysis!.runner.pidsLimit),
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=2g",
      "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp", "--env", "PIP_NO_CACHE_DIR=1", "--env", "BUN_INSTALL_CACHE_DIR=/tmp/bun-cache",
    ];
    if (runtime.cpus ?? this.config.agent.analysis!.runner.cpus) args.push("--cpus", String(runtime.cpus ?? this.config.agent.analysis!.runner.cpus));
    if (runtime.memory ?? this.config.agent.analysis!.runner.memory) args.push("--memory", runtime.memory ?? this.config.agent.analysis!.runner.memory!);
    if (runtime.gpus ?? this.config.agent.analysis!.runner.gpus) args.push("--gpus", runtime.gpus ?? this.config.agent.analysis!.runner.gpus!);
    if (mountRoot) args.push("--mount", `type=bind,src=${path.resolve(mountRoot)},dst=/dependencies`);
    args.push(image);
    return args;
  }

  async info(manager: RuntimeDependencyManager, packageName: string): Promise<BrokerCommandResult> {
    await this.initialize();
    this.policyRule(manager, packageName);
    const { image } = this.imageReference();
    const policy = this.config.runtimeDependencies!;
    const command = manager === "python"
      ? ["python3", "-m", "pip", "index", "versions", packageName, ...(policy.registries.python ? ["--index-url", policy.registries.python] : [])]
      : ["bun", "info", packageName, ...(policy.registries.bun ? ["--registry", policy.registries.bun] : [])];
    return this.runDocker("dependency-info", [...this.dockerSandbox(image, "bridge"), ...command], Math.min(60, policy.maxInstallSeconds));
  }

  async availability(manager: RuntimeDependencyManager, packageName: string): Promise<RuntimeDependencyAvailability> {
    await this.initialize();
    const normalized = normalizeName(packageName);
    const environment = await this.environment();
    const locked = (environment?.manifest.resolved[manager] ?? []).find((entry) => normalizeName(entry.name) === normalized);
    if (locked) {
      return {
        status: "installed",
        manager,
        package: packageName,
        version: locked.version,
        source: "locked-overlay",
        message: `${packageName} ${locked.version} is already installed in the active locked overlay.`,
      };
    }
    const runtime = this.imageReference();
    const pythonCommand = this.config.agent.analysis?.runtime?.pythonCommand ?? ["python3"];
    const inspectCommand = manager === "python"
      ? [...pythonCommand, "-c", "import importlib.metadata,sys; print(importlib.metadata.version(sys.argv[1]))", packageName]
      : ["bun", "-e", "const p=process.argv[1]; try { console.log(require(p + '/package.json').version) } catch { process.exit(2) }", packageName];
    const installed = await this.runDocker("dependency-installed", [
      ...this.dockerSandbox(runtime.image, "none"),
      ...inspectCommand,
    ], Math.min(30, this.config.runtimeDependencies!.maxInstallSeconds));
    const installedVersion = installed.stdout.trim().split(/\r?\n/u).at(-1);
    if (installed.exitCode === 0 && installedVersion) {
      return {
        status: "installed",
        manager,
        package: packageName,
        version: installedVersion,
        source: "base-image",
        message: `${packageName} is already installed in the configured base runtime; no broker installation is needed.`,
      };
    }
    try {
      this.policyRule(manager, packageName);
    } catch (error) {
      return {
        status: "denied",
        manager,
        package: packageName,
        source: "policy",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const registry = await this.info(manager, packageName);
    return registry.exitCode === 0
      ? {
        status: "addable",
        manager,
        package: packageName,
        source: "registry",
        message: `${packageName} is not installed but is allowlisted and available through the configured registry.`,
        registry,
      }
      : {
        status: "unavailable",
        manager,
        package: packageName,
        source: "registry",
        message: `${packageName} is allowlisted but registry lookup failed: ${registry.stderr.trim() || `exit ${registry.exitCode ?? "null"}`}`,
        registry,
      };
  }

  private async buildEnvironment(directInput: Partial<Record<RuntimeDependencyManager, RuntimeDirectDependency[]>>): Promise<ResolvedRuntimeEnvironment> {
    const policy = this.config.runtimeDependencies!;
    const direct = normalizeDirect(directInput);
    const runtime = this.imageReference();
    const imageId = await this.imageId(runtime.image);
    const runtimeResources = {
      ...(runtime.cpus === undefined ? {} : { cpus: runtime.cpus }),
      ...(runtime.memory === undefined ? {} : { memory: runtime.memory }),
      ...(runtime.gpus === undefined ? {} : { gpus: runtime.gpus }),
    };
    if (directCount(direct) === 0) {
      const fingerprint = environmentFingerprint(imageId, this.selectedProfile, runtimeResources, {}, {});
      const manifest: RuntimeEnvironmentManifest = {
        version: 1,
        ...(this.selectedProfile ? { selectedProfile: this.selectedProfile } : {}),
        baseImage: runtime.image,
        baseImageId: imageId,
        direct: {},
        resolved: {},
        environmentFingerprint: fingerprint,
        createdAt: new Date().toISOString(),
      };
      const destination = path.join(policy.cachePath, "environments", fingerprint);
      await ensureDir(destination);
      const manifestPath = path.join(destination, "environment.json");
      const cached = await readFile(manifestPath, "utf8").then((content) => manifestShape(JSON.parse(content) as unknown)).catch(() => undefined);
      const lockedManifest = cached ?? manifest;
      if (!cached) await writeJsonAtomic(manifestPath, manifest);
      return {
        ...runtime,
        image: imageId,
        imageId,
        ...(this.selectedProfile ? { selectedProfile: this.selectedProfile } : {}),
        fingerprint,
        manifest: lockedManifest,
      };
    }
    const requestKey = hash({ version: 1, imageId, selectedProfile: this.selectedProfile ?? null, runtimeResources, direct, python: policy.python, bun: policy.bun, registries: policy.registries });
    const requestIndex = path.join(policy.cachePath, "requests", `${requestKey}.json`);
    try {
      const cached = manifestShape(JSON.parse(await readFile(requestIndex, "utf8")) as unknown);
      const cachedRoot = path.join(policy.cachePath, "environments", cached.environmentFingerprint!);
      if ((await stat(cachedRoot)).isDirectory()) {
        return this.environmentFromManifest(cached);
      }
    } catch {
      // Resolve and materialize a fresh environment.
    }
    await ensureDir(path.join(policy.cachePath, "environments"));
    await ensureDir(path.join(policy.cachePath, "requests"));
    const staging = path.join(policy.cachePath, `.staging-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      const resolved: Partial<Record<RuntimeDependencyManager, ResolvedRuntimePackage[]>> = {};
      if (direct.python?.length) {
        await mkdir(path.join(staging, "python"), { recursive: true });
        const install = [
          ...this.dockerSandbox(runtime.image, "bridge", staging),
          "python3", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--target", "/dependencies/python",
          ...(policy.python.onlyBinary ? ["--only-binary=:all:"] : []),
          ...(policy.registries.python ? ["--index-url", policy.registries.python] : []),
          ...direct.python.map(pythonSpecifier),
        ];
        const installed = await this.runDocker("python-install", install, policy.maxInstallSeconds);
        if (installed.exitCode !== 0) throw new Error(`Python dependency installation failed: ${installed.stderr.trim() || installed.stdout.trim()}`);
        const inspectCode = "import importlib.metadata,json; print(json.dumps(sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions(path=['/dependencies/python'])],key=lambda x:x['name'].lower())))";
        const inspected = await this.runDocker("python-lock", [...this.dockerSandbox(runtime.image, "none", staging), "python3", "-c", inspectCode], 60);
        if (inspected.exitCode !== 0) throw new Error(`Could not lock Python dependencies: ${inspected.stderr.trim()}`);
        resolved.python = JSON.parse(inspected.stdout.trim()) as ResolvedRuntimePackage[];
      }
      if (direct.bun?.length) {
        const bunRoot = path.join(staging, "bun");
        await mkdir(bunRoot, { recursive: true });
        await writeJsonAtomic(path.join(bunRoot, "package.json"), {
          private: true,
          dependencies: Object.fromEntries(direct.bun.map((entry) => [entry.name, entry.version])),
        });
        const install = [
          ...this.dockerSandbox(runtime.image, "bridge", bunRoot),
          "bun", "install", "--cwd", "/dependencies",
          ...(policy.bun.ignoreScripts ? ["--ignore-scripts"] : []),
          ...(policy.registries.bun ? ["--registry", policy.registries.bun] : []),
        ];
        const installed = await this.runDocker("bun-install", install, policy.maxInstallSeconds);
        if (installed.exitCode !== 0) throw new Error(`Bun dependency installation failed: ${installed.stderr.trim() || installed.stdout.trim()}`);
        resolved.bun = await collectBunPackages(path.join(bunRoot, "node_modules"));
      }
      const bytes = await directorySize(staging);
      if (bytes > policy.maxEnvironmentBytes) throw new Error(`Dependency environment is ${bytes} bytes; policy maximum is ${policy.maxEnvironmentBytes}`);
      const fingerprint = environmentFingerprint(imageId, this.selectedProfile, runtimeResources, direct, resolved);
      const destination = path.join(policy.cachePath, "environments", fingerprint);
      const manifest: RuntimeEnvironmentManifest = {
        version: 1,
        ...(this.selectedProfile ? { selectedProfile: this.selectedProfile } : {}),
        baseImage: runtime.image,
        baseImageId: imageId,
        direct,
        resolved,
        environmentFingerprint: fingerprint,
        createdAt: new Date().toISOString(),
      };
      if ((await stat(destination).catch(() => undefined))?.isDirectory()) {
        await rm(staging, { recursive: true, force: true });
      } else {
        try {
          await rename(staging, destination);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!["EEXIST", "ENOTEMPTY"].includes(code ?? "") || !(await stat(destination).catch(() => undefined))?.isDirectory()) throw error;
          await rm(staging, { recursive: true, force: true });
        }
      }
      await writeJsonAtomic(path.join(destination, "environment.json"), manifest);
      await writeJsonAtomic(requestIndex, manifest);
      this.audit.append("dependency_environment_materialized", { fingerprint, image: runtime.image, imageId, direct, resolved, bytes });
      return this.environmentFromManifest(manifest);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private environmentFromManifest(manifest: RuntimeEnvironmentManifest): ResolvedRuntimeEnvironment {
    const root = manifest.environmentFingerprint ? path.join(this.config.runtimeDependencies!.cachePath, "environments", manifest.environmentFingerprint) : undefined;
    const profile = manifest.selectedProfile ? this.config.runtimeDependencies!.environmentProfiles[manifest.selectedProfile] : undefined;
    return {
      image: manifest.baseImageId,
      imageId: manifest.baseImageId,
      ...(manifest.selectedProfile ? { selectedProfile: manifest.selectedProfile } : {}),
      ...(manifest.environmentFingerprint ? { fingerprint: manifest.environmentFingerprint } : {}),
      ...(root && manifest.resolved.python?.length ? { pythonPath: path.join(root, "python") } : {}),
      ...(root && manifest.resolved.bun?.length ? { bunNodeModulesPath: path.join(root, "bun", "node_modules") } : {}),
      ...(profile?.cpus === undefined ? {} : { cpus: profile.cpus }),
      ...(profile?.memory === undefined ? {} : { memory: profile.memory }),
      ...(profile?.gpus === undefined ? {} : { gpus: profile.gpus }),
      manifest,
    };
  }

  private async writeCandidateManifest(environment: ResolvedRuntimeEnvironment): Promise<void> {
    const resolved = await resolveSafeWorkspacePath(this.workspacePath, this.manifestPath, { allowMissing: true });
    await ensureDir(path.dirname(resolved.absolutePath));
    await writeJsonAtomic(resolved.absolutePath, environment.manifest);
  }

  async add(request: RuntimeDependencyRequest): Promise<{ candidateChanged: boolean; environment: ResolvedRuntimeEnvironment }> {
    await this.initialize();
    const policy = this.config.runtimeDependencies!;
    const rule = this.policyRule(request.manager, request.package);
    const requestedVersion = request.version?.trim();
    if (requestedVersion && rule.versions && requestedVersion !== rule.versions) {
      throw new Error(`Requested version ${requestedVersion} does not match the allowed constraint ${rule.versions}`);
    }
    const entry: RuntimeDirectDependency = { name: normalizeName(request.package), version: requestedVersion || rule.versions || "*" };
    const target = request.scope === "candidate" ? this.candidateDirect : this.analysisDirect;
    const updated = [...(target[request.manager] ?? []).filter((item) => normalizeName(item.name) !== entry.name), entry];
    const nextTarget = normalizeDirect({ ...target, [request.manager]: updated });
    const nextCandidate = request.scope === "candidate" ? nextTarget : this.candidateDirect;
    const nextAnalysis = request.scope === "analysis" ? nextTarget : this.analysisDirect;
    if (directCount(nextCandidate) > policy.maxDirectDependencies) throw new Error(`Candidate dependency limit reached (${policy.maxDirectDependencies})`);
    if (directCount(mergeDirect(nextCandidate, nextAnalysis)) > policy.maxDirectDependencies) throw new Error(`Experiment dependency limit reached (${policy.maxDirectDependencies})`);
    const candidateEnvironment = request.scope === "candidate" ? await this.buildEnvironment(nextCandidate) : undefined;
    const combined = mergeDirect(nextCandidate, nextAnalysis);
    const combinedEnvironment = candidateEnvironment && hash(combined) === hash(nextCandidate)
      ? candidateEnvironment
      : await this.buildEnvironment(combined);
    this.candidateDirect = nextCandidate;
    this.analysisDirect = nextAnalysis;
    this.current = combinedEnvironment;
    if (candidateEnvironment) await this.writeCandidateManifest(candidateEnvironment);
    this.audit.append("dependency_added", { ...request, resolvedVersion: entry.version, environmentFingerprint: combinedEnvironment.fingerprint });
    return { candidateChanged: Boolean(candidateEnvironment), environment: combinedEnvironment };
  }

  async remove(manager: RuntimeDependencyManager, packageName: string, scope: RuntimeDependencyScope, reason: string): Promise<{ candidateChanged: boolean; environment: ResolvedRuntimeEnvironment }> {
    await this.initialize();
    const normalized = normalizeName(packageName);
    const target = scope === "candidate" ? this.candidateDirect : this.analysisDirect;
    if (!(target[manager] ?? []).some((entry) => normalizeName(entry.name) === normalized)) throw new Error(`Dependency is not present in ${scope}: ${manager}/${packageName}`);
    const nextTarget = normalizeDirect({ ...target, [manager]: (target[manager] ?? []).filter((entry) => normalizeName(entry.name) !== normalized) });
    const nextCandidate = scope === "candidate" ? nextTarget : this.candidateDirect;
    const nextAnalysis = scope === "analysis" ? nextTarget : this.analysisDirect;
    const candidateEnvironment = scope === "candidate" ? await this.buildEnvironment(nextCandidate) : undefined;
    const combined = mergeDirect(nextCandidate, nextAnalysis);
    const combinedEnvironment = candidateEnvironment && hash(combined) === hash(nextCandidate)
      ? candidateEnvironment
      : await this.buildEnvironment(combined);
    this.candidateDirect = nextCandidate;
    this.analysisDirect = nextAnalysis;
    this.current = combinedEnvironment;
    if (candidateEnvironment) await this.writeCandidateManifest(candidateEnvironment);
    this.audit.append("dependency_removed", { manager, package: packageName, scope, reason, environmentFingerprint: combinedEnvironment.fingerprint });
    return { candidateChanged: Boolean(candidateEnvironment), environment: combinedEnvironment };
  }

  async selectProfile(profileId: string, reason: string): Promise<ResolvedRuntimeEnvironment> {
    await this.initialize();
    if (profileId !== "base" && !this.config.runtimeDependencies!.environmentProfiles[profileId]) {
      throw new Error(`Runtime environment profile is not allowed: ${profileId}`);
    }
    this.selectedProfile = profileId === "base" ? undefined : profileId;
    const candidateEnvironment = await this.buildEnvironment(this.candidateDirect);
    const combined = mergeDirect(this.candidateDirect, this.analysisDirect);
    const combinedEnvironment = hash(combined) === hash(this.candidateDirect) ? candidateEnvironment : await this.buildEnvironment(combined);
    this.current = combinedEnvironment;
    await this.writeCandidateManifest(candidateEnvironment);
    this.audit.append("runtime_profile_selected", { profileId, reason, image: candidateEnvironment.manifest.baseImage, imageId: candidateEnvironment.imageId });
    return combinedEnvironment;
  }
}
