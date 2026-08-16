<script lang="ts">
  import { dashboard } from "$lib/live";
  import { campaignStatusTone, formatMetric, formatPercent, signedMetric } from "$lib/format";
  import type { CampaignTicket } from "$lib/types";

  type TicketFilter = "all" | CampaignTicket["status"];

  let statusFilter = $state<TicketFilter>("all");
  const run = $derived($dashboard.run);
  const campaign = $derived(run?.campaign);
  const tickets = $derived(campaign?.tickets ?? []);
  const primaryFormat = $derived(run?.primaryMetric?.format ?? "number");
  const filters: { value: TicketFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "queued", label: "Queued" },
    { value: "running", label: "Running" },
    { value: "completed", label: "Completed" },
    { value: "blocked", label: "Blocked" },
    { value: "cancelled", label: "Cancelled" },
  ];
  const visibleTickets = $derived.by(() => [...tickets]
    .filter((ticket) => statusFilter === "all" || ticket.status === statusFilter)
    .sort((left, right) => {
      const priorityDelta = (right.priorityScore ?? right.priority ?? 0) - (left.priorityScore ?? left.priority ?? 0);
      return priorityDelta || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    }));

  function count(status: TicketFilter): number {
    return status === "all" ? tickets.length : tickets.filter((ticket) => ticket.status === status).length;
  }
</script>

<a class="back motion-enter" style="--motion-delay: 20ms" href="/">← Back to overview</a>

