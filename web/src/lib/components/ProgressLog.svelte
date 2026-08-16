<script lang="ts">
  import type { LiveProgressEvent } from "$lib/types";
  let { events }: { events: LiveProgressEvent[] } = $props();
</script>

<div class="progress-log">
  {#if events.length === 0}
    <p class="muted">Waiting for the first harness event…</p>
  {:else}
    {#each events.slice(-80).reverse() as event, index (event.sequence)}
      <div class="log-row" class:latest={index === 0}>
        <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
        <span>{event.message}</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .progress-log { min-width: 0; max-height: 390px; overflow-x: hidden; overflow-y: auto; padding: 4px 22px 18px; }
  .log-row { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 13px; min-width: 0; padding: 9px 7px; border-bottom: 1px solid rgba(157,190,178,.08); border-radius: 7px; font-size: 11px; line-height: 1.45; animation: log-enter .32s var(--ease-out) both; }
  .log-row.latest { animation: log-enter .32s var(--ease-out) both, latest-event 1.25s var(--ease-standard) both; }
  .log-row:last-child { border-bottom: 0; }
  time { color: #688078; font-family: "SFMono-Regular", monospace; }
  span { min-width: 0; color: #cbdcd6; overflow-wrap: anywhere; white-space: pre-wrap; word-break: break-word; }
  @keyframes log-enter { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes latest-event { 0%, 38% { background: rgba(93,225,158,.1); } 100% { background: transparent; } }
</style>
