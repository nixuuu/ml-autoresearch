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
  <section class="hero">
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
    <article class="card stat">
      <span>Policy leader</span>
      <strong>{run.researchGraph?.leaderId ?? "baseline"}</strong>
      <small>{metricName} = <b>{formatMetric(leaderValue)}</b></small>
    </article>
    <article class="card stat">
      <span>Best observed</span>
      <strong>{run.bestObserved?.experimentId ?? "baseline"}</strong>
      <small>{metricName} = <b>{formatMetric(bestValue)}</b></small>
    </article>
    <article class="card stat">
      <span>Improvement from baseline</span>
      <strong class={totalGain !== null && totalGain > 0 ? "improvement" : totalGain !== null && totalGain < 0 ? "regression" : "neutral"}>{totalGain === null ? "—" : `${totalGain > 0 ? "+" : ""}${(totalGain * 100).toFixed(2)}%`}</strong>
      <small>baseline = <b>{formatMetric(baselineValue)}</b></small>
    </article>
    <article class="card stat">
      <span>Experiments</span>
      <strong>{run.experiments.length}</strong>
      <small>{run.experiments.filter((experiment) => experiment.decision.status === "promote").length} promoted · {run.researchGraph?.frontierIds.length ?? 0} frontier</small>
    </article>
  </section>

  {#if $dashboard.phase}
    <section class="phase card">
      <div class="pulse"></div>
      <div><span class="eyebrow">Current activity</span><p>{$dashboard.phase.message}</p></div>
      <time>{new Date($dashboard.phase.timestamp).toLocaleTimeString()}</time>
    </section>
  {/if}

  <section class="dashboard-grid">
    <article class="card metric-card">
      <div class="card-header">
        <div><h2>Primary metric trajectory</h2><p class="muted">Green points improve on their comparison reference; red points regress.</p></div>
        <span class="pill">{run.primaryMetric?.direction ?? "unknown"}</span>
      </div>
      <div class="card-body"><MetricChart {run} /></div>
    </article>

    <article class="card progress-card">
      <div class="card-header"><div><h2>Live progress</h2><p class="muted">Latest harness and agent phases.</p></div><span class="pill">SSE</span></div>
      <ProgressLog events={$dashboard.progress} />
    </article>
  </section>

  <section class="card flow-card">
    <div class="card-header">
      <div><h2>Experiment topology</h2><p class="muted">Click an experiment to inspect its hypothesis, measurements and conclusion.</p></div>
      <span class="pill">{run.researchGraph?.frontierIds.length ?? 0} active branches</span>
    </div>
    <ExperimentFlow {run} />
  </section>

  <section class="card history">
    <div class="card-header"><div><h2>Experiment history</h2><p class="muted">Decision color reflects measured improvement, regression or retention.</p></div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Parent</th><th>Strategy</th><th>Hypothesis</th><th>Result</th><th>{metricName}</th><th>Delta</th></tr></thead>
        <tbody>
          {#each run.experiments as experiment}
            <tr>
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

  <footer class="run-footer">
    <span>Model: <b>{run.agent?.model ?? "Pi default"}</b> · reasoning: <b>{run.agent?.thinkingLevel ?? "unknown"}</b></span>
    <span>{run.stopReason ?? "Research in progress"}</span>
  </footer>
{/if}

<style>
  .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin: 8px 0 28px; }
  .hero .mono { margin: 0; font-size: 11px; }
  .hero-status { display: flex; align-items: center; gap: 12px; padding-bottom: 4px; font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 13px; margin-bottom: 13px; }
  .stat { padding: 18px; }
  .stat > span, .stat small { display: block; color: var(--muted); }
  .stat > span { margin-bottom: 11px; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .stat strong { display: block; overflow: hidden; margin-bottom: 8px; font-size: 21px; text-overflow: ellipsis; white-space: nowrap; }
  .stat small { font-size: 10px; }
  .stat small b { color: var(--text); font-family: "SFMono-Regular", monospace; }
  .phase { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 15px; margin-bottom: 13px; padding: 15px 18px; }
  .phase p { margin: 4px 0 0; color: #cfe0da; font-size: 12px; }
  .phase time { color: var(--muted); font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(93,225,158,.09); animation: pulse 2s ease-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 10px rgba(93,225,158,0); } }
  .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(320px, .8fr); gap: 13px; margin-bottom: 13px; }
  .card-header p { margin: 0; font-size: 11px; }
  .metric-card, .progress-card { min-width: 0; }
  .flow-card { margin-bottom: 13px; }
  .table-wrap { overflow-x: auto; padding: 12px 12px 16px; }
  .history .hypothesis { max-width: 440px; color: #b7cbc4; line-height: 1.45; }
  .experiment-link { color: var(--blue); font-family: "SFMono-Regular", monospace; }
  .experiment-link:hover { text-decoration: underline; }
  .run-footer { display: flex; justify-content: space-between; gap: 20px; padding: 22px 3px 0; color: var(--muted); font-size: 10px; }
  .run-footer b { color: #bdd0c9; }
  @media (max-width: 1100px) { .stats { grid-template-columns: repeat(2, 1fr); } .dashboard-grid { grid-template-columns: 1fr; } }
  @media (max-width: 620px) { .hero { align-items: flex-start; flex-direction: column; } .stats { grid-template-columns: 1fr; } .phase { grid-template-columns: auto 1fr; } .phase time { display: none; } .run-footer { flex-direction: column; } }
</style>