{#if !run}
  <section class="card empty motion-enter"><div><div class="loader"></div><p>Loading campaign tickets…</p></div></section>
{:else if !campaign}
  <section class="card empty motion-enter"><div><h2>No research campaign</h2><p class="muted">This run does not expose a campaign queue.</p><a class="overview-link" href="/">Return to overview</a></div></section>
{:else}
  <section class="ticket-hero motion-enter" style="--motion-delay: 50ms">
    <div>
      <span class="eyebrow">Research campaign</span>
      <h1>Campaign tickets</h1>
      <p class="muted">{campaign.goal}</p>
      <small class="mono">{campaign.id}</small>
    </div>
    <span class="pill">{tickets.length} total</span>
  </section>

  <section class="ticket-stats">
    <article class="card motion-enter" style="--motion-delay: 90ms"><span>Queued</span><strong>{count("queued")}</strong><small>ready for selection</small></article>
    <article class="card motion-enter" style="--motion-delay: 125ms"><span>Running</span><strong class="improvement">{count("running")}</strong><small>currently claimed</small></article>
    <article class="card motion-enter" style="--motion-delay: 160ms"><span>Completed</span><strong>{count("completed")}</strong><small>linked to results</small></article>
    <article class="card motion-enter" style="--motion-delay: 195ms"><span>Blocked / cancelled</span><strong class={count("blocked") > 0 ? "regression" : "neutral"}>{count("blocked") + count("cancelled")}</strong><small>not currently executable</small></article>
  </section>

  <section class="card ticket-browser motion-enter" style="--motion-delay: 220ms">
    <div class="browser-header">
      <div><h2>Ticket browser</h2><p class="muted">Sorted by policy priority. Open a ticket to inspect its evidence path, dependencies and operation parameters.</p></div>
      <span class="pill">{visibleTickets.length} shown</span>
    </div>
    <div class="filters" aria-label="Filter tickets by status">
      {#each filters as filter}
        <button class:active={statusFilter === filter.value} onclick={() => statusFilter = filter.value}>
          {filter.label}<span>{count(filter.value)}</span>
        </button>
      {/each}
    </div>
    <div class="ticket-list">
      {#each visibleTickets as ticket, index (ticket.id)}
        <a class="ticket-card" href={`/tickets/${ticket.id}`} style={`--row-delay: ${Math.min(index * 28, 300)}ms`}>
          <div class="ticket-main">
            <div class="ticket-identity"><span class="ticket-kind">{ticket.kind ?? ticket.type ?? "hypothesis"}</span><b>{ticket.id}</b>{#if ticket.title}<span>{ticket.title}</span>{/if}</div>
            <p>{ticket.hypothesis}</p>
            <div class="ticket-context">
              <span>{ticket.dependencies.length} dependencies</span>
              <span>created by {ticket.createdBy ?? "unknown"}</span>
              {#if ticket.resultExperimentId}<span class="result">result {ticket.resultExperimentId}</span>{/if}
            </div>
          </div>
          <div class="ticket-metrics">
            <div><span>priority</span><b>{formatMetric(ticket.priorityScore ?? ticket.priority)}</b></div>
            <div><span>expected Δ</span><b>{signedMetric(ticket.expectedGain, primaryFormat)}</b></div>
            <div><span>success</span><b>{formatPercent(ticket.probabilityOfSuccess ?? ticket.probability, 0)}</b></div>
            <div><span>information</span><b>{formatMetric(ticket.informationGain)}</b></div>
          </div>
          <div class="ticket-state"><span class="pill {campaignStatusTone(ticket.status)}">{ticket.status}</span><i aria-hidden="true">→</i></div>
        </a>
      {:else}
        <div class="empty-filter"><p>No tickets match this status.</p><button onclick={() => statusFilter = "all"}>Show all tickets</button></div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .back { display: inline-block; margin: 2px 0 24px; color: var(--muted); font-size: 12px; }
  .back:hover, .overview-link:hover { color: var(--text); }
  .overview-link { display: inline-block; margin-top: 8px; color: var(--blue); font-size: 12px; }
  .ticket-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
  .ticket-hero > div { min-width: 0; }
  .ticket-hero h1 { margin-bottom: 7px; }
  .ticket-hero p { max-width: 920px; overflow-wrap: anywhere; margin-bottom: 7px; font-size: 13px; line-height: 1.55; }
  .ticket-hero small { display: block; color: #69837a; overflow-wrap: anywhere; font-size: 9px; }
  .ticket-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 13px; margin-bottom: 13px; }
  .ticket-stats article { min-width: 0; padding: 18px; }
  .ticket-stats span, .ticket-stats small { display: block; color: var(--muted); }
  .ticket-stats span { margin-bottom: 8px; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .ticket-stats strong { display: block; margin-bottom: 5px; font-family: "SFMono-Regular", monospace; font-size: 24px; }
  .ticket-stats small { font-size: 10px; }
  .ticket-browser { min-width: 0; overflow: hidden; }
  .browser-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 20px 22px 0; }
  .browser-header p { margin: 0; font-size: 11px; }
  .filters { display: flex; flex-wrap: wrap; gap: 7px; padding: 18px 22px 12px; border-bottom: 1px solid rgba(157,190,178,.09); }
  .filters button, .empty-filter button { border: 1px solid var(--border); border-radius: 999px; color: var(--muted); background: rgba(3,10,8,.32); cursor: pointer; font-size: 10px; transition: border-color .2s, color .2s, background .2s; }
  .filters button { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; }
  .filters button span { display: grid; min-width: 18px; height: 18px; place-items: center; border-radius: 999px; background: rgba(157,190,178,.08); font-family: "SFMono-Regular", monospace; font-size: 8px; }
  .filters button:hover, .filters button.active { border-color: rgba(93,225,158,.35); color: var(--green); background: rgba(93,225,158,.07); }
  .ticket-list { padding: 5px 22px 14px; }
  .ticket-card { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(360px, .8fr) auto; align-items: center; gap: 20px; min-width: 0; padding: 17px 4px; border-bottom: 1px solid rgba(157,190,178,.09); animation: ticket-enter .42s var(--ease-out) both; animation-delay: var(--row-delay); transition: background .2s var(--ease-standard); }
  .ticket-card:last-child { border-bottom: 0; }
  .ticket-card:hover { background: rgba(93,225,158,.035); }
  .ticket-main { min-width: 0; }
  .ticket-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ticket-identity b { flex: 0 0 auto; font-family: "SFMono-Regular", monospace; font-size: 12px; }
  .ticket-identity > span:last-child:not(.ticket-kind) { overflow: hidden; color: #c2d3cd; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .ticket-kind { flex: 0 0 auto; color: var(--amber); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .ticket-main > p { display: -webkit-box; overflow: hidden; margin: 8px 0; color: #adc2bb; font-size: 12px; line-height: 1.5; line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
  .ticket-context { display: flex; flex-wrap: wrap; gap: 6px 14px; color: #708b82; font-size: 9px; }
  .ticket-context .result { color: var(--blue); }
  .ticket-metrics { display: grid; grid-template-columns: repeat(4, minmax(70px, 1fr)); gap: 8px; }
  .ticket-metrics > div { min-width: 0; padding: 9px; border: 1px solid rgba(157,190,178,.1); border-radius: 8px; background: rgba(3,10,8,.24); }
  .ticket-metrics span, .ticket-metrics b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ticket-metrics span { margin-bottom: 5px; color: var(--muted); font-size: 8px; letter-spacing: .06em; text-transform: uppercase; }
  .ticket-metrics b { font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .ticket-state { display: flex; align-items: center; gap: 11px; }
  .ticket-state i { color: var(--muted); font-style: normal; transition: color .2s, transform .2s var(--ease-out); }
  .ticket-card:hover .ticket-state i { color: var(--green); transform: translateX(3px); }
  .empty-filter { padding: 45px 0; text-align: center; }
  .empty-filter p { color: var(--muted); }
  .empty-filter button { padding: 7px 11px; }
  @keyframes ticket-enter { from { opacity: 0; transform: translateX(-7px); } to { opacity: 1; transform: translateX(0); } }
  @media (max-width: 1180px) { .ticket-card { grid-template-columns: minmax(0, 1fr) auto; } .ticket-metrics { grid-column: 1 / -1; grid-row: 2; } .ticket-state { grid-column: 2; grid-row: 1; } }
  @media (max-width: 780px) { .ticket-stats { grid-template-columns: repeat(2, 1fr); } .ticket-hero { align-items: flex-start; flex-direction: column; } .ticket-card { gap: 12px; } .ticket-metrics { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 520px) { .ticket-stats { grid-template-columns: 1fr; } .browser-header { align-items: flex-start; flex-direction: column; } .ticket-state .pill { display: none; } }
</style>
