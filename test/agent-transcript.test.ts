import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentTranscriptNormalizer, applyTranscriptMutation } from "../src/agent-transcript.js";
import type { AgentTranscriptEntry, AgentTranscriptMutation } from "../src/types.js";

function event(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

describe("agent transcript", () => {
  test("coalesces streamed thinking and retains tool edits without provider signatures", () => {
    const normalizer = new AgentTranscriptNormalizer("implementer");
    normalizer.normalize(event({ type: "turn_start" }), "proposal");
    const mutations = [
      ...normalizer.normalize(event({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspecting " },
      }), "proposal"),
      ...normalizer.normalize(event({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "the model" },
      }), "proposal"),
      ...normalizer.normalize(event({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "research_replace",
        args: { path: "model.py", oldText: "degree = 2", newText: "degree = 3", thinkingSignature: "secret" },
      }), "proposal"),
      ...normalizer.normalize(event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "research_replace",
        result: { content: [{ type: "text", text: "Updated model.py" }] },
        isError: false,
      }), "proposal"),
    ];
    let entries: AgentTranscriptEntry[] = [];
    mutations.forEach((mutation, index) => {
      const applied = applyTranscriptMutation(entries, {
        timestamp: `2026-01-01T00:00:0${index}.000Z`,
        type: "agent_transcript",
        ...mutation,
      } as AgentTranscriptMutation);
      entries = applied.entries;
    });

    expect(entries.find((entry) => entry.kind === "thinking")?.content).toBe("Inspecting the model");
    const tool = entries.find((entry) => entry.kind === "tool");
    expect(tool?.data).toEqual({ path: "model.py", oldText: "degree = 2", newText: "degree = 3" });
    expect(JSON.stringify(entries)).not.toContain("secret");
    expect(entries.find((entry) => entry.kind === "tool_result")?.title).toBe("research_replace completed");
  });

  test("records prompts and retry failures with their phase and actor", () => {
    const normalizer = new AgentTranscriptNormalizer("reviewer");
    const prompt = normalizer.normalize(event({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "Review this candidate" }] },
    }), "proposal_review")[0];
    const retry = normalizer.normalize(event({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 100,
      errorMessage: "rate limited",
    }), "proposal_review")[0];

    expect(prompt).toMatchObject({ actor: "harness", kind: "prompt", content: "Review this candidate", phase: "proposal_review" });
    expect(retry).toMatchObject({ actor: "reviewer", kind: "error", content: "rate limited", isError: true });
  });
});
