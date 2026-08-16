<script lang="ts">
  import { page } from "$app/state";
  import { dashboard } from "$lib/live";
  import { formatDuration, formatMetric, improvementClass, signedMetric, statusTone } from "$lib/format";
  import type { ExperimentDetail } from "$lib/types";

  let detail = $state<ExperimentDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  const id = $derived(page.params.id);
  const liveExperiment = $derived($dashboard.run?.experiments.find((experiment) => experiment.id === id));
  const experiment = $derived(liveExperiment ?? detail?.experiment);
  const metricName = $derived($dashboard.run?.primaryMetric?.name ?? (experiment ? Object.keys(experiment.evaluation.aggregatedMetrics)[0] : undefined) ?? "primary");

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
    <div><span class="eyebrow">Experiment detail</span><h1>{experiment.id}</h1><p class="muted">{experiment.plan?.changeCategory ?? "other"} · {experiment.strategy ?? "legacy"} from {experiment.parentId ?? "baseline"}</p></div>
    <span class="pill {statusTone(experiment.decision.status as Parameters<typeof statusTone>[0])}">{experiment.decision.status}</span>
  </section>

  <section class="detail-stats">
    <article class="card motion-enter" style="--motion-delay: 100ms"><span>{metricName}</span><strong>{formatMetric(experiment.evaluation.aggregatedMetrics[metricName])}</strong></article>
    <article class="card motion-enter" style="--motion-delay: 135ms"><span>Primary improvement</span><strong class={improvementClass(experiment.decision.primaryDelta)}>{signedMetric(experiment.decision.primaryDelta)}</strong></article>
    <article class="card motion-enter" style="--motion-delay: 170ms"><span>Duration</span><strong>{formatDuration(new Date(experiment.finishedAt).getTime() - new Date(experiment.startedAt).getTime())}</strong></article>
    <article class="card motion-enter" style="--motion-delay: 205ms"><span>Branch depth</span><strong>{experiment.branchDepth ?? "—"}</strong></article>
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
      </div>
    </article>
  </section>

  <section class="card attempts motion-enter" style="--motion-delay: 310ms">
    <div class="card-header"><div><h2>Canonical evaluation attempts</h2><p class="muted">Seeds, timings and raw attempt metrics.</p></div><span class="pill {experiment.evaluation.ok ? 'improvement' : 'regression'}">{experiment.evaluation.ok ? "valid" : "failed"}</span></div>
    <div class="table-wrap">
      <table><thead><tr><th>Repetition</th><th>Seed</th><th>Duration</th><th>Exit</th><th>Metrics</th></tr></thead>
        <tbody>{#each experiment.evaluation.attempts as attempt, index}<tr class="attempt-row" style={`--row-delay: ${340 + index * 36}ms`}><td>{attempt.repetition + 1}</td><td class="mono">{attempt.seed}</td><td>{formatDuration(attempt.durationMs)}</td><td class:regression={attempt.exitCode !== 0}>{attempt.timedOut ? "timeout" : attempt.exitCode}</td><td class="mono">{Object.entries(attempt.metrics ?? {}).map(([name, value]) => `${name}=${formatMetric(value)}`).join(" · ") || attempt.error || "—"}</td></tr>{/each}</tbody>
      </table>
    </div>
  </section>

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
  .detail-hero h1 { margin-bottom: 5px; }
  .detail-hero p { margin: 0; font-size: 12px; }
  .detail-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 13px; margin-bottom: 13px; }
  .detail-stats article { padding: 18px; transition: transform .3s var(--ease-out), border-color .3s var(--ease-standard), box-shadow .3s var(--ease-standard); }
  .detail-stats article:hover { border-color: rgba(157,190,178,.28); box-shadow: 0 20px 50px rgba(0,0,0,.17); transform: translateY(-3px); }
  .detail-stats span { display: block; margin-bottom: 10px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .detail-stats strong { font-family: "SFMono-Regular", monospace; font-size: 20px; }
  .detail-grid { display: grid; grid-template-columns: 1.35fr .85fr; gap: 13px; margin-bottom: 13px; }
  .card-body p { color: #b8ccc5; font-size: 12px; line-height: 1.65; }
  .card-body .lead { color: var(--text); font-size: 15px; line-height: 1.6; }
  .card-body h3 { margin: 22px 0 8px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .09em; }
  ul { margin: 0; padding-left: 18px; color: #c5d6d0; font-size: 12px; line-height: 1.65; }
  .tags { display: flex; flex-wrap: wrap; gap: 7px; }
  .tags code { padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px; color: #c7d8d2; background: rgba(3,10,8,.45); font-size: 10px; }
  .attempts, .paired { margin-bottom: 13px; }
  .table-wrap { overflow-x: auto; padding: 14px 12px 16px; }
  .paired-values { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .paired-values div { padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: rgba(3,10,8,.3); }
  .paired-values span, .paired-values b { display: block; }
  .paired-values span { margin-bottom: 8px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; }
  .paired-values b { font-family: "SFMono-Regular", monospace; font-size: 17px; }
  .attempt-row { animation: detail-row-enter .38s var(--ease-out) both; animation-delay: var(--row-delay); }
  .memory-item { padding: 10px 0; border-bottom: 1px solid rgba(157,190,178,.09); animation: detail-row-enter .38s var(--ease-out) both; animation-delay: var(--item-delay); }
  .memory-item span { display: inline-block; min-width: 68px; color: var(--green); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  @keyframes detail-row-enter { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
  @media (max-width: 920px) { .detail-stats { grid-template-columns: repeat(2, 1fr); } .detail-grid { grid-template-columns: 1fr; } }
  @media (max-width: 560px) { .detail-stats, .paired-values { grid-template-columns: 1fr; } }
</style>
