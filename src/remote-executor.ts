import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { EvaluationPhaseEvent, MetricPayload, RemoteExecutorConfig } from "./types.js";
import { killSubprocessTree, trackSubprocess } from "./subprocess-registry.js";

export interface RemoteEvaluationRequest {
  schemaVersion: 1;
  jobId: string;
  kind: "evaluation-attempt";
  workspace: { path: string; fingerprint: string; readOnly: true };
  evaluator: {
    command: string[];
    env: Record<string, string>;
    timeoutSeconds: number;
    seed: number;
    repetition: number;
    experimentId: string;
    stage: { name: string; budgetRatio: number };
  };
  resources: { cpus?: number; memory?: string; gpus?: string; network: string; pidsLimit: number; readOnlyRoot: boolean };
  artifacts: { metrics: true; phaseEvents: boolean; checkpointManifest: boolean };
}

export interface RemoteEvaluationResponse {
  schemaVersion: 1;
  jobId: string;
  status: "completed" | "failed";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  metrics?: MetricPayload;
  phaseEvents?: EvaluationPhaseEvent[];
  checkpointManifest?: Record<string, unknown>;
  error?: string;
}

function validateResponse(value: unknown, jobId: string): RemoteEvaluationResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("remote executor response must be a JSON object");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || raw.jobId !== jobId) throw new Error("remote executor response has an invalid schemaVersion or jobId");
  if (raw.status !== "completed" && raw.status !== "failed") throw new Error("remote executor response status must be completed or failed");
  if (typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs) || raw.durationMs < 0) throw new Error("remote executor durationMs is invalid");
  if (typeof raw.stdout !== "string" || typeof raw.stderr !== "string" || typeof raw.timedOut !== "boolean") throw new Error("remote executor response is missing process output fields");
  if (!(raw.exitCode === null || (typeof raw.exitCode === "number" && Number.isInteger(raw.exitCode)))) throw new Error("remote executor exitCode is invalid");
  if (!(raw.signal === null || typeof raw.signal === "string")) throw new Error("remote executor signal is invalid");
  return raw as unknown as RemoteEvaluationResponse;
}

export async function executeRemoteEvaluation(
  config: RemoteExecutorConfig,
  request: Omit<RemoteEvaluationRequest, "schemaVersion" | "jobId" | "kind">,
): Promise<RemoteEvaluationResponse> {
  const jobId = randomUUID();
  const message: RemoteEvaluationRequest = { schemaVersion: 1, jobId, kind: "evaluation-attempt", ...request };
  const env: NodeJS.ProcessEnv = {};
  for (const key of config.inheritEnv) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, config.env);
  const detached = process.platform !== "win32";
  const child = spawn(config.command[0]!, config.command.slice(1), { env, shell: false, detached, stdio: ["pipe", "pipe", "pipe"] });
  trackSubprocess(child, detached);
  let stdout = "";
  let stderr = "";
  let overflow = false;
  const append = (current: string, chunk: Buffer): string => {
    const combined = current + chunk.toString("utf8");
    if (Buffer.byteLength(combined) <= config.maxResponseBytes) return combined;
    overflow = true;
    return combined.slice(0, config.maxResponseBytes);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
    if (overflow) void killSubprocessTree(child, detached, "SIGKILL");
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.stdin.end(`${JSON.stringify(message)}\n`);
  let timedOut = false;
  let hardKill: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    void killSubprocessTree(child, detached, "SIGTERM");
    hardKill = setTimeout(() => void killSubprocessTree(child, detached, "SIGKILL"), 5_000);
    hardKill.unref();
  }, config.timeoutSeconds * 1_000);
  const processResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (hardKill) clearTimeout(hardKill);
  if (overflow) throw new Error(`remote executor response exceeded ${config.maxResponseBytes} bytes`);
  if (timedOut) throw new Error(`remote executor broker exceeded ${config.timeoutSeconds}s timeout`);
  if (processResult.error) throw new Error(`could not start remote executor broker: ${processResult.error}`);
  if (processResult.code !== 0) throw new Error(`remote executor broker exited with code ${processResult.code}${processResult.signal ? ` (${processResult.signal})` : ""}: ${stderr.trim()}`);
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw new Error("remote executor broker must return exactly one JSON line");
  try {
    return validateResponse(JSON.parse(lines[0]!) as unknown, jobId);
  } catch (error) {
    throw new Error(`invalid remote executor response: ${error instanceof Error ? error.message : String(error)}`);
  }
}
