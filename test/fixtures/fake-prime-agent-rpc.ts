import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line) as { id: string; type: string; message?: string };
  if (request.type === "prompt") {
    console.log(JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true }));
    console.log(JSON.stringify({ type: "agent_start" }));
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" }, message: { role: "assistant", content: [] } }));
    console.log(JSON.stringify({ type: "agent_end", messages: [] }));
  } else if (request.type === "get_last_assistant_text") {
    console.log(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { text: "structured\u2028result" } }));
  } else if (request.type === "get_session_stats") {
    console.log(JSON.stringify({
      type: "response", id: request.id, command: request.type, success: true,
      data: { assistantMessages: 2, tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 1, total: 18 }, cost: 0.02 },
    }));
  } else if (request.type === "get_state") {
    console.log(JSON.stringify({
      type: "response", id: request.id, command: request.type, success: true,
      data: { telemetry: process.env.PRIME_AGENT_TELEMETRY },
    }));
  } else {
    console.log(JSON.stringify({ type: "response", id: request.id, command: request.type, success: false, error: "unsupported" }));
  }
}
