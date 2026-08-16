<script lang="ts">
  import { page } from "$app/state";
  import { dashboard } from "$lib/live";
  import { comparisonTone, formatConfidence, formatDuration, formatMetric, formatPercent, formatUsd, improvementClass, signedMetric, statusTone } from "$lib/format";
  import type { ExperimentDetail } from "$lib/types";

  let detail = $state<ExperimentDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  const id = $derived(page.params.id);
  const liveExperiment = $derived($dashboard.run?.experiments.find((experiment) => experiment.id === id));
  const experiment = $derived(liveExperiment ?? detail?.experiment);
  const metricName = $derived($dashboard.run?.primaryMetric?.name ?? (experiment ? Object.keys(experiment.evaluation.aggregatedMetrics)[0] : undefined) ?? "primary");
  const metricStatistics = $derived(experiment?.evaluation.statistics?.[metricName]);
  const statisticalComparison = $derived(experiment?.evaluation.statisticalComparison ?? experiment?.pairedEvaluation?.candidate.statisticalComparison);
  const campaignTicket = $derived($dashboard.run?.campaign?.tickets.find((ticket) => ticket.id === experiment?.ticketId));

  $effect(() => {
    const currentId = id;
    if (!currentId) return;
    loading = true;
    error = null;
    void fetch(`/api/experiments/${encodeURIComponent(currentId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? response.statusText);
        return response.json() as Promise<ExperimentDetail>;
      })
      .then((value) => detail = value)
      .catch((reason: Error) => error = reason.message)
      .finally(() => loading = false);
  });
</script>

<a class="back motion-enter" style="--motion-delay: 20ms" href="/">← Back to overview</a>

{#if loading && !experiment}
  <section class="card empty motion-enter"><div><div class="loader"></div><p>Loading {id}…</p></div></section>
{:else if error && !experiment}
  <section class="card empty motion-enter"><div><h2>Experiment unavailable</h2><p class="regression">{error}</p></div></section>
{:else if experiment}
  <section class="detail-hero motion-enter" style="--motion-delay: 50ms">
    <div><span class="eyebrow">Experiment detail</span><h1>{experiment.id}</h1><p class="muted">{experiment.plan?.changeCategory ?? "other"} · {experiment.strategy ?? "legacy"} from {experiment.parentId ?? "baseline"}{#if experiment.ticketId} · ticket {experiment.ticketId}{/if}</p></div>
    <span class="pill {statusTone(experiment.decision.status as Parameters<typeof statusTone>[0])}">{experiment.decision.status}</span>
  </section>

  <section class="detail-stats">
    <article class="card motion-enter" style="--motion-delay: 100ms"><span>{metricName}</span><strong>{formatMetric(experiment.evaluation.aggregatedMetrics[metricName])}</strong></article>
    <article class="card motion-enter" style="--motion-delay: 135ms"><span>Primary improvement</span><strong class={improvementClass(experiment.decision.primaryDelta)}>{signedMetric(experiment.decision.primaryDelta)}</strong><small>{formatPercent(experiment.accounting.relativePrimaryImprovement)} relative to parent</small></article>
    <article class="card motion-enter" style="--motion-delay: 170ms"><span>Duration</span><strong>{formatDuration(experiment.accounting.durationMs)}</strong><small>{formatDuration(experiment.accounting.evaluatorDurationMs)} evaluator</small></article>
    <article class="card motion-enter" style="--motion-delay: 205ms"><span>Evidence</span><strong>{metricStatistics?.count ?? experiment.evaluation.attempts.length} samples</strong><small>{formatConfidence(metricStatistics?.confidenceInterval, metricStatistics?.confidenceLevel)}</small></article>
    <article class="card motion-enter" style="--motion-delay: 240ms"><span>Compute saved</span><strong>{formatPercent(experiment.evaluation.computeSavedRatio)}</strong><small>{experiment.evaluation.stages?.length ?? 0} evaluation stages</small></article>
    <article class="card motion-enter" style="--motion-delay: 275ms"><span>Agent cost</span><strong>{formatUsd(experiment.accounting.agentUsage.costUsd)}</strong><small>{experiment.accounting.agentUsage.totalTokens.toLocaleString()} tokens · {experiment.accounting.agentUsage.requests} requests</small></article>
    <article class="card motion-enter" style="--motion-delay: 310ms"><span>Cost / improvement</span><strong>{formatUsd(experiment.accounting.costPerImprovementUsd)}</strong><small>per {metricName} unit</small></article>
    <article class="card motion-enter" style="--motion-delay: 345ms"><span>Time / improvement</span><strong>{experiment.accounting.timePerImprovementMs === null ? "—" : formatDuration(experiment.accounting.timePerImprovementMs)}</strong><small>per {metricName} unit</small></article>
  </section>

  <section class="detail-grid">
    <article class="card narrative motion-enter" style="--motion-delay: 240ms">
      <div class="card-header"><div><h2>Hypothesis</h2><p class="muted">Pre-registered intent and expected effect.</p></div></div>
      <div class="card-body">
        <p class="lead">{experiment.plan?.hypothesis ?? "No structured hypothesis."}</p>
        <h3>Expected effect</h3><p>{experiment.plan?.expectedEffect ?? "—"}</p>
        {#if detail?.proposal}<h3>Agent proposal</h3><pre>{detail.proposal}</pre>{/if}
      </div>
    </article>

    <article class="card decision motion-enter" style="--motion-delay: 275ms">
      <div class="card-header"><div><h2>Harness decision</h2><p class="muted">Deterministic policy outcome.</p></div></div>
      <div class="card-body">
        <ul>{#each experiment.decision.reasons as reason}<li>{reason}</li>{/each}</ul>
        <h3>Changed paths</h3>
        {#if experiment.changedPaths.length}<div class="tags">{#each experiment.changedPaths as changed}<code>{changed}</code>{/each}</div>{:else}<p class="muted">No workspace changes.</p>{/if}
        {#if experiment.duplicateOf || experiment.repeatedHypothesisOf}<h3>Duplicate evidence</h3><p>{experiment.duplicateOf ?? experiment.repeatedHypothesisOf}</p>{/if}
        {#if experiment.proposalReview}<h3>Reviewer</h3><div class="review-summary"><span class="pill {experiment.proposalReview.approved ? 'improvement' : 'regression'}">{experiment.proposalReview.approved ? "approved" : "blocked"}</span><p>{experiment.proposalReview.summary}</p>{#if experiment.proposalReview.concerns.length}<ul>{#each experiment.proposalReview.concerns as concern}<li>{concern}</li>{/each}</ul>{/if}</div>{/if}
        {#if campaignTicket}<h3>Campaign ticket</h3><div class="ticket-detail"><span class="mono">{campaignTicket.id}</span><span class="pill {campaignTicket.status === 'running' ? 'improvement' : campaignTicket.status === 'blocked' ? 'regression' : 'warning'}">{campaignTicket.status}</span><p>{campaignTicket.hypothesis}</p><small>priority {formatMetric(campaignTicket.priorityScore ?? campaignTicket.priority)} · information gain {formatMetric(campaignTicket.informationGain)}</small></div>{/if}
      </div>
    </article>
  </section>

  {#if experiment.plan?.searchSuggestion || experiment.plan?.ablation || experiment.plan?.merge}
    <section class="operation-grid">
      {#if experiment.plan.searchSuggestion}
        <article class="card operation-card motion-enter" style="--motion-delay: 295ms"><div class="card-header"><div><h2>Search suggestion</h2><p class="muted">Concrete parameter proposal generated inside the search space.</p></div><span class="pill">search</span></div><div class="card-body"><div class="tags">{#each Object.entries(experiment.plan.searchSuggestion) as [name, value]}<code>{name} = {String(value)}</code>{/each}</div></div></article>
      {/if}
      {#if experiment.plan.ablation}
        <article class="card operation-card motion-enter" style="--motion-delay: 315ms"><div class="card-header"><div><h2>Ablation</h2><p class="muted">Isolates the contribution of one change.</p></div><span class="pill warning">ablate</span></div><div class="card-body"><p><span class="muted">Source checkpoint</span><br><a class="experiment-link" href={`/experiments/${experiment.plan.ablation.sourceExperimentId}`}>{experiment.plan.ablation.sourceExperimentId}</a></p><p><span class="muted">Removed path</span><br><code>{experiment.plan.ablation.removePath}</code></p></div></article>
      {/if}
      {#if experiment.plan.merge}
        <article class="card operation-card motion-enter" style="--motion-delay: 335ms"><div class="card-header"><div><h2>Merge experiment</h2><p class="muted">Tests whether independent improvements compose.</p></div><span class="pill warning">merge</span></div><div class="card-body"><p><span class="muted">Source checkpoints</span><br>{#each experiment.plan.merge.sourceExperimentIds as sourceId, index}<a class="experiment-link" href={`/experiments/${sourceId}`}>{sourceId}</a>{#if index === 0} · {/if}{/each}</p><p><span class="muted">Paths from second source</span><br>{experiment.plan.merge.pathsFromSecond.join(", ") || "—"}</p></div></article>
      {/if}
    </section>
  {/if}

  <section class="card attempts motion-enter" style="--motion-delay: 310ms">
    <div class="card-header"><div><h2>Canonical evaluation attempts</h2><p class="muted">Seeds, timings and raw attempt metrics.</p></div><span class="pill {experiment.evaluation.ok ? 'improvement' : 'regression'}">{experiment.evaluation.ok ? "valid" : "failed"}</span></div>
    <div class="table-wrap">
      <table><thead><tr><th>Repetition</th><th>Seed</th><th>Duration</th><th>Exit</th><th>Metrics</th></tr></thead>
        <tbody>{#each experiment.evaluation.attempts as attempt, index}<tr class="attempt-row" style={`--row-delay: ${340 + index * 36}ms`}><td>{attempt.repetition + 1}</td><td class="mono">{attempt.seed}</td><td>{formatDuration(attempt.durationMs)}</td><td class:regression={attempt.exitCode !== 0}>{attempt.timedOut ? "timeout" : attempt.exitCode}</td><td class="mono">{Object.entries(attempt.metrics ?? {}).map(([name, value]) => `${name}=${formatMetric(value)}`).join(" · ") || attempt.error || "—"}</td></tr>{/each}</tbody>
      </table>
    </div>
  </section>

  {#if experiment.evaluation.stages?.length}
    <section class="card stages motion-enter" style="--motion-delay: 350ms">
      <div class="card-header"><div><h2>Evaluation stages</h2><p class="muted">Screening, canonical and confirmation budgets with early-pruning evidence.</p></div><span class="pill">{experiment.evaluation.stages.length} stages</span></div>
      <div class="table-wrap">
        <table><thead><tr><th>Stage</th><th>Budget</th><th>Samples</th><th>{metricName}</th><th>Confidence</th><th>Outcome</th></tr></thead>
          <tbody>{#each experiment.evaluation.stages as stage, index (stage.name)}
            <tr class="attempt-row" style={`--row-delay: ${350 + index * 36}ms`}>
              <td><b>{stage.name}</b></td>
              <td>{formatPercent(stage.budgetRatio, 0)}</td>
              <td>{stage.statistics[metricName]?.count ?? stage.attempts.length}</td>
              <td class="mono">{formatMetric(stage.aggregatedMetrics[metricName])}</td>
              <td class="mono">{formatConfidence(stage.statistics[metricName]?.confidenceInterval, stage.statistics[metricName]?.confidenceLevel)}</td>
              <td><span class="pill {stage.pruned ? 'regression' : stage.comparison ? comparisonTone(stage.comparison.status) : stage.ok ? 'improvement' : 'regression'}">{stage.pruned ? "pruned" : stage.comparison?.status ?? (stage.ok ? "complete" : "failed")}</span></td>
            </tr>
          {/each}</tbody>
        </table>
      </div>
    </section>
  {/if}

  {#if statisticalComparison}
    <section class="card statistical-card motion-enter" style="--motion-delay: 375ms">
      <div class="card-header"><div><h2>Statistical comparison</h2><p class="muted">A paired, direction-aware decision over independent repeated measurements.</p></div><span class="pill {comparisonTone(statisticalComparison.status)}">{statisticalComparison.status}</span></div>
      <div class="statistical-body">
        <div><span class="label">improvement</span><b class={improvementClass(statisticalComparison.improvement)}>{signedMetric(statisticalComparison.improvement)}</b></div>
        <div><span class="label">samples</span><b>{statisticalComparison.sampleCount}</b></div>
        <div><span class="label">confidence</span><b class="mono">{formatConfidence(statisticalComparison.confidenceInterval, statisticalComparison.confidenceLevel)}</b></div>
        <div><span class="label">thresholds</span><b class="mono">min {formatMetric(statisticalComparison.minimumDelta)} · eq {formatMetric(statisticalComparison.equivalenceMargin)}</b></div>
      </div>
    </section>
  {/if}

  {#if experiment.pairedEvaluation}
    <section class="card paired motion-enter" style="--motion-delay: 350ms">
      <div class="card-header"><div><h2>Fresh-seed confirmation</h2><p class="muted">Paired against {experiment.pairedEvaluation.referenceId} on seeds {experiment.pairedEvaluation.seeds.join(", ")}.</p></div><span class="pill {statusTone(experiment.pairedEvaluation.decision.status as Parameters<typeof statusTone>[0])}">{experiment.pairedEvaluation.decision.status}</span></div>
      <div class="paired-values card-body"><div><span>Reference</span><b>{formatMetric(experiment.pairedEvaluation.reference.aggregatedMetrics[metricName])}</b></div><div><span>Candidate</span><b>{formatMetric(experiment.pairedEvaluation.candidate.aggregatedMetrics[metricName])}</b></div><div><span>Improvement</span><b class={improvementClass(experiment.pairedEvaluation.decision.primaryDelta)}>{signedMetric(experiment.pairedEvaluation.decision.primaryDelta)}</b></div></div>
    </section>
  {/if}

  <section class="detail-grid conclusion-grid">
    <article class="card narrative motion-enter" style="--motion-delay: 390ms">
      <div class="card-header"><div><h2>Conclusion</h2><p class="muted">Agent interpretation stored after measurement.</p></div></div>
      <div class="card-body"><p class="lead">{experiment.conclusion?.summary ?? "No structured conclusion."}</p>{#if detail?.conclusion}<pre>{detail.conclusion}</pre>{/if}</div>
    </article>
    <article class="card memory motion-enter" style="--motion-delay: 425ms">
      <div class="card-header"><div><h2>Durable memory</h2><p class="muted">Facts and notes attached to this experiment.</p></div></div>
      <div class="card-body">
        {#each $dashboard.run?.researchMemory?.facts.filter((fact) => fact.experimentId === id) ?? [] as fact, index}<p class="memory-item" style={`--item-delay: ${460 + index * 35}ms`}><span>FACT</span>{fact.statement}</p>{/each}
        {#each $dashboard.run?.researchMemory?.notes.filter((note) => note.experimentId === id) ?? [] as note, index}<p class="memory-item" style={`--item-delay: ${500 + index * 35}ms`}><span>{note.phase}</span>{note.text}</p>{/each}
        {#if !($dashboard.run?.researchMemory?.facts.some((fact) => fact.experimentId === id) || $dashboard.run?.researchMemory?.notes.some((note) => note.experimentId === id))}<p class="muted">No memory entries attached.</p>{/if}
      </div>
    </article>
  </section>
{/if}

<style>
  .back { display: inline-block; margin: 2px 0 24px; color: var(--muted); font-size: 12px; }
  .back:hover { color: var(--text); }
  .detail-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
  .detail-hero > div { min-width: 0; }
  .detail-hero h1 { margin-bottom: 5px; }
  .detail-hero p { overflow-wrap: anywhere; margin: 0; font-size: 12px; }
  .detail-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 13px; margin-bottom: 13px; }
  .detail-stats article { min-width: 0; padding: 18px; transition: transform .3s var(--ease-out), border-color .3s var(--ease-standard), box-shadow .3s var(--ease-standard); }
  .detail-stats article:hover { border-color: rgba(157,190,178,.28); box-shadow: 0 20px 50px rgba(0,0,0,.17); transform: translateY(-3px); }
  .detail-stats span { display: block; margin-bottom: 10px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .detail-stats strong { display: block; overflow: hidden; margin-bottom: 5px; font-family: "SFMono-Regular", monospace; font-size: 20px; text-overflow: ellipsis; white-space: nowrap; }
  .detail-stats small { display: block; overflow: hidden; color: var(--muted); font-family: "SFMono-Regular", monospace; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
  .detail-grid { display: grid; grid-template-columns: 1.35fr .85fr; gap: 13px; margin-bottom: 13px; }
  .detail-grid > *, .operation-grid > * { min-width: 0; }
  .card-body { min-width: 0; }
  .card-body p, .card-body li { overflow-wrap: anywhere; color: #b8ccc5; font-size: 12px; line-height: 1.65; word-break: break-word; }
  .card-body .lead { color: var(--text); font-size: 15px; line-height: 1.6; }
  .card-body h3 { margin: 22px 0 8px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }
  ul { margin: 0; padding-left: 18px; color: #c5d6d0; font-size: 12px; line-height: 1.65; }
  .tags { display: flex; flex-wrap: wrap; gap: 7px; }
  .tags code { max-width: 100%; overflow-wrap: anywhere; padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; color: #c7d8d2; background: rgba(3,10,8,.45); font-size: 10px; word-break: break-word; }
  .attempts, .stages, .statistical-card, .paired { margin-bottom: 13px; }
  .table-wrap { overflow-x: auto; padding: 14px 12px 16px; }
  .paired-values { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .paired-values div { padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: rgba(3,10,8,.3); }
  .paired-values span, .paired-values b { display: block; }
  .paired-values span { margin-bottom: 8px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; }
  .paired-values b { font-family: "SFMono-Regular", monospace; font-size: 17px; }
  .statistical-body { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 20px 22px 22px; }
  .statistical-body > div { min-width: 0; padding: 13px; border: 1px solid var(--border); border-radius: 10px; background: rgba(3,10,8,.3); }
  .statistical-body .label { display: block; margin-bottom: 7px; color: var(--muted); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
  .statistical-body b { display: block; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
  .operation-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 13px; margin-bottom: 13px; }
  .operation-card .card-body p { margin-bottom: 15px; }
  .operation-card .card-body p:last-child { margin-bottom: 0; }
  .experiment-link { color: var(--blue); font-family: "SFMono-Regular", monospace; }
  .experiment-link:hover { text-decoration: underline; }
  .review-summary { padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: rgba(3,10,8,.25); }
  .review-summary p { margin: 10px 0 0; }
  .review-summary ul { margin-top: 8px; }
  .ticket-detail { padding: 12px; border: 1px solid rgba(239,189,101,.18); border-radius: 10px; background: rgba(239,189,101,.04); }
  .ticket-detail > span { display: inline-flex; margin-right: 8px; }
  .ticket-detail p { margin: 10px 0 5px; }
  .ticket-detail small { color: var(--muted); font-family: "SFMono-Regular", monospace; font-size: 9px; }
  .attempt-row { animation: detail-row-enter .38s var(--ease-out) both; animation-delay: var(--row-delay); }
  .memory-item { min-width: 0; overflow-wrap: anywhere; padding: 10px 0; border-bottom: 1px solid rgba(157,190,178,.09); word-break: break-word; animation: detail-row-enter .38s var(--ease-out) both; animation-delay: var(--item-delay); }
  .memory-item span { display: inline-block; min-width: 68px; color: var(--green); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  @keyframes detail-row-enter { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
  @media (max-width: 1100px) { .detail-stats { grid-template-columns: repeat(3, 1fr); } .operation-grid { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 920px) { .detail-stats { grid-template-columns: repeat(2, 1fr); } .detail-grid, .operation-grid { grid-template-columns: 1fr; } .statistical-body { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { .detail-stats, .paired-values, .statistical-body { grid-template-columns: 1fr; } }
</style>
