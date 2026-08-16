<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AgentTranscriptEntry, AgentTranscriptKind, AgentTranscriptSnapshot } from "$lib/types";
  import MarkdownContent from "./MarkdownContent.svelte";
  import ToolEvent from "./ToolEvent.svelte";

  let { experimentId }: { experimentId: string } = $props();
  let entries = $state<AgentTranscriptEntry[]>([]);
  let active = $state(false);
  let connection = $state<"connecting" | "live" | "offline">("connecting");
  let error = $state<string | null>(null);
  let filter = $state<"all" | "thinking" | "messages" | "tools" | "system">("all");
  let follow = $state(true);
  let terminal: HTMLDivElement | undefined = $state();

  const filteredEntries = $derived(entries.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "thinking") return entry.kind === "thinking";
    if (filter === "messages") return entry.kind === "message" || entry.kind === "prompt";
    if (filter === "tools") return entry.kind === "tool" || entry.kind === "tool_result";
    return entry.kind === "lifecycle" || entry.kind === "error";
  }));

  function applyEntry(entry: AgentTranscriptEntry): void {
    const index = entries.findIndex((candidate) => candidate.id === entry.id);
    if (index === -1) entries = [...entries, entry].sort((left, right) => left.sequence - right.sequence);
    else entries = entries.map((candidate, candidateIndex) => candidateIndex === index ? entry : candidate);
  }

  function applySnapshot(snapshot: AgentTranscriptSnapshot): void {
    entries = snapshot.entries;
    active = snapshot.active;
  }

  function filterCount(kinds: AgentTranscriptKind[]): number {
    return entries.filter((entry) => kinds.includes(entry.kind)).length;
  }

  function jumpToLatest(): void {
    follow = true;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }

  function relatedToolCall(entry: AgentTranscriptEntry): AgentTranscriptEntry | undefined {
    if (!entry.toolCallId || entry.kind === "tool") return undefined;
    return entries.find((candidate) => candidate.kind === "tool" && candidate.toolCallId === entry.toolCallId);
  }

  $effect(() => {
    filteredEntries.length;
    filteredEntries.at(-1)?.updatedAt;
    if (!follow) return;
    void tick().then(() => {
      if (terminal) terminal.scrollTop = terminal.scrollHeight;
    });
  });

  onMount(() => {
    let disposed = false;
    let source: EventSource | undefined;
    const connect = () => {
      if (disposed) return;
      source = new EventSource(`/api/experiments/${encodeURIComponent(experimentId)}/transcript/events`);
      source.addEventListener("snapshot", (event) => applySnapshot(JSON.parse((event as MessageEvent<string>).data) as AgentTranscriptSnapshot));
      source.addEventListener("entry", (event) => applyEntry(JSON.parse((event as MessageEvent<string>).data) as AgentTranscriptEntry));
      source.onopen = () => connection = "live";
      source.onerror = () => connection = "offline";
    };
    void fetch(`/api/experiments/${encodeURIComponent(experimentId)}/transcript`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? response.statusText);
        return response.json() as Promise<AgentTranscriptSnapshot>;
      })
      .then((snapshot) => applySnapshot(snapshot))
      .catch((reason: Error) => error = reason.message)
      .finally(connect);
    return () => {
      disposed = true;
      source?.close();
    };
  });
</script>

