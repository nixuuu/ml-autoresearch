import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EventLog } from "./io.js";
import type {
  AgentTranscriptActor,
  AgentTranscriptEntry,
  AgentTranscriptMutation,
  AgentTranscriptPhase,
} from "./types.js";

type MutationData = Omit<AgentTranscriptMutation, "timestamp" | "type">;

function messageContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is { type: "text"; text: string } => Boolean(item)
      && typeof item === "object"
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n");
  return text || undefined;
}

function errorMessage(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { errorMessage?: unknown }).errorMessage === "string") {
    return (value as { errorMessage: string }).errorMessage;
  }
  return "Agent request failed";
}

function safeData(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (key, nested: unknown) => {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.includes("signature") || normalizedKey === "encrypted_content") return undefined;
      if (typeof nested === "bigint") return nested.toString();
      return nested;
    })) as unknown;
  } catch {
    return { serializationError: true };
  }
}

export class AgentTranscriptNormalizer {
  private turn = 0;
  private sequence = 0;

  constructor(private readonly actor: Extract<AgentTranscriptActor, "implementer" | "reviewer">) {}

  status(phase: AgentTranscriptPhase, title: string, data?: unknown): MutationData {
    return this.set(phase, "lifecycle", title, { ...(data === undefined ? {} : { data }) });
  }

  normalize(event: AgentSessionEvent, phase: AgentTranscriptPhase): MutationData[] {
    switch (event.type) {
      case "agent_start":
        return [this.set(phase, "lifecycle", "Agent started")];
      case "agent_end":
        return [this.set(phase, "lifecycle", event.willRetry ? "Agent paused before retry" : "Agent completed")];
      case "agent_settled":
        return [this.set(phase, "lifecycle", "Agent session settled")];
      case "turn_start":
        this.turn += 1;
        return [this.set(phase, "lifecycle", `Turn ${this.turn} started`)];
      case "turn_end":
        return [this.set(phase, "lifecycle", `Turn ${this.turn} completed`)];
      case "message_start": {
        if (event.message.role !== "user") return [];
        const content = messageContent(event.message);
        return content ? [this.set(phase, "prompt", "Harness prompt", { actor: "harness", content })] : [];
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          return [this.append(phase, "message", "Agent message", update.contentIndex, update.delta)];
        }
        if (update.type === "thinking_delta") {
          return [this.append(phase, "thinking", "Thinking", update.contentIndex, update.delta)];
        }
        if (update.type === "text_end") {
          return [this.set(phase, "message", "Agent message", {
            entryId: `${this.prefix(phase)}:message:${update.contentIndex}`,
            content: update.content,
          })];
        }
        if (update.type === "thinking_end") {
          return [this.set(phase, "thinking", "Thinking", {
            entryId: `${this.prefix(phase)}:thinking:${update.contentIndex}`,
            content: update.content,
          })];
        }
        if (update.type === "error") {
          return [this.set(phase, "error", "Agent request failed", { content: errorMessage(update.error), isError: true })];
        }
        return [];
      }
      case "tool_execution_start":
        return [this.set(phase, "tool", `Using ${event.toolName}`, {
          entryId: `${this.prefix(phase)}:tool:${event.toolCallId}`,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          data: event.args,
        })];
      case "tool_execution_update":
        return [this.set(phase, "tool_result", `${event.toolName} progress`, {
          entryId: `${this.prefix(phase)}:tool-progress:${event.toolCallId}`,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          data: event.partialResult,
        })];
      case "tool_execution_end":
        return [this.set(phase, "tool_result", `${event.toolName} ${event.isError ? "failed" : "completed"}`, {
          entryId: `${this.prefix(phase)}:tool-result:${event.toolCallId}`,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          data: event.result,
          isError: event.isError,
        })];
      case "compaction_start":
        return [this.set(phase, "lifecycle", `Context compaction started (${event.reason})`)];
      case "compaction_end":
        return [this.set(phase, event.errorMessage ? "error" : "lifecycle", event.errorMessage ? "Context compaction failed" : "Context compaction completed", {
          ...(event.errorMessage ? { content: event.errorMessage, isError: true } : {}),
        })];
      case "auto_retry_start":
        return [this.set(phase, "error", `Retry ${event.attempt}/${event.maxAttempts} scheduled`, { content: event.errorMessage, isError: true })];
      case "auto_retry_end":
        return [this.set(phase, event.success ? "lifecycle" : "error", event.success ? `Retry ${event.attempt} succeeded` : `Retry ${event.attempt} failed`, {
          ...(event.finalError ? { content: event.finalError, isError: true } : {}),
        })];
      default:
        return [];
    }
  }

  private prefix(phase: AgentTranscriptPhase): string {
    return `${this.actor}:${phase}:${this.turn}`;
  }

  private append(
    phase: AgentTranscriptPhase,
    kind: Extract<MutationData["kind"], "message" | "thinking">,
    title: string,
    contentIndex: number,
    content: string,
  ): MutationData {
    return {
      entryId: `${this.prefix(phase)}:${kind}:${contentIndex}`,
      operation: "append",
      phase,
      actor: this.actor,
      kind,
      title,
      content,
    };
  }

  private set(
    phase: AgentTranscriptPhase,
    kind: MutationData["kind"],
    title: string,
    overrides: Partial<MutationData> = {},
  ): MutationData {
    this.sequence += 1;
    const sanitizedOverrides = overrides.data === undefined ? overrides : { ...overrides, data: safeData(overrides.data) };
    return {
      entryId: `${this.prefix(phase)}:${kind}:${this.sequence}`,
      operation: "set",
      phase,
      actor: this.actor,
      kind,
      title,
      ...sanitizedOverrides,
    };
  }
}

