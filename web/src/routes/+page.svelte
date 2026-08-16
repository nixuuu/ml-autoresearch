<script lang="ts">
  import { onMount } from "svelte";
  import { dashboard } from "$lib/live";
  import { formatDuration, formatMetric, relativeImprovement, statusTone } from "$lib/format";
  import ExperimentFlow from "$lib/components/ExperimentFlow.svelte";
  import MetricChart from "$lib/components/MetricChart.svelte";
  import ProgressLog from "$lib/components/ProgressLog.svelte";

  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => now = Date.now(), 1000);
    return () => clearInterval(timer);
  });
  const run = $derived($dashboard.run);
  const metricName = $derived(run?.primaryMetric?.name ?? (run ? Object.keys(run.acceptedMetrics)[0] : undefined) ?? "primary");
  const baselineValue = $derived(run?.baseline.aggregatedMetrics[metricName]);
  const leaderValue = $derived(run?.acceptedMetrics[metricName]);
  const bestValue = $derived(run?.bestObserved?.metrics[metricName]);
  const totalGain = $derived(run && baselineValue !== undefined && bestValue !== undefined
    ? relativeImprovement(baselineValue, bestValue, run.primaryMetric?.direction ?? "minimize")
    : null);
  const endTime = $derived(run?.finishedAt ? new Date(run.finishedAt).getTime() : now);
</script>

