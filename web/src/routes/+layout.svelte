<script lang="ts">
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { connectDashboard, connection, dashboard } from "$lib/live";
  import "@xyflow/svelte/dist/style.css";
  import "../app.css";

  let { children }: { children: Snippet } = $props();

  onMount(connectDashboard);
</script>

<svelte:head>
  <title>{$dashboard.run?.name ? `${$dashboard.run.name} · Autoresearch` : "ML Autoresearch"}</title>
</svelte:head>

<div class="shell">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Autoresearch dashboard">
      <span class="brand-mark">AR</span>
      <span>
        <strong>ML Autoresearch</strong>
        <small>{$dashboard.run?.name ?? "Initializing research run"}</small>
      </span>
    </a>
    <nav>
      <a class:active={page.url.pathname === "/"} href="/">Overview</a>
      {#if $dashboard.run?.campaign}
        <a class:active={page.url.pathname.startsWith("/tickets")} href="/tickets">Tickets</a>
      {/if}
      <span class="connection {$connection}"><i></i>{$connection}</span>
    </nav>
  </header>

  <main>
    {#key page.url.pathname}
      <div class="route-content">{@render children()}</div>
    {/key}
  </main>
</div>
