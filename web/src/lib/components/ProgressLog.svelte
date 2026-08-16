<script lang="ts">
  import type { LiveProgressEvent } from "$lib/types";
  let { events }: { events: LiveProgressEvent[] } = $props();
</script>

<div class="progress-log">
  {#if events.length === 0}
    <p class="muted">Waiting for the first harness event…</p>
  {:else}
    {#each events.slice(-80).reverse() as event (event.sequence)}
      <div class="log-row">
        <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
        <span>{event.message}</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .progress-log { max-height: 390px; overflow: auto; padding: 4px 22px 18px; }
  .log-row { display: grid; grid-template-columns: 78px 1fr; gap: 13px; padding: 9px 0; border-bottom: 1px solid rgba(157,190,178,.08); font-size: 11px; line-height: 1.45; }
  .log-row:last-child { border-bottom: 0; }
  time { color: #688078; font-family: "SFMono-Regular", monospace; }
  span { color: #cbdcd6; }
</style>