{#if !run}
  <section class="card empty">
    <div><div class="loader"></div><h2>Preparing the research workspace</h2><p class="muted">The dashboard will populate as soon as the baseline state is available.</p></div>
  </section>
{:else}
  <section class="hero motion-enter" style="--motion-delay: 30ms">
    <div>
      <span class="eyebrow">Controlled experiment run</span>
      <h1>{run.name}</h1>
      <p class="muted mono">{run.runId}</p>
    </div>
    <div class="hero-status">
      <span class="pill {run.status === 'completed' ? 'improvement' : run.status === 'failed' ? 'regression' : 'warning'}">{run.status}</span>
      <span class="muted">{formatDuration(endTime - new Date(run.startedAt).getTime())}</span>
    </div>
  </section>

  <section class="stats">
    <article class="card stat motion-enter" style="--motion-delay: 90ms">
      <span>Policy leader</span>
      {#key run.researchGraph?.leaderId}<strong class="value-swap">{run.researchGraph?.leaderId ?? "baseline"}</strong>{/key}
      <small>{metricName} = <b>{formatMetric(leaderValue)}</b></small>
    </article>
    <article class="card stat motion-enter" style="--motion-delay: 130ms">
      <span>Best observed</span>
      {#key run.bestObserved?.experimentId}<strong class="value-swap">{run.bestObserved?.experimentId ?? "baseline"}</strong>{/key}
      <small>{metricName} = <b>{formatMetric(bestValue)}</b></small>
    </article>
    <article class="card stat motion-enter" style="--motion-delay: 170ms">
      <span>Improvement from baseline</span>
      {#key totalGain}<strong class="value-swap {totalGain !== null && totalGain > 0 ? 'improvement' : totalGain !== null && totalGain < 0 ? 'regression' : 'neutral'}">{totalGain === null ? "—" : `${totalGain > 0 ? "+" : ""}${(totalGain * 100).toFixed(2)}%`}</strong>{/key}
      <small>baseline = <b>{formatMetric(baselineValue)}</b></small>
    </article>
    <article class="card stat motion-enter" style="--motion-delay: 210ms">
      <span>Experiments</span>
      {#key run.experiments.length}<strong class="value-swap">{run.experiments.length}</strong>{/key}
      <small>{run.experiments.filter((experiment) => experiment.decision.status === "promote").length} promoted · {run.researchGraph?.frontierIds.length ?? 0} frontier</small>
    </article>
  </section>

  {#if $dashboard.phase}
    {#key $dashboard.phase.sequence}
      <section class="phase card phase-update">
        <div class="pulse"></div>
        <div><span class="eyebrow">Current activity</span><p>{$dashboard.phase.message}</p></div>
        <time>{new Date($dashboard.phase.timestamp).toLocaleTimeString()}</time>
      </section>
    {/key}
  {/if}

  <section class="dashboard-grid">
    <article class="card metric-card motion-enter" style="--motion-delay: 250ms">
      <div class="card-header">
        <div><h2>Primary metric trajectory</h2><p class="muted">Green points improve on their comparison reference; red points regress.</p></div>
        <span class="pill">{run.primaryMetric?.direction ?? "unknown"}</span>
      </div>
      <div class="card-body"><MetricChart {run} /></div>
    </article>

    <article class="card progress-card motion-enter" style="--motion-delay: 290ms">
      <div class="card-header"><div><h2>Live progress</h2><p class="muted">Latest harness and agent phases.</p></div><span class="pill">SSE</span></div>
      <ProgressLog events={$dashboard.progress} />
    </article>
  </section>

  <section class="card flow-card motion-enter" style="--motion-delay: 330ms">
    <div class="card-header">
      <div><h2>Experiment topology</h2><p class="muted">Click an experiment to inspect its hypothesis, measurements and conclusion.</p></div>
      <span class="pill">{run.researchGraph?.frontierIds.length ?? 0} active branches</span>
    </div>
    <ExperimentFlow {run} />
  </section>

  <section class="card history motion-enter" style="--motion-delay: 370ms">
    <div class="card-header"><div><h2>Experiment history</h2><p class="muted">Decision color reflects measured improvement, regression or retention.</p></div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Parent</th><th>Strategy</th><th>Hypothesis</th><th>Result</th><th>{metricName}</th><th>Delta</th></tr></thead>
        <tbody>
          {#each run.experiments as experiment, index (experiment.id)}
            <tr class="history-row" style={`--row-delay: ${Math.min(index * 32, 320)}ms`}>
              <td><a class="experiment-link" href={`/experiments/${experiment.id}`}>{experiment.id}</a></td>
              <td>{experiment.parentId ?? "baseline"}</td>
              <td>{experiment.strategy ?? "legacy"}</td>
              <td class="hypothesis">{experiment.plan?.hypothesis ?? "—"}</td>
              <td><span class="pill {statusTone(experiment.decision.status as Parameters<typeof statusTone>[0])}">{experiment.decision.status}</span></td>
              <td class="mono">{formatMetric(experiment.evaluation.aggregatedMetrics[metricName])}</td>
              <td class="mono {experiment.decision.primaryDelta !== null && experiment.decision.primaryDelta > 0 ? 'improvement' : experiment.decision.primaryDelta !== null && experiment.decision.primaryDelta < 0 ? 'regression' : 'neutral'}">{experiment.decision.primaryDelta === null ? "—" : `${experiment.decision.primaryDelta > 0 ? "+" : ""}${formatMetric(experiment.decision.primaryDelta)}`}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <footer class="run-footer motion-enter" style="--motion-delay: 410ms">
    <span>Model: <b>{run.agent?.model ?? "Pi default"}</b> · reasoning: <b>{run.agent?.thinkingLevel ?? "unknown"}</b></span>
    <span>{run.stopReason ?? "Research in progress"}</span>
  </footer>
{/if}

<style>
  .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin: 8px 0 28px; }
  .hero .mono { margin: 0; font-size: 11px; }
  .hero-status { display: flex; align-items: center; gap: 12px; padding-bottom: 4px; font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 13px; margin-bottom: 13px; }
  .stat { padding: 18px; transition: transform .3s var(--ease-out), border-color .3s var(--ease-standard), box-shadow .3s var(--ease-standard); }
  .stat:hover { border-color: rgba(157,190,178,.28); box-shadow: 0 22px 60px rgba(0,0,0,.18); transform: translateY(-3px); }
  .stat > span, .stat small { display: block; color: var(--muted); }
  .stat > span { margin-bottom: 11px; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .stat strong { display: block; overflow: hidden; margin-bottom: 8px; font-size: 21px; text-overflow: ellipsis; white-space: nowrap; }
  .stat small { font-size: 10px; }
  .stat small b { color: var(--text); font-family: "SFMono-Regular", monospace; }
  .phase { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 15px; margin-bottom: 13px; padding: 15px 18px; }
  .phase-update { animation: phase-enter .42s var(--ease-out) both; }
  .phase p { margin: 4px 0 0; color: #cfe0da; font-size: 12px; }
  .phase time { color: var(--muted); font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(93,225,158,.09); animation: pulse 2s ease-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 10px rgba(93,225,158,0); } }
  @keyframes phase-enter { from { opacity: 0; transform: translateX(-8px); border-color: rgba(93,225,158,.34); } to { opacity: 1; transform: translateX(0); border-color: var(--border); } }
  .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(320px, .8fr); gap: 13px; margin-bottom: 13px; }
  .card-header p { margin: 0; font-size: 11px; }
  .metric-card, .progress-card { min-width: 0; }
  .flow-card { margin-bottom: 13px; }
  .table-wrap { overflow-x: auto; padding: 12px 12px 16px; }
  .history .hypothesis { max-width: 440px; color: #b7cbc4; line-height: 1.45; }
  .history-row { animation: row-enter .38s var(--ease-out) both; animation-delay: var(--row-delay); transition: background-color .2s var(--ease-standard); }
  .history-row:hover { background: rgba(93,225,158,.035); }
  @keyframes row-enter { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
  .experiment-link { color: var(--blue); font-family: "SFMono-Regular", monospace; }
  .experiment-link:hover { text-decoration: underline; }
  .run-footer { display: flex; justify-content: space-between; gap: 20px; padding: 22px 3px 0; color: var(--muted); font-size: 10px; }
  .run-footer b { color: #bdd0c9; }
  @media (max-width: 1100px) { .stats { grid-template-columns: repeat(2, 1fr); } .dashboard-grid { grid-template-columns: 1fr; } }
  @media (max-width: 620px) { .hero { align-items: flex-start; flex-direction: column; } .stats { grid-template-columns: 1fr; } .phase { grid-template-columns: auto 1fr; } .phase time { display: none; } .run-footer { flex-direction: column; } }
</style>
