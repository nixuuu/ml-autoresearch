import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { PrimeAgentRpcClient } from "../src/prime-agent-researcher.js";
import type { AgentBackendConfig } from "../src/types.js";

test("Prime Agent RPC client correlates responses, streams events, and reports usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prime-agent-rpc-"));
  const backend: AgentBackendConfig = {
    type: "prime-agent-rpc",
    command: [process.execPath, path.join(import.meta.dir, "fixtures", "fake-prime-agent-rpc.ts")],
    timeoutSeconds: 5,
    inheritEnv: ["PATH"],
    env: {},
    runner: {
      mode: "local",
      allowHostExecution: true,
      network: "none",
      readOnlyRoot: true,
      pidsLimit: 64,
    },
  };
  const client = new PrimeAgentRpcClient(
    backend,
    root,
    path.join(root, "session"),
    path.join(root, "stderr.log"),
  );
  const events: string[] = [];
  client.onEvent((event) => events.push(String(event.type)));
  const state = await client.request("get_state");
  assert.deepEqual(state.data, { telemetry: "0" });
  assert.equal(await client.prompt("test"), "structured\u2028result");
  assert.deepEqual(events, ["agent_start", "message_update", "agent_end"]);
  assert.deepEqual(await client.usage(), {
    requests: 2,
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    totalTokens: 18,
    costUsd: 0.02,
  });
  await client.dispose();
});
