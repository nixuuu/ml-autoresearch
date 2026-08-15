import assert from "node:assert/strict";
import { test } from "bun:test";
import { resolveAgentSelection } from "../src/pi-researcher.js";

test("Pi resolves the configured GPT-5.6 Sol model and xhigh reasoning", async () => {
  const selection = await resolveAgentSelection({
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "xhigh",
  });
  assert.equal(selection.resolvedModel, "openai-codex/gpt-5.6-sol");
  assert.equal(selection.thinkingLevel, "xhigh");
});
