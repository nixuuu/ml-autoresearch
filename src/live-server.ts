import path from "node:path";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type {
  ActiveExperimentSummary,
  AgentTranscriptEntry,
  AgentTranscriptMutation,
  AgentTranscriptPhase,
  AgentTranscriptSnapshot,
  ExperimentRecord,
  LiveDashboardSnapshot,
  LiveProgressEvent,
  RunState,
} from "./types.js";
import { loadWebAssets, type EmbeddedWebAsset } from "./web-assets.js";
import { AgentTranscriptNormalizer, applyTranscriptMutation, parseTranscriptMutation } from "./agent-transcript.js";

export interface LiveDashboardOptions {
  hostname?: string;
  port?: number;
  runDir?: string;
  watchRunDir?: boolean;
  maxProgressEvents?: number;
  assets?: Record<string, EmbeddedWebAsset>;
}

export interface ExperimentDetail {
  experiment: ExperimentRecord | null;
  active: boolean;
  proposal: string | null;
  conclusion: string | null;
}

interface TranscriptCursor {
  offset: number;
  remainder: string;
  normalizer?: AgentTranscriptNormalizer;
}

interface TranscriptSource {
  filePath: string;
  mode: "normalized" | "legacy";
  actor?: "implementer" | "reviewer";
}

interface TranscriptState {
  experimentId: string;
  sourceKey: string;
  sources: TranscriptSource[];
  cursors: Map<string, TranscriptCursor>;
  entries: AgentTranscriptEntry[];
  active: boolean;
  startedAt: string;
  updatedAt: string;
}

interface ActiveExperimentState {
  id: string;
  startedAt: string;
  latestActivityAt: string;
  parentId?: string;
  strategy?: ActiveExperimentSummary["strategy"];
  branchDepth?: number;
  sourceIds?: string[];
}

