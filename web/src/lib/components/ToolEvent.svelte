<script lang="ts">
  import type { AgentTranscriptEntry } from "$lib/types";

  let { entry, callEntry }: { entry: AgentTranscriptEntry; callEntry?: AgentTranscriptEntry } = $props();

  type ObjectValue = Record<string, unknown>;
  type ToolKind = "list" | "read" | "replace" | "write" | "unknown";

  const toolName = $derived(entry.toolName ?? callEntry?.toolName ?? "unknown_tool");
  const kind = $derived<ToolKind>(toolName.endsWith("_list") ? "list"
    : toolName.endsWith("_read") ? "read"
    : toolName === "research_replace" ? "replace"
    : toolName === "research_write" ? "write"
    : "unknown");
  const argumentsData = $derived(asObject(entry.kind === "tool" ? entry.data : callEntry?.data));
  const resultData = $derived(asObject(entry.kind === "tool_result" ? entry.data : undefined));
  const resultText = $derived(extractText(entry.kind === "tool_result" ? entry.data : undefined));
  const details = $derived(asObject(resultData?.details));
  const path = $derived(stringValue(argumentsData?.path) ?? stringValue(details?.path));
  const isResult = $derived(entry.kind === "tool_result");
  const isProgress = $derived(isResult && entry.title.endsWith(" progress"));

  function asObject(value: unknown): ObjectValue | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
  }

  function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  function extractText(value: unknown): string | undefined {
    const object = asObject(value);
    if (!object || !Array.isArray(object.content)) return typeof value === "string" ? value : undefined;
    const chunks = object.content
      .map((item) => asObject(item))
      .filter((item): item is ObjectValue => item !== undefined)
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string);
    return chunks.length > 0 ? chunks.join("\n") : undefined;
  }

  function formatData(value: unknown): string {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toolLabel(value: ToolKind): string {
    if (value === "list") return "Workspace files";
    if (value === "read") return "Read file";
    if (value === "replace") return "Edit file";
    if (value === "write") return "Write file";
    return "Tool event";
  }

  function toolGlyph(value: ToolKind): string {
    if (value === "list") return "LS";
    if (value === "read") return "RD";
    if (value === "replace") return "Δ";
    if (value === "write") return "WR";
    return "••";
  }
</script>

<div class="tool-card {kind}" class:result={isResult} class:failed={entry.isError} data-tool-kind={kind}>
  <div class="tool-heading">
    <span class="tool-glyph">{toolGlyph(kind)}</span>
    <div class="tool-identity">
      <strong>{toolLabel(kind)}</strong>
      <span>{toolName}</span>
    </div>
    {#if path}<code class="path">{path}</code>{/if}
    <span class="tool-state" class:success={isResult && !isProgress && !entry.isError} class:failure={entry.isError}>
      {entry.isError ? "failed" : isProgress ? "progress" : isResult ? "completed" : "running"}
    </span>
  </div>

  {#if kind === "replace" && !isResult}
    <div class="diff" aria-label="File edit">
      <div class="diff-block removed">
        <span class="diff-label">− Removed</span>
        <pre>{stringValue(argumentsData?.oldText) ?? ""}</pre>
      </div>
      <div class="diff-block added">
        <span class="diff-label">+ Added</span>
        <pre>{stringValue(argumentsData?.newText) ?? ""}</pre>
      </div>
    </div>
  {:else if kind === "write" && !isResult}
    <details class="tool-details" open>
      <summary>File content</summary>
      <pre class="file-content">{stringValue(argumentsData?.content) ?? ""}</pre>
    </details>
  {:else if kind === "read" && isResult && resultText}
    <details class="tool-details">
      <summary>File preview {#if typeof details?.bytes === "number"}<span>{details.bytes} bytes</span>{/if}</summary>
      <pre class="file-content">{resultText}</pre>
    </details>
  {:else if kind === "list" && isResult && resultText}
    <div class="file-list">
      {#each resultText.split("\n").filter(Boolean) as file}
        <span><i></i>{file}</span>
      {/each}
    </div>
  {:else if isResult && resultText}
    <div class="result-message" class:failure={entry.isError}>{resultText}</div>
  {:else if kind === "unknown"}
    <details class="tool-details" open={!isResult}>
      <summary>{isResult ? "Result details" : "Arguments"}</summary>
      <pre>{formatData(entry.data)}</pre>
    </details>
  {/if}
</div>

<style>
  .tool-card { min-width: 0; overflow: hidden; border: 1px solid rgba(214,169,78,.16); border-radius: 8px; background: linear-gradient(135deg, rgba(214,169,78,.055), rgba(6,19,15,.72) 35%); }
  .tool-card.result { border-color: rgba(157,190,178,.11); background: rgba(7,20,16,.6); }
  .tool-card.failed { border-color: rgba(255,103,103,.25); }
  .tool-heading { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 9px 11px; }
  .tool-glyph { display: grid; flex: 0 0 26px; width: 26px; height: 26px; place-items: center; border: 1px solid rgba(214,169,78,.25); border-radius: 6px; color: #e1b75f; background: rgba(214,169,78,.07); font: 750 8px "SFMono-Regular", monospace; }
  .tool-identity { display: flex; min-width: 104px; flex-direction: column; gap: 1px; }
  .tool-identity strong { color: #dae8e3; font-size: 10px; }
  .tool-identity span { color: #6e857d; font: 7.5px "SFMono-Regular", monospace; }
  .path { min-width: 0; overflow: hidden; border: 1px solid rgba(157,190,178,.1); border-radius: 5px; padding: 4px 7px; color: #a9c0b8; background: rgba(1,9,7,.55); font: 9px "SFMono-Regular", monospace; text-overflow: ellipsis; white-space: nowrap; }
  .tool-state { margin-left: auto; border-radius: 999px; padding: 3px 7px; color: #d9ac51; background: rgba(214,169,78,.07); font-size: 7px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .tool-state.success { color: var(--green); background: rgba(93,225,158,.07); }
  .tool-state.failure, .result-message.failure { color: var(--red); }
  .diff { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); border-top: 1px solid rgba(157,190,178,.08); }
  .diff-block { min-width: 0; padding: 8px 10px 10px; }
  .diff-block + .diff-block { border-left: 1px solid rgba(157,190,178,.08); }
  .diff-label { display: block; margin-bottom: 6px; font: 750 8px "SFMono-Regular", monospace; letter-spacing: .05em; text-transform: uppercase; }
  .removed { background: rgba(255,103,103,.035); }
  .removed .diff-label { color: #e07878; }
  .added { background: rgba(93,225,158,.035); }
  .added .diff-label { color: var(--green); }
  pre { max-width: 100%; margin: 0; overflow: auto; color: #c6d7d1; font: 9.5px/1.55 "SFMono-Regular", Menlo, monospace; white-space: pre; }
  .tool-details { min-width: 0; border-top: 1px solid rgba(157,190,178,.08); }
  .tool-details summary { padding: 8px 11px; color: #879e96; font-size: 8px; font-weight: 750; letter-spacing: .06em; cursor: pointer; text-transform: uppercase; }
  .tool-details summary span { margin-left: 6px; color: #597069; font-family: "SFMono-Regular", monospace; font-weight: 500; text-transform: none; }
  .tool-details pre { max-height: 420px; padding: 10px 12px 13px; border-top: 1px solid rgba(157,190,178,.07); background: rgba(1,8,6,.55); }
  .file-list { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 11px 10px 46px; }
  .file-list span { display: flex; align-items: center; gap: 5px; border-radius: 4px; padding: 3px 6px; color: #9fb6ae; background: rgba(157,190,178,.055); font: 8.5px "SFMono-Regular", monospace; }
  .file-list i { width: 4px; height: 4px; border-radius: 1px; background: #6c887e; }
  .result-message { padding: 0 11px 10px 46px; color: #92aaa1; font: 9px/1.5 "SFMono-Regular", monospace; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .tool-heading { flex-wrap: wrap; }
    .path { order: 3; width: 100%; margin-left: 35px; }
    .diff { grid-template-columns: 1fr; }
    .diff-block + .diff-block { border-top: 1px solid rgba(157,190,178,.08); border-left: 0; }
    .file-list, .result-message { padding-left: 11px; }
  }
</style>
