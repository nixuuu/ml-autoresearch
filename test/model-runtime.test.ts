import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import { createAgentModelRuntime } from "../src/model-runtime.js";
import { resolveAgentSelection, assertAgentAuthentication } from "../src/pi-researcher.js";
import type { HarnessConfig } from "../src/types.js";
import { TEST_MODEL_CATALOG } from "./fixtures/model-catalog.js";

test("custom catalog preserves exact models, reasoning effort and Responses transport without network", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "autoresearch-provider-"));
  try {
    const modelsPath = path.join(temporary, "models.json");
    await writeFile(modelsPath, JSON.stringify(TEST_MODEL_CATALOG));
    const runtime = await createAgentModelRuntime({ modelsPath });
    for (const [id, effort] of [["director-model", "high"], ["implementer-model", "max"]] as const) {
      const selection = await resolveAgentSelection({ model: `test-provider/${id}`, thinkingLevel: effort, modelsPath });
      assert.equal(selection.resolvedModel, `test-provider/${id}`);
      assert.equal(selection.thinkingLevel, effort);
      const model = runtime.getModel("test-provider", id)!;
      assert.equal(model.api, "openai-responses");
      let requests = 0;
      const result = await runtime.completeSimple(model, {
        systemPrompt: "Inspect the data with the supplied tool.",
        messages: [{ role: "user", content: "Inspect one record.", timestamp: Date.now() }],
        tools: [{ name: "inspect_record", description: "Read one record", parameters: Type.Object({ id: Type.String() }) }],
      }, {
        reasoning: effort,
        maxRetries: 0,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests += 1;
          assert.equal(String(input), "https://models.example.invalid/v1/responses");
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer unit-test-only");
          const payload = JSON.parse(String(init?.body));
          assert.equal(payload.model, id);
          assert.equal(payload.reasoning.effort, effort);
          assert.equal(payload.tools[0].name, "inspect_record");
          assert.equal(payload.store, false);
          assert.equal(payload.stream, true);
          return new Response('data: {"type":"response.completed","response":{"id":"unit-response","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        }) as typeof fetch,
      });
      assert.equal(requests, 1);
      assert.notEqual(result.stopReason, "error", result.errorMessage);
    }
    await assertAgentAuthentication({ agent: { modelsPath, thinkingLevel: "high", roles: {
      director: { id: "director", model: "test-provider/director-model", thinkingLevel: "high" },
      implementer: { id: "implementer", model: "test-provider/implementer-model", thinkingLevel: "max" },
    } } } as HarnessConfig);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an explicitly configured missing or malformed model catalog cannot silently use defaults", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "autoresearch-model-catalog-"));
  try {
    const modelsPath = path.join(temporary, "models.json");
    await assert.rejects(createAgentModelRuntime({ modelsPath }), /model catalog/);
    await writeFile(modelsPath, '{"secret-test-marker":');
    await assert.rejects(createAgentModelRuntime({ modelsPath }), (error: Error) => {
      assert.match(error.message, /model catalog/);
      assert.ok(!error.message.includes("secret-test-marker"));
      return true;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