const encoder = new TextEncoder();

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function decodeAsset(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

export class LiveDashboardServer {
  private readonly hostname: string;
  private readonly requestedPort: number;
  private readonly maxProgressEvents: number;
  private runDir: string | undefined;
  private readonly watchRunDir: boolean;
  private server: ReturnType<typeof Bun.serve> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;
  private refreshTask: Promise<void> | undefined;
  private refreshIncludesTranscripts = false;
  private stateJson?: string;
  private eventsJson: string | undefined;
  private assets: Record<string, EmbeddedWebAsset> = {};
  private sequence = 0;
  private run: RunState | null = null;
  private phase: LiveProgressEvent | null = null;
  private progress: LiveProgressEvent[] = [];
  private activeExperimentEvents = new Map<string, ActiveExperimentState>();
  private readonly transcripts = new Map<string, TranscriptState>();
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly transcriptSubscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

  constructor(options: LiveDashboardOptions = {}) {
    this.hostname = options.hostname ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.runDir = options.runDir ? path.resolve(options.runDir) : undefined;
    this.watchRunDir = options.watchRunDir ?? false;
    this.maxProgressEvents = options.maxProgressEvents ?? 500;
    this.assets = options.assets ?? {};
  }

  get url(): string {
    if (!this.server) throw new Error("Dashboard server has not started");
    return `http://${this.hostname}:${this.server.port}`;
  }

  get snapshot(): LiveDashboardSnapshot {
    return {
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      run: this.run,
      phase: this.phase,
      progress: [...this.progress],
      activeExperiments: this.activeExperimentSummaries(),
    };
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (Object.keys(this.assets).length === 0) this.assets = await loadWebAssets();
    await this.refreshFromDisk(false);
    this.server = Bun.serve({
      hostname: this.hostname,
      port: this.requestedPort,
      idleTimeout: 255,
      fetch: (request) => this.handleRequest(request),
      error: (error) => jsonResponse({ error: error.message }, 500),
    });
    this.heartbeat = setInterval(() => this.broadcastRaw(encoder.encode(": heartbeat\n\n")), 15_000);
    if (this.watchRunDir) {
      this.watcher = setInterval(() => void this.refreshFromDisk(), 750);
    }
    void this.refreshFromDisk();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.watcher) clearInterval(this.watcher);
    this.heartbeat = undefined;
    this.watcher = undefined;
    for (const controller of this.subscribers) {
      try {
        controller.close();
      } catch {
        // A disconnected browser can already have closed the stream.
      }
    }
    this.subscribers.clear();
    for (const subscribers of this.transcriptSubscribers.values()) {
      for (const controller of subscribers) {
        try {
          controller.close();
        } catch {
          // A disconnected browser can already have closed the stream.
        }
      }
    }
    this.transcriptSubscribers.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  publishProgress(message: string): void {
    const event: LiveProgressEvent = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      message,
    };
    this.phase = event;
    this.progress = [...this.progress, event].slice(-this.maxProgressEvents);
    this.broadcast("progress", event);
  }

  publishState(state: RunState): void {
    this.run = structuredClone(state);
    const nextRunDir = path.resolve(state.runDir);
    if (nextRunDir !== this.runDir) {
      this.eventsJson = undefined;
      this.transcripts.clear();
    }
    this.runDir = nextRunDir;
    this.stateJson = JSON.stringify(this.run);
    this.refreshTranscriptActivity();
    this.broadcast("snapshot", this.snapshot);
  }

  private async refreshFromDisk(includeTranscripts = true): Promise<void> {
    if (this.refreshTask) {
      const existingIncludesTranscripts = this.refreshIncludesTranscripts;
      await this.refreshTask;
      if (includeTranscripts && !existingIncludesTranscripts) await this.refreshFromDisk(true);
      return;
    }
    const task = this.performRefreshFromDisk(includeTranscripts);
    this.refreshTask = task;
    this.refreshIncludesTranscripts = includeTranscripts;
    try {
      await task;
    } finally {
      if (this.refreshTask === task) {
        this.refreshTask = undefined;
        this.refreshIncludesTranscripts = false;
      }
    }
  }

  private async performRefreshFromDisk(includeTranscripts: boolean): Promise<void> {
    if (!this.runDir) return;
    let changed = false;
    try {
      const raw = await readFile(path.join(this.runDir, "state.json"), "utf8");
      if (raw !== this.stateJson) {
        this.stateJson = raw;
        this.run = JSON.parse(raw) as RunState;
        changed = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    changed = (await this.refreshProgressFromDisk()) || changed;
    if (includeTranscripts) changed = (await this.refreshTranscriptsFromDisk()) || changed;
    if (changed) this.broadcast("snapshot", this.snapshot);
  }

  private async refreshProgressFromDisk(): Promise<boolean> {
    if (!this.runDir) return false;
    try {
      const raw = await readFile(path.join(this.runDir, "events.jsonl"), "utf8");
      if (raw === this.eventsJson) return false;
      this.eventsJson = raw;
      const parsed: LiveProgressEvent[] = [];
      const activeExperiments = new Map<string, ActiveExperimentState>();
      for (const line of raw.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            type?: unknown;
            timestamp?: unknown;
            message?: unknown;
            id?: unknown;
            assignment?: unknown;
          };
          const timestamp = typeof event.timestamp === "string" ? event.timestamp : new Date(0).toISOString();
          if (event.type === "run_started" || event.type === "run_resumed" || event.type === "run_finished" || event.type === "run_failed") {
            activeExperiments.clear();
          } else if (event.type === "experiment_started" && typeof event.id === "string") {
            const assignment = event.assignment && typeof event.assignment === "object"
              ? event.assignment as Record<string, unknown>
              : {};
            const merge = assignment.merge && typeof assignment.merge === "object"
              ? assignment.merge as Record<string, unknown>
              : undefined;
            const sourceIds = Array.isArray(merge?.sourceExperimentIds)
              ? merge.sourceExperimentIds.filter((value): value is string => typeof value === "string")
              : undefined;
            activeExperiments.set(event.id, {
              id: event.id,
              startedAt: timestamp,
              latestActivityAt: timestamp,
              ...(typeof assignment.parentId === "string" ? { parentId: assignment.parentId } : {}),
              ...(typeof assignment.strategy === "string" ? { strategy: assignment.strategy as ActiveExperimentSummary["strategy"] } : {}),
              ...(typeof assignment.branchDepth === "number" ? { branchDepth: assignment.branchDepth } : {}),
              ...(sourceIds?.length ? { sourceIds } : {}),
            });
          } else if (event.type === "experiment_decided" && typeof event.id === "string") {
            const active = activeExperiments.get(event.id);
            if (active) active.latestActivityAt = timestamp;
          }
          if (event.type === "progress" && typeof event.message === "string") {
            parsed.push({ sequence: parsed.length + 1, timestamp, message: event.message });
            const experimentId = event.message.match(/^(exp-\d{4,})\b/u)?.[1];
            const active = experimentId ? activeExperiments.get(experimentId) : undefined;
            if (active) active.latestActivityAt = timestamp;
          }
        } catch {
          // Ignore a partial or malformed append-only log line.
        }
      }
      this.activeExperimentEvents = activeExperiments;
      this.progress = parsed.slice(-this.maxProgressEvents).map((event, index) => ({ ...event, sequence: index + 1 }));
      this.sequence = this.progress.at(-1)?.sequence ?? 0;
      this.phase = this.progress.at(-1) ?? null;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (this.eventsJson === undefined && this.progress.length === 0) return false;
      this.eventsJson = "";
      this.progress = [];
      this.sequence = 0;
      this.phase = null;
      this.activeExperimentEvents.clear();
      return true;
    }
  }

  private activeExperimentSummaries(): ActiveExperimentSummary[] {
    if (this.run?.status !== "running") return [];
    const completed = new Set(this.run.experiments.map((experiment) => experiment.id));
    const summaries = new Map<string, ActiveExperimentSummary>();
    for (const active of this.activeExperimentEvents.values()) {
      if (completed.has(active.id)) continue;
      summaries.set(active.id, {
        id: active.id,
        startedAt: active.startedAt,
        transcriptEntries: 0,
        latestActivityAt: active.latestActivityAt,
        ...(active.parentId ? { parentId: active.parentId } : {}),
        ...(active.strategy ? { strategy: active.strategy } : {}),
        ...(active.branchDepth !== undefined ? { branchDepth: active.branchDepth } : {}),
        ...(active.sourceIds?.length ? { sourceIds: active.sourceIds } : {}),
      });
    }
    for (const transcript of this.transcripts.values()) {
      if (!transcript.active || completed.has(transcript.experimentId)) continue;
      const metadata = summaries.get(transcript.experimentId);
      summaries.set(transcript.experimentId, {
        ...metadata,
        id: transcript.experimentId,
        startedAt: metadata?.startedAt ?? transcript.startedAt,
        transcriptEntries: transcript.entries.length,
        latestActivityAt: [metadata?.latestActivityAt, transcript.updatedAt].filter(Boolean).sort().at(-1)!,
      });
    }
    return [...summaries.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  private experimentIsActive(experimentId: string): boolean {
    if (this.run?.status !== "running" || this.run.experiments.some((experiment) => experiment.id === experimentId)) return false;
    return this.activeExperimentEvents.has(experimentId) || this.transcripts.get(experimentId)?.active === true;
  }

  private refreshTranscriptActivity(): void {
    const completed = new Set(this.run?.experiments.map((experiment) => experiment.id) ?? []);
    for (const transcript of this.transcripts.values()) transcript.active = !completed.has(transcript.experimentId);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      return (await stat(filePath)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async transcriptSources(experimentDir: string): Promise<TranscriptSource[]> {
    const normalized = path.join(experimentDir, "agent-transcript.jsonl");
    if (await this.fileExists(normalized)) return [{ filePath: normalized, mode: "normalized" }];
    const legacy: TranscriptSource[] = [];
    const implementer = path.join(experimentDir, "pi-events.jsonl");
    const reviewer = path.join(experimentDir, "reviewer-events.jsonl");
    if (await this.fileExists(implementer)) legacy.push({ filePath: implementer, mode: "legacy", actor: "implementer" });
    if (await this.fileExists(reviewer)) legacy.push({ filePath: reviewer, mode: "legacy", actor: "reviewer" });
    return legacy;
  }

  private async refreshTranscriptsFromDisk(): Promise<boolean> {
    if (!this.runDir) return false;
    const experimentsDir = path.join(this.runDir, "experiments");
    let directories;
    try {
      directories = await readdir(experimentsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    let changed = false;
    const seen = new Set<string>();
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^exp-\d{4,}$/u.test(directory.name)) continue;
      const experimentId = directory.name;
      const sources = await this.transcriptSources(path.join(experimentsDir, experimentId));
      if (sources.length === 0) continue;
      seen.add(experimentId);
      const sourceKey = sources.map((source) => `${source.mode}:${source.filePath}`).join("|");
      let transcript = this.transcripts.get(experimentId);
      if (!transcript || transcript.sourceKey !== sourceKey) {
        const now = new Date().toISOString();
        transcript = {
          experimentId,
          sourceKey,
          sources,
          cursors: new Map(),
          entries: [],
          active: !this.run?.experiments.some((experiment) => experiment.id === experimentId),
          startedAt: this.run?.experiments.find((experiment) => experiment.id === experimentId)?.startedAt ?? now,
          updatedAt: now,
        };
        this.transcripts.set(experimentId, transcript);
        changed = true;
      }
      for (const source of transcript.sources) {
        changed = (await this.refreshTranscriptSource(transcript, source)) || changed;
      }
      const first = transcript.entries[0];
      if (first && !this.run?.experiments.some((experiment) => experiment.id === experimentId)) transcript.startedAt = first.timestamp;
    }
    for (const [experimentId, transcript] of this.transcripts) {
      if (seen.has(experimentId)) continue;
      if (transcript.active) changed = true;
      this.transcripts.delete(experimentId);
    }
    const before = JSON.stringify(this.activeExperimentSummaries());
    this.refreshTranscriptActivity();
    if (JSON.stringify(this.activeExperimentSummaries()) !== before) changed = true;
    return changed;
  }

  private async refreshTranscriptSource(transcript: TranscriptState, source: TranscriptSource): Promise<boolean> {
    const sourceStats = await stat(source.filePath);
    let cursor = transcript.cursors.get(source.filePath);
    if (!cursor || sourceStats.size < cursor.offset) {
      if (cursor && sourceStats.size < cursor.offset) {
        transcript.entries = [];
        transcript.cursors.clear();
      }
      cursor = {
        offset: 0,
        remainder: "",
        ...(source.mode === "legacy" && source.actor ? { normalizer: new AgentTranscriptNormalizer(source.actor) } : {}),
      };
      transcript.cursors.set(source.filePath, cursor);
    }
    if (sourceStats.size === cursor.offset) return false;

    let pending = cursor.remainder;
    let changed = false;
    const stream = createReadStream(source.filePath, {
      start: cursor.offset,
      end: sourceStats.size - 1,
      encoding: "utf8",
    });
    for await (const chunk of stream) {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const mutations = source.mode === "normalized"
          ? [parseTranscriptMutation(line)].filter((mutation): mutation is AgentTranscriptMutation => mutation !== undefined)
          : this.legacyTranscriptMutations(line, cursor.normalizer!);
        for (const mutation of mutations) {
          const applied = applyTranscriptMutation(transcript.entries, mutation);
          transcript.entries = applied.entries;
          transcript.updatedAt = applied.entry.updatedAt;
          this.broadcastTranscript(transcript.experimentId, "entry", applied.entry);
          changed = true;
        }
      }
    }
    cursor.offset = sourceStats.size;
    cursor.remainder = pending;
    return changed;
  }

  private legacyTranscriptMutations(line: string, normalizer: AgentTranscriptNormalizer): AgentTranscriptMutation[] {
    try {
      const raw = JSON.parse(line) as {
        timestamp?: unknown;
        type?: unknown;
        phase?: unknown;
        event?: unknown;
        requestedModel?: unknown;
        resolvedModel?: unknown;
        effectiveThinkingLevel?: unknown;
      };
      const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : new Date(0).toISOString();
      const phase: AgentTranscriptPhase = raw.phase === "reflection"
        ? "reflection"
        : raw.phase === "proposal_review"
          ? "proposal_review"
          : "proposal";
      const data = raw.type === "agent_session_configured"
        ? [normalizer.status(phase, "Agent session configured", {
          requestedModel: raw.requestedModel ?? null,
          resolvedModel: raw.resolvedModel ?? null,
          thinkingLevel: raw.effectiveThinkingLevel ?? null,
        })]
        : raw.type === "pi_event" && raw.event && typeof raw.event === "object"
          ? normalizer.normalize(raw.event as Parameters<AgentTranscriptNormalizer["normalize"]>[0], phase)
          : [];
      return data.map((mutation) => ({ timestamp, type: "agent_transcript", ...mutation }));
    } catch {
      return [];
    }
  }

  private transcriptSnapshot(experimentId: string): AgentTranscriptSnapshot | undefined {
    const transcript = this.transcripts.get(experimentId);
    if (!transcript) {
      const active = this.activeExperimentEvents.get(experimentId);
      if (!active || !this.experimentIsActive(experimentId)) return undefined;
      return {
        schemaVersion: 1,
        experimentId,
        active: true,
        updatedAt: active.latestActivityAt,
        entries: [],
      };
    }
    return {
      schemaVersion: 1,
      experimentId,
      active: transcript.active,
      updatedAt: transcript.updatedAt,
      entries: transcript.entries,
    };
  }

  private async transcriptResponse(experimentId: string): Promise<Response> {
    await this.refreshFromDisk();
    const snapshot = this.transcriptSnapshot(experimentId);
    return snapshot ? jsonResponse(snapshot) : jsonResponse({ error: `Transcript not found: ${experimentId}` }, 404);
  }

  private transcriptEventStream(experimentId: string, signal: AbortSignal): Response {
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
    const remove = () => {
      if (!subscriber) return;
      const subscribers = this.transcriptSubscribers.get(experimentId);
      subscribers?.delete(subscriber);
      if (subscribers?.size === 0) this.transcriptSubscribers.delete(experimentId);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = controller;
        const subscribers = this.transcriptSubscribers.get(experimentId) ?? new Set();
        subscribers.add(controller);
        this.transcriptSubscribers.set(experimentId, subscribers);
        const snapshot = this.transcriptSnapshot(experimentId);
        controller.enqueue(this.encodeEvent("snapshot", snapshot ?? {
          schemaVersion: 1,
          experimentId,
          active: false,
          updatedAt: new Date().toISOString(),
          entries: [],
        } satisfies AgentTranscriptSnapshot));
        signal.addEventListener("abort", remove, { once: true });
      },
      cancel: remove,
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  private broadcastTranscript(experimentId: string, name: string, data: unknown): void {
    const subscribers = this.transcriptSubscribers.get(experimentId);
    if (!subscribers) return;
    const payload = this.encodeEvent(name, data);
    for (const controller of subscribers) {
      try {
        controller.enqueue(payload);
      } catch {
        subscribers.delete(controller);
      }
    }
    if (subscribers.size === 0) this.transcriptSubscribers.delete(experimentId);
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "HEAD" && !url.pathname.startsWith("/api/")) {
      const response = this.assetResponse(url.pathname);
      return new Response(null, { status: response.status, headers: response.headers });
    }
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    if (url.pathname === "/api/state") return jsonResponse(this.snapshot);
    if (url.pathname === "/api/events") return this.eventStream(request.signal);
    const transcriptMatch = url.pathname.match(/^\/api\/experiments\/(exp-\d{4,})\/transcript(?:\/(events))?$/u);
    if (transcriptMatch?.[1]) {
      if (transcriptMatch[2] === "events") return this.transcriptEventStream(transcriptMatch[1], request.signal);
      return this.transcriptResponse(transcriptMatch[1]);
    }
    if (url.pathname.startsWith("/api/experiments/")) {
      return this.experimentResponse(decodeURIComponent(url.pathname.slice("/api/experiments/".length)));
    }
    if (url.pathname.startsWith("/api/")) return jsonResponse({ error: "Not found" }, 404);
    return this.assetResponse(url.pathname);
  }

  private eventStream(signal: AbortSignal): Response {
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
    const remove = () => {
      if (subscriber) this.subscribers.delete(subscriber);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = controller;
        this.subscribers.add(controller);
        controller.enqueue(this.encodeEvent("snapshot", this.snapshot));
        signal.addEventListener("abort", remove, { once: true });
      },
      cancel: remove,
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  private async experimentResponse(id: string): Promise<Response> {
    if (!/^exp-\d{4,}$/.test(id)) return jsonResponse({ error: "Invalid experiment id" }, 400);
    const experiment = this.run?.experiments.find((candidate) => candidate.id === id) ?? null;
    if (!experiment && !this.transcripts.has(id) && !this.activeExperimentEvents.has(id)) await this.refreshFromDisk();
    const active = this.experimentIsActive(id);
    if (!experiment && !active) return jsonResponse({ error: `Experiment not found: ${id}` }, 404);
    const detail: ExperimentDetail = {
      experiment,
      active,
      proposal: await this.readRunArtifact(experiment?.proposalPath),
      conclusion: await this.readRunArtifact(experiment?.conclusionPath),
    };
    return jsonResponse(detail);
  }

  private async readRunArtifact(filePath: string | undefined): Promise<string | null> {
    if (!filePath || !this.runDir) return null;
    const resolved = path.resolve(filePath);
    if (!isInside(this.runDir, resolved)) return null;
    return readFile(resolved, "utf8").catch(() => null);
  }

  private assetResponse(requestPath: string): Response {
    const normalized = requestPath === "/" ? "/index.html" : requestPath.replace(/\/$/, "/index.html");
    const asset = this.assets[normalized] ?? this.assets[`/${normalized.replace(/^\//, "")}`];
    const fallback = this.assets["/index.html"];
    const selected = asset ?? fallback;
    if (!selected) return new Response("Dashboard assets were not embedded", { status: 500 });
    const immutable = normalized.startsWith("/_app/immutable/") && Boolean(asset);
    return new Response(decodeAsset(selected.base64), {
      headers: {
        "content-type": selected.contentType,
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private encodeEvent(name: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(name: string, data: unknown): void {
    this.broadcastRaw(this.encodeEvent(name, data));
  }

  private broadcastRaw(payload: Uint8Array): void {
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(payload);
      } catch {
        this.subscribers.delete(controller);
      }
    }
  }
}