<section class="card transcript-card motion-enter" style="--motion-delay: 90ms">
  <div class="card-header transcript-header">
    <div>
      <h2>Agent activity</h2>
      <p class="muted">Timestamped thinking, messages, tool calls, results and file edits.</p>
    </div>
    <div class="transcript-status">
      <span class="pill" class:improvement={connection === "live"} class:regression={connection === "offline"}>
        {#if connection === "live"}<i class="live-dot"></i>{/if}{active ? connection : "recorded"}
      </span>
      <span class="pill">{entries.length} entries</span>
    </div>
  </div>

  <div class="transcript-toolbar">
    <div class="filters" aria-label="Transcript filters">
      <button class:active={filter === "all"} onclick={() => filter = "all"}>All <span>{entries.length}</span></button>
      <button class:active={filter === "thinking"} onclick={() => filter = "thinking"}>Thinking <span>{filterCount(["thinking"])}</span></button>
      <button class:active={filter === "messages"} onclick={() => filter = "messages"}>Messages <span>{filterCount(["message", "prompt"])}</span></button>
      <button class:active={filter === "tools"} onclick={() => filter = "tools"}>Tools <span>{filterCount(["tool", "tool_result"])}</span></button>
      <button class:active={filter === "system"} onclick={() => filter = "system"}>System <span>{filterCount(["lifecycle", "error"])}</span></button>
    </div>
    <button class="follow" class:active={follow} onclick={jumpToLatest}>{follow ? "Following live" : "Jump to latest"}</button>
  </div>

  <div
    class="transcript-terminal"
    bind:this={terminal}
    onscroll={() => {
      if (!terminal) return;
      follow = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 48;
    }}
  >
    {#if error && entries.length === 0}
      <div class="transcript-empty regression">{error}</div>
    {:else if entries.length === 0}
      <div class="transcript-empty"><span class="terminal-caret">›</span> Waiting for the first agent event…</div>
    {:else if filteredEntries.length === 0}
      <div class="transcript-empty">No entries match this filter.</div>
    {:else}
      {#each filteredEntries as entry (entry.id)}
        <article class="transcript-entry {entry.kind}" class:error-entry={entry.isError}>
          <div class="entry-rail"><span></span></div>
          <div class="entry-main">
            <header>
              <time title={new Date(entry.timestamp).toLocaleString()}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
              <span class="actor {entry.actor}">{entry.actor}</span>
              <span class="phase">{entry.phase.replace("_", " ")}</span>
              <b>{entry.title}</b>
            </header>
            {#if entry.content}
              {#if entry.kind === "prompt"}
                <details><summary>Show prompt</summary><pre>{entry.content}</pre></details>
              {:else}
                <MarkdownContent source={entry.content} tone={entry.kind === "thinking" ? "thinking" : "default"} />
              {/if}
            {/if}
            {#if (entry.kind === "tool" || entry.kind === "tool_result") && entry.data !== undefined}
              <ToolEvent {entry} callEntry={relatedToolCall(entry)} />
            {/if}
          </div>
        </article>
      {/each}
    {/if}
  </div>
</section>

<style>
  .transcript-card { min-width: 0; margin-bottom: 13px; overflow: hidden; }
  .transcript-header { align-items: flex-start; }
  .transcript-status { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .live-dot { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(93,225,158,.09); animation: transcript-pulse 1.8s ease-out infinite; }
  .transcript-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 20px; border-top: 1px solid rgba(157,190,178,.08); border-bottom: 1px solid rgba(157,190,178,.1); background: rgba(2,12,9,.38); }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; }
  button { border: 1px solid transparent; border-radius: 7px; padding: 7px 10px; color: var(--muted); background: transparent; font: inherit; font-size: 10px; font-weight: 700; letter-spacing: .04em; cursor: pointer; transition: color .2s, border-color .2s, background .2s; }
  button:hover, button.active { color: var(--text); border-color: rgba(93,225,158,.2); background: rgba(93,225,158,.07); }
  button span { margin-left: 4px; color: #657d75; font-family: "SFMono-Regular", monospace; }
  .follow { flex: 0 0 auto; border-color: rgba(157,190,178,.12); }
  .transcript-terminal { height: min(68vh, 820px); min-height: 420px; overflow: auto; overscroll-behavior: contain; padding: 10px 18px 22px; background: #020a08; scroll-behavior: smooth; }
  .transcript-entry { display: grid; grid-template-columns: 18px minmax(0, 1fr); animation: transcript-enter .24s var(--ease-out) both; }
  .entry-rail { position: relative; }
  .entry-rail::before { content: ""; position: absolute; top: 0; bottom: 0; left: 7px; width: 1px; background: rgba(157,190,178,.1); }
  .entry-rail span { position: absolute; top: 18px; left: 4px; z-index: 1; width: 7px; height: 7px; border: 1px solid #527169; border-radius: 50%; background: #07130f; }
  .thinking .entry-rail span { border-color: #8f7edb; box-shadow: 0 0 12px rgba(143,126,219,.32); }
  .message .entry-rail span { border-color: var(--green); }
  .tool .entry-rail span, .tool_result .entry-rail span { border-color: #d6a94e; }
  .error-entry .entry-rail span { border-color: var(--red); }
  .entry-main { min-width: 0; padding: 11px 8px 13px; border-bottom: 1px solid rgba(157,190,178,.07); }
  header { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; margin-bottom: 7px; font-size: 10px; }
  time { color: #5f766e; font-family: "SFMono-Regular", monospace; }
  header b { min-width: 0; color: #d9e8e3; font-size: 11px; overflow-wrap: anywhere; }
  .actor, .phase { border-radius: 4px; padding: 2px 5px; color: #82a197; background: rgba(157,190,178,.07); font-size: 8px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .actor.implementer { color: var(--green); background: rgba(93,225,158,.08); }
  .actor.reviewer { color: #e7bc62; background: rgba(231,188,98,.08); }
  .actor.harness { color: #6ea8e8; background: rgba(110,168,232,.08); }
  pre { max-width: 100%; margin: 0; color: #bfd1cb; font: 10.5px/1.58 "SFMono-Regular", Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  details { min-width: 0; margin-top: 7px; border: 1px solid rgba(157,190,178,.1); border-radius: 7px; background: rgba(9,25,20,.52); }
  summary { padding: 8px 10px; color: #829c93; font-size: 9px; font-weight: 700; letter-spacing: .06em; cursor: pointer; text-transform: uppercase; }
  details pre { max-height: 420px; overflow: auto; padding: 10px 12px 13px; border-top: 1px solid rgba(157,190,178,.08); }
  .transcript-empty { display: flex; align-items: center; justify-content: center; min-height: 380px; color: var(--muted); font: 11px "SFMono-Regular", monospace; }
  .terminal-caret { margin-right: 9px; color: var(--green); animation: caret-blink 1s steps(2) infinite; }
  @keyframes transcript-enter { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes transcript-pulse { 60%, 100% { box-shadow: 0 0 0 10px rgba(93,225,158,0); } }
  @keyframes caret-blink { 50% { opacity: .25; } }
  @media (max-width: 760px) {
    .transcript-toolbar { align-items: flex-start; flex-direction: column; }
    .transcript-terminal { height: 66vh; min-height: 360px; padding-inline: 10px; }
    .follow { align-self: stretch; }
  }
</style>
