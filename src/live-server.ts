import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ExperimentRecord, LiveDashboardSnapshot, LiveProgressEvent, RunState } from "./types.js";
import { loadWebAssets, type EmbeddedWebAsset } from "./web-assets.js";

export interface LiveDashboardOptions {
  hostname?: string;
  port?: number;
  runDir?: string;
  watchRunDir?: boolean;
  maxProgressEvents?: number;
  assets?: Record<string, EmbeddedWebAsset>;
}

export interface ExperimentDetail {
  experiment: ExperimentRecord;
  proposal: string | null;
  conclusion: string | null;
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
  private stateJson?: string;
  private eventsJson: string | undefined;
  private assets: Record<string, EmbeddedWebAsset> = {};
  private sequence = 0;
  private run: RunState | null = null;
  private phase: LiveProgressEvent | null = null;
  private progress: LiveProgressEvent[] = [];
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

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
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      run: this.run,
      phase: this.phase,
      progress: [...this.progress],
    };
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (Object.keys(this.assets).length === 0) this.assets = await loadWebAssets();
    await this.refreshFromDisk();
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
    if (nextRunDir !== this.runDir) this.eventsJson = undefined;
    this.runDir = nextRunDir;
    this.stateJson = JSON.stringify(this.run);
    this.broadcast("snapshot", this.snapshot);
  }

  private async refreshFromDisk(): Promise<void> {
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
    if (changed) this.broadcast("snapshot", this.snapshot);
  }

  private async refreshProgressFromDisk(): Promise<boolean> {
    if (!this.runDir) return false;
    try {
      const raw = await readFile(path.join(this.runDir, "events.jsonl"), "utf8");
      if (raw === this.eventsJson) return false;
      this.eventsJson = raw;
      const parsed: LiveProgressEvent[] = [];
      for (const line of raw.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { type?: unknown; timestamp?: unknown; message?: unknown };
          if (event.type !== "progress" || typeof event.message !== "string") continue;
          parsed.push({
            sequence: parsed.length + 1,
            timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date(0).toISOString(),
            message: event.message,
          });
        } catch {
          // Ignore a partial or malformed append-only log line.
        }
      }
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
      return true;
    }
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
    const experiment = this.run?.experiments.find((candidate) => candidate.id === id);
    if (!experiment) return jsonResponse({ error: `Experiment not found: ${id}` }, 404);
    const detail: ExperimentDetail = {
      experiment,
      proposal: await this.readRunArtifact(experiment.proposalPath),
      conclusion: await this.readRunArtifact(experiment.conclusionPath),
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