export class AgentTranscriptRecorder {
  private readonly log: EventLog;
  private readonly normalizer: AgentTranscriptNormalizer;

  constructor(filePath: string, actor: Extract<AgentTranscriptActor, "implementer" | "reviewer">) {
    this.log = new EventLog(filePath);
    this.normalizer = new AgentTranscriptNormalizer(actor);
  }

  record(event: AgentSessionEvent, phase: AgentTranscriptPhase): void {
    for (const mutation of this.normalizer.normalize(event, phase)) this.log.append("agent_transcript", mutation);
  }

  status(phase: AgentTranscriptPhase, title: string, data?: unknown): void {
    this.log.append("agent_transcript", this.normalizer.status(phase, title, data));
  }
}

export function applyTranscriptMutation(
  entries: AgentTranscriptEntry[],
  mutation: AgentTranscriptMutation,
): { entries: AgentTranscriptEntry[]; entry: AgentTranscriptEntry } {
  const index = entries.findIndex((entry) => entry.id === mutation.entryId);
  const existing = index === -1 ? undefined : entries[index];
  const entry: AgentTranscriptEntry = existing
    ? {
      ...existing,
      updatedAt: mutation.timestamp,
      title: mutation.title,
      ...(mutation.operation === "append"
        ? { content: `${existing.content ?? ""}${mutation.content ?? ""}` }
        : {
          ...(mutation.content === undefined ? {} : { content: mutation.content }),
          ...(mutation.data === undefined ? {} : { data: mutation.data }),
          ...(mutation.toolName === undefined ? {} : { toolName: mutation.toolName }),
          ...(mutation.toolCallId === undefined ? {} : { toolCallId: mutation.toolCallId }),
          ...(mutation.isError === undefined ? {} : { isError: mutation.isError }),
        }),
    }
    : {
      sequence: entries.length + 1,
      id: mutation.entryId,
      timestamp: mutation.timestamp,
      updatedAt: mutation.timestamp,
      phase: mutation.phase,
      actor: mutation.actor,
      kind: mutation.kind,
      title: mutation.title,
      ...(mutation.content === undefined ? {} : { content: mutation.content }),
      ...(mutation.data === undefined ? {} : { data: mutation.data }),
      ...(mutation.toolName === undefined ? {} : { toolName: mutation.toolName }),
      ...(mutation.toolCallId === undefined ? {} : { toolCallId: mutation.toolCallId }),
      ...(mutation.isError === undefined ? {} : { isError: mutation.isError }),
    };
  const next = [...entries];
  if (index === -1) next.push(entry);
  else next[index] = entry;
  return { entries: next, entry };
}

export function parseTranscriptMutation(line: string): AgentTranscriptMutation | undefined {
  try {
    const value = JSON.parse(line) as Partial<AgentTranscriptMutation>;
    if (value.type !== "agent_transcript"
      || typeof value.timestamp !== "string"
      || typeof value.entryId !== "string"
      || (value.operation !== "append" && value.operation !== "set")
      || typeof value.title !== "string") return undefined;
    return value as AgentTranscriptMutation;
  } catch {
    return undefined;
  }
}
