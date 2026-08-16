<script lang="ts">
  import { page } from "$app/state";
  import { dashboard } from "$lib/live";
  import { campaignStatusTone, formatDuration, formatMetric, formatPercent, signedMetric } from "$lib/format";

  const id = $derived(page.params.id ?? "");
  const run = $derived($dashboard.run);
  const campaign = $derived(run?.campaign);
  const ticket = $derived(campaign?.tickets.find((candidate) => candidate.id === id));
  const kind = $derived(ticket?.kind ?? ticket?.type ?? "hypothesis");
  const primaryFormat = $derived(run?.primaryMetric?.format ?? "number");

  function formatDate(value: string | undefined): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
</script>

<a class="back motion-enter" style="--motion-delay: 20ms" href="/tickets">← Back to campaign tickets</a>

{#if !run}
  <section class="card empty motion-enter"><div><div class="loader"></div><p>Loading {id}…</p></div></section>
{:else if !campaign || !ticket}
  <section class="card empty motion-enter"><div><h2>Ticket unavailable</h2><p class="muted">{campaign ? `${id} does not exist in this campaign.` : "This run does not expose a research campaign."}</p><a class="overview-link" href="/">Return to overview</a></div></section>
{:else}
  <section class="detail-hero motion-enter" style="--motion-delay: 50ms">
    <div>
      <span class="eyebrow">Campaign ticket · {kind}</span>
      <h1>{ticket.id}</h1>
      <p class="muted">{ticket.title ?? `${kind} proposed by ${ticket.createdBy ?? "unknown"}`}</p>
    </div>
    <span class="pill {campaignStatusTone(ticket.status)}">{ticket.status}</span>
  </section>

  <section class="ticket-stats">
    <article class="card motion-enter" style="--motion-delay: 90ms"><span>Policy priority</span><strong>{formatMetric(ticket.priorityScore ?? ticket.priority)}</strong><small>queue ordering score</small></article>
    <article class="card motion-enter" style="--motion-delay: 125ms"><span>Expected improvement</span><strong>{signedMetric(ticket.expectedGain, primaryFormat)}</strong><small>primary metric Δ</small></article>
    <article class="card motion-enter" style="--motion-delay: 160ms"><span>Success probability</span><strong>{formatPercent(ticket.probabilityOfSuccess ?? ticket.probability, 0)}</strong><small>planner estimate</small></article>
    <article class="card motion-enter" style="--motion-delay: 195ms"><span>Information gain</span><strong>{formatMetric(ticket.informationGain)}</strong><small>research value</small></article>
    <article class="card motion-enter" style="--motion-delay: 230ms"><span>Estimated cost</span><strong>{formatMetric(ticket.estimatedCost)}</strong><small>relative budget units</small></article>
    {#if ticket.learnedPriority !== undefined}<article class="card motion-enter"><span>Learned priority</span><strong>{formatMetric(ticket.learnedPriority)}</strong><small>predicted Δ {signedMetric(ticket.predictedImprovement, primaryFormat)}</small></article>{/if}
    {#if ticket.predictedDurationMs !== undefined}<article class="card motion-enter"><span>Predicted duration</span><strong>{formatDuration(ticket.predictedDurationMs)}</strong><small>learned from similar tickets</small></article>{/if}
  </section>

  <section class="detail-grid">
    <article class="card hypothesis motion-enter" style="--motion-delay: 255ms">
      <div class="card-header"><div><h2>Hypothesis</h2><p class="muted">The pre-registered claim this ticket is intended to test.</p></div><span class="pill">{kind}</span></div>
      <div class="card-body"><p class="lead">{ticket.hypothesis}</p></div>
    </article>

    <article class="card lifecycle motion-enter" style="--motion-delay: 285ms">
      <div class="card-header"><div><h2>Lifecycle</h2><p class="muted">Ownership and queue timestamps.</p></div></div>
      <dl>
        <div><dt>Created</dt><dd>{formatDate(ticket.createdAt)}</dd></div>
        <div><dt>Updated</dt><dd>{formatDate(ticket.updatedAt)}</dd></div>
        <div><dt>Created by</dt><dd>{ticket.createdBy ?? "—"}</dd></div>
        <div><dt>Claimed by</dt><dd>{ticket.claimedBy ?? "—"}</dd></div>
      </dl>
    </article>
  </section>

  {#if ticket.searchSuggestion || ticket.ablation || ticket.merge || ticket.ensemble}
    <section class="operation-grid">
      {#if ticket.searchSuggestion}
        <article class="card operation motion-enter" style="--motion-delay: 310ms">
          <div class="card-header"><div><h2>Search parameters</h2><p class="muted">Concrete values proposed inside the configured search space.</p></div><span class="pill">search</span></div>
          <div class="card-body"><div class="parameter-list">{#each Object.entries(ticket.searchSuggestion) as [name, value]}<div><code>{name}</code><b>{String(value)}</b></div>{/each}</div></div>
        </article>
      {/if}
      {#if ticket.ablation}
        <article class="card operation motion-enter" style="--motion-delay: 330ms">
          <div class="card-header"><div><h2>Ablation plan</h2><p class="muted">Isolates the contribution of a selected change.</p></div><span class="pill warning">ablation</span></div>
          <div class="card-body"><p><span>Source experiment</span><a href={`/experiments/${ticket.ablation.sourceExperimentId}`}>{ticket.ablation.sourceExperimentId} →</a></p><p><span>Path to remove</span><code>{ticket.ablation.removePath}</code></p></div>
        </article>
      {/if}
      {#if ticket.merge}
        <article class="card operation motion-enter" style="--motion-delay: 350ms">
          <div class="card-header"><div><h2>Merge plan</h2><p class="muted">Tests whether changes from independent branches compose.</p></div><span class="pill warning">merge</span></div>
          <div class="card-body"><p><span>Source experiments</span>{#each ticket.merge.sourceExperimentIds as sourceId}<a href={`/experiments/${sourceId}`}>{sourceId} →</a>{/each}</p><p><span>Paths from second source</span>{#if ticket.merge.pathsFromSecond.length}<span class="tags">{#each ticket.merge.pathsFromSecond as path}<code>{path}</code>{/each}</span>{:else}<b>—</b>{/if}</p></div>
        </article>
      {/if}
      {#if ticket.ensemble}
        <article class="card operation motion-enter">
          <div class="card-header"><div><h2>Ensemble sources</h2><p class="muted">Complementary retained checkpoints available to the agent.</p></div><span class="pill warning">ensemble</span></div>
          <div class="card-body"><p><span>Source experiments</span>{#each ticket.ensemble.sourceExperimentIds as sourceId}<a href={`/experiments/${sourceId}`}>{sourceId} →</a>{/each}</p></div>
        </article>
      {/if}
    </section>
  {/if}

  <section class="relationship-grid">
    <article class="card relationships motion-enter" style="--motion-delay: 375ms">
      <div class="card-header"><div><h2>Dependencies</h2><p class="muted">Tickets that must inform or precede this work.</p></div><span class="pill">{ticket.dependencies.length}</span></div>
      <div class="card-body">
        {#if ticket.dependencies.length}
          <div class="dependency-list">{#each ticket.dependencies as dependency}<a href={`/tickets/${dependency}`}>{dependency}<span>Open ticket →</span></a>{/each}</div>
        {:else}<p class="muted">This ticket has no declared dependencies.</p>{/if}
      </div>
    </article>

    <article class="card outcome motion-enter" style="--motion-delay: 405ms">
      <div class="card-header"><div><h2>Outcome</h2><p class="muted">Execution result or reason the ticket cannot proceed.</p></div></div>
      <div class="card-body">
        {#if ticket.resultExperimentId}
          <a class="result-link" href={`/experiments/${ticket.resultExperimentId}`}><span>Result experiment</span><b>{ticket.resultExperimentId}</b><i>Open result →</i></a>
        {:else if ticket.blockedReason || ticket.cancellationReason}
          <div class="reason"><span>{ticket.blockedReason ? "Blocked" : "Cancelled"}</span><p>{ticket.blockedReason ?? ticket.cancellationReason}</p></div>
        {:else}
          <p class="muted">No result is attached yet. The ticket is currently {ticket.status}.</p>
        {/if}
      </div>
    </article>
  </section>

  <section class="card campaign-context motion-enter" style="--motion-delay: 435ms">
    <div class="card-header"><div><h2>Campaign context</h2><p class="muted">The research objective used when this ticket was prioritized.</p></div><span class="pill">{campaign.tickets.length} tickets</span></div>
    <div class="card-body"><p>{campaign.goal}</p><small class="mono">{campaign.id}</small></div>
  </section>
{/if}

<style>
  .back { display: inline-block; margin: 2px 0 24px; color: var(--muted); font-size: 12px; }
  .back:hover, .overview-link:hover { color: var(--text); }
  .overview-link { display: inline-block; margin-top: 8px; color: var(--blue); font-size: 12px; }
  .detail-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 22px; margin-bottom: 24px; }
  .detail-hero h1 { margin-bottom: 5px; }
  .detail-hero p { margin: 0; overflow-wrap: anywhere; font-size: 12px; }
  .ticket-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 13px; margin-bottom: 13px; }
  .ticket-stats article { min-width: 0; padding: 18px; }
  .ticket-stats span, .ticket-stats small { display: block; color: var(--muted); }
  .ticket-stats span { margin-bottom: 9px; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .ticket-stats strong { display: block; overflow: hidden; margin-bottom: 5px; font-family: "SFMono-Regular", monospace; font-size: 20px; text-overflow: ellipsis; white-space: nowrap; }
  .ticket-stats small { font-size: 9px; }
  .detail-grid { display: grid; grid-template-columns: 1.35fr .65fr; gap: 13px; margin-bottom: 13px; }
  .detail-grid > *, .relationship-grid > *, .operation-grid > * { min-width: 0; }
  .lead { overflow-wrap: anywhere; margin: 0; color: var(--text); font-size: 16px; line-height: 1.7; word-break: break-word; }
  dl { margin: 12px 22px 20px; }
  dl > div { display: flex; justify-content: space-between; gap: 15px; padding: 9px 0; border-bottom: 1px solid rgba(157,190,178,.08); }
  dl > div:last-child { border-bottom: 0; }
  dt { color: var(--muted); font-size: 10px; }
  dd { overflow-wrap: anywhere; margin: 0; color: #ceddd8; font-family: "SFMono-Regular", monospace; font-size: 10px; text-align: right; }
  .operation-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; margin-bottom: 13px; }
  .parameter-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .parameter-list > div { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; padding: 10px; border: 1px solid rgba(157,190,178,.1); border-radius: 8px; background: rgba(3,10,8,.3); }
  .parameter-list code { overflow-wrap: anywhere; color: var(--muted); font-size: 9px; word-break: break-word; }
  .parameter-list b { flex: 0 0 auto; color: #d5e2de; font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .operation .card-body p { overflow-wrap: anywhere; margin: 0 0 16px; color: #c2d4ce; font-size: 12px; word-break: break-word; }
  .operation .card-body p:last-child { margin-bottom: 0; }
  .operation .card-body p > span:first-child { display: block; margin-bottom: 7px; color: var(--muted); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
  .operation a { display: inline-block; margin-right: 12px; color: var(--blue); font-family: "SFMono-Regular", monospace; }
  .operation a:hover { text-decoration: underline; }
  .tags { display: flex; flex-wrap: wrap; gap: 7px; }
  .tags code, .operation p > code { max-width: 100%; overflow-wrap: anywhere; padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; color: #c7d8d2; background: rgba(3,10,8,.45); font-size: 10px; word-break: break-word; }
  .relationship-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; margin-bottom: 13px; }
  .dependency-list { display: grid; gap: 7px; }
  .dependency-list a { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; color: var(--blue); font-family: "SFMono-Regular", monospace; font-size: 10px; background: rgba(3,10,8,.26); transition: border-color .2s, transform .2s var(--ease-out); }
  .dependency-list a span { color: var(--muted); font-family: Inter, sans-serif; font-size: 9px; }
  .dependency-list a:hover { border-color: rgba(115,170,248,.35); transform: translateX(2px); }
  .result-link { display: grid; grid-template-columns: 1fr auto; gap: 5px 12px; padding: 14px; border: 1px solid rgba(93,225,158,.2); border-radius: 10px; background: rgba(93,225,158,.045); }
  .result-link span { color: var(--muted); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
  .result-link b { grid-column: 1; color: var(--green); font-family: "SFMono-Regular", monospace; font-size: 15px; }
  .result-link i { grid-column: 2; grid-row: 1 / 3; align-self: center; color: var(--muted); font-size: 10px; font-style: normal; }
  .result-link:hover i { color: var(--green); }
  .reason { padding: 13px; border: 1px solid rgba(255,116,116,.2); border-radius: 10px; background: rgba(255,116,116,.045); }
  .reason span { color: var(--red); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .reason p { overflow-wrap: anywhere; margin: 8px 0 0; color: #d5c3c1; font-size: 12px; line-height: 1.55; word-break: break-word; }
  .campaign-context { margin-bottom: 12px; }
  .campaign-context .card-body p { overflow-wrap: anywhere; margin-bottom: 12px; color: #bccfc8; font-size: 13px; line-height: 1.6; word-break: break-word; }
  .campaign-context small { color: #6f8980; font-size: 9px; }
  @media (max-width: 1080px) { .ticket-stats { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 820px) { .detail-grid, .relationship-grid, .operation-grid { grid-template-columns: 1fr; } .ticket-stats { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .detail-hero { align-items: flex-start; flex-direction: column; } .ticket-stats, .parameter-list { grid-template-columns: 1fr; } }
</style>
