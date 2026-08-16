<script lang="ts">
  import { onMount } from "svelte";
  import { dashboard } from "$lib/live";
  import { comparisonTone, formatConfidence, formatDuration, formatMetric, formatPercent, relativeImprovement, runStatusTone, statusTone } from "$lib/format";
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
  const latestExperiment = $derived(run?.experiments.at(-1));
  const latestStatistics = $derived(latestExperiment?.evaluation.statistics?.[metricName] ?? run?.baseline.statistics?.[metricName]);
  const latestComparison = $derived(
    latestExperiment?.evaluation.statisticalComparison
    ?? latestExperiment?.pairedEvaluation?.candidate.statisticalComparison,
  );
  const computeSavedRatio = $derived.by(() => {
    const ratios = [run?.baseline.computeSavedRatio ?? 0, ...(run?.experiments.map((experiment) => experiment.evaluation.computeSavedRatio ?? 0) ?? [])];
    return Math.max(...ratios, 0);
  });
  const paretoCount = $derived(run?.researchGraph?.paretoFrontierIds?.length ?? run?.researchGraph?.nodes.filter((node) => node.paretoOptimal).length ?? 0);
  const objectiveEntries = $derived(Object.entries(run?.bestByObjective ?? {}));
  const campaignTickets = $derived(run?.campaign?.tickets ?? []);
  const queuedTickets = $derived(campaignTickets.filter((ticket) => ticket.status === "queued" || ticket.status === "running"));
  const agentPerformance = $derived(run?.metaResearch?.agentPerformance ?? []);
  const strategyPerformance = $derived(run?.metaResearch?.strategyPerformance ?? []);
  const topAgent = $derived([...agentPerformance].sort((left, right) => right.meanReward - left.meanReward)[0]);
  const topStrategy = $derived([...strategyPerformance].sort((left, right) => right.meanReward - left.meanReward)[0]);
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
      <span class="pill {runStatusTone(run.status)}">{run.status}</span>
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

  <section class="insights-grid">
    <article class="card insight-card motion-enter" style="--motion-delay: 225ms">
      <div class="card-header"><div><h2>Statistical evidence</h2><p class="muted">Confidence and sample depth for the latest measurement.</p></div><span class="pill {comparisonTone(latestComparison?.status)}">{latestComparison?.status ?? "pending"}</span></div>
      <div class="insight-body">
        <div class="insight-value"><b>{latestStatistics?.count ?? latestExperiment?.evaluation.attempts.length ?? run.baseline.attempts.length}</b><span>samples</span></div>
        <div><span class="label">mean</span><b class="mono">{formatMetric(latestStatistics?.mean ?? latestExperiment?.evaluation.aggregatedMetrics[metricName] ?? baselineValue)}</b></div>
        <div><span class="label">confidence interval</span><b class="mono">{formatConfidence(latestStatistics?.confidenceInterval, latestStatistics?.confidenceLevel)}</b></div>
      </div>
    </article>
    <article class="card insight-card motion-enter" style="--motion-delay: 250ms">
      <div class="card-header"><div><h2>Evaluation efficiency</h2><p class="muted">Budget recovered by screening and early pruning.</p></div><span class="pill">compute</span></div>
      <div class="insight-body">
        <div class="insight-value"><b>{formatPercent(computeSavedRatio)}</b><span>saved</span></div>
        <div><span class="label">latest stages</span><b>{latestExperiment?.evaluation.stages?.length ?? 0}</b></div>
        <div><span class="label">latest duration</span><b class="mono">{formatDuration(latestExperiment?.evaluation.totalDurationMs ?? 0)}</b></div>
      </div>
    </article>
    <article class="card insight-card motion-enter" style="--motion-delay: 275ms">
      <div class="card-header"><div><h2>Pareto frontier</h2><p class="muted">Non-dominated checkpoints across configured objectives.</p></div><span class="pill warning">{paretoCount} points</span></div>
      <div class="insight-body objective-list">
        {#if objectiveEntries.length > 0}
          {#each objectiveEntries.slice(0, 3) as [name, best]}
            <div><span class="label">{name}</span><b class="mono">{best.experimentId} · {formatMetric(best.value)}</b></div>
          {/each}
        {:else}
          <div><span class="label">primary objective</span><b class="mono">{metricName} · {formatMetric(bestValue ?? leaderValue)}</b></div>
          <div><span class="label">frontier branches</span><b>{run.researchGraph?.frontierIds.length ?? 0}</b></div>
        {/if}
      </div>
    </article>
  </section>

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

  {#if run.campaign || run.metaResearch}
    <section class="research-grid">
      {#if run.campaign}
        <article class="card campaign-card motion-enter" style="--motion-delay: 350ms">
          <div class="card-header"><div><h2>Campaign queue</h2><p class="muted">Planned work selected by expected gain and information value.</p></div><span class="pill">{queuedTickets.length} active</span></div>
          <div class="campaign-summary"><span><b>{campaignTickets.filter((ticket) => ticket.status === "queued").length}</b> queued</span><span><b>{campaignTickets.filter((ticket) => ticket.status === "running").length}</b> running</span><span><b>{campaignTickets.filter((ticket) => ticket.status === "completed").length}</b> completed</span></div>
          <div class="ticket-list">
            {#each [...campaignTickets].sort((left, right) => (right.priorityScore ?? right.priority ?? 0) - (left.priorityScore ?? left.priority ?? 0)).slice(0, 4) as ticket, index (ticket.id)}
              <div class="ticket-row" style={`--row-delay: ${index * 35}ms`}>
                <span class="ticket-kind">{ticket.kind ?? ticket.type ?? "hypothesis"}</span>
                <div><b>{ticket.id}</b><p>{ticket.hypothesis}</p></div>
                <span class="pill {ticket.status === 'running' ? 'improvement' : ticket.status === 'blocked' ? 'regression' : ticket.status === 'queued' ? 'warning' : 'neutral'}">{ticket.status}</span>
              </div>
            {:else}
              <p class="muted empty-inline">No campaign tickets yet.</p>
            {/each}
          </div>
        </article>
      {/if}
      {#if run.metaResearch}
        <article class="card meta-card motion-enter" style="--motion-delay: 375ms">
          <div class="card-header"><div><h2>Research performance</h2><p class="muted">How agent profiles and strategies perform in this run.</p></div><span class="pill">meta</span></div>
          <div class="performance-grid">
            <div><span class="label">top agent</span><b>{topAgent?.profileId ?? "—"}</b><small>{formatMetric(topAgent?.meanReward)} mean reward</small></div>
            <div><span class="label">top strategy</span><b>{topStrategy?.strategy ?? "—"}</b><small>{formatMetric(topStrategy?.meanReward)} mean reward</small></div>
          </div>
          <div class="performance-list">
            {#each agentPerformance.slice(0, 3) as profile, index (profile.profileId)}
              <div class="performance-row" style={`--row-delay: ${index * 35}ms`}><span>{profile.profileId}</span><b>{profile.promotions}/{profile.trials} promoted</b><small>{profile.failures} failures</small></div>
            {:else}<p class="muted empty-inline">Meta-research will appear after warmup.</p>{/each}
          </div>
        </article>
      {/if}
    </section>
  {/if}

  <section class="card history motion-enter" style="--motion-delay: 370ms">
    <div class="card-header"><div><h2>Experiment history</h2><p class="muted">Decision color reflects measured improvement, regression or retention.</p></div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>ID</th><th>Parent</th><th>Strategy</th><th>Hypothesis</th><th>Result</th><th>Evidence</th><th>{metricName}</th><th>Delta</th></tr></thead>
        <tbody>
          {#each run.experiments as experiment, index (experiment.id)}
            <tr class="history-row" style={`--row-delay: ${Math.min(index * 32, 320)}ms`}>
              <td><a class="experiment-link" href={`/experiments/${experiment.id}`}>{experiment.id}</a></td>
              <td>{experiment.parentId ?? "baseline"}</td>
              <td>{experiment.strategy ?? "legacy"}</td>
              <td class="hypothesis">{experiment.plan?.hypothesis ?? "—"}</td>
              <td><span class="pill {statusTone(experiment.decision.status as Parameters<typeof statusTone>[0])}">{experiment.decision.status}</span></td>
              <td>
                <span class="pill {comparisonTone(experiment.evaluation.statisticalComparison?.status ?? experiment.decision.statisticalStatus)}">{experiment.evaluation.statisticalComparison?.status ?? experiment.decision.statisticalStatus ?? "—"}</span>
                <small class="evidence-count">{experiment.evaluation.statistics?.[metricName]?.count ?? experiment.evaluation.attempts.length} samples{#if experiment.evaluation.stages?.length} · {experiment.evaluation.stages.length} stages{/if}</small>
              </td>
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
  .insights-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 13px; margin-bottom: 13px; }
  .insight-card { min-width: 0; }
  .insight-body { display: grid; grid-template-columns: auto 1fr 1.35fr; align-items: end; gap: 14px; padding: 20px 22px 22px; }
  .insight-body > div { min-width: 0; }
  .insight-body .label, .performance-grid .label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
  .insight-body b { display: block; overflow: hidden; color: #dce9e4; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
  .insight-value b { color: var(--green); font-size: 25px; letter-spacing: -.04em; }
  .insight-value span { color: var(--muted); font-size: 10px; }
  .objective-list { display: block; }
  .objective-list > div { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(157,190,178,.08); }
  .objective-list > div:last-child { border-bottom: 0; }
  .objective-list .label { margin: 0; }
  .research-grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 13px; margin-bottom: 13px; }
  .campaign-summary { display: flex; gap: 18px; padding: 18px 22px 8px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .campaign-summary b { margin-right: 4px; color: var(--text); font-family: "SFMono-Regular", monospace; font-size: 14px; }
  .ticket-list, .performance-list { padding: 5px 22px 18px; }
  .ticket-row { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(157,190,178,.08); animation: row-enter .38s var(--ease-out) both; animation-delay: var(--row-delay); }
  .ticket-row:last-child, .performance-row:last-child { border-bottom: 0; }
  .ticket-kind { color: var(--amber); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }
  .ticket-row b { display: block; font-family: "SFMono-Regular", monospace; font-size: 11px; }
  .ticket-row p { overflow: hidden; margin: 3px 0 0; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .performance-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 18px 22px 8px; }
  .performance-grid > div { padding: 13px; border: 1px solid var(--border); border-radius: 10px; background: rgba(3,10,8,.28); }
  .performance-grid b, .performance-grid small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .performance-grid b { margin-bottom: 4px; font-family: "SFMono-Regular", monospace; font-size: 13px; }
  .performance-grid small { color: var(--muted); font-size: 10px; }
  .performance-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid rgba(157,190,178,.08); font-size: 11px; }
  .performance-row span { overflow: hidden; color: #c8d9d3; text-overflow: ellipsis; white-space: nowrap; }
  .performance-row b { color: var(--green); font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .performance-row small { color: var(--muted); font-size: 10px; }
  .empty-inline { margin: 10px 0; font-size: 11px; }
  .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(320px, .8fr); gap: 13px; margin-bottom: 13px; }
  .card-header p { margin: 0; font-size: 11px; }
  .metric-card, .progress-card { min-width: 0; }
  .flow-card { margin-bottom: 13px; }
  .table-wrap { overflow-x: auto; padding: 12px 12px 16px; }
  .history .hypothesis { max-width: 440px; color: #b7cbc4; line-height: 1.45; }
  .evidence-count { display: block; margin-top: 5px; color: var(--muted); font-size: 9px; white-space: nowrap; }
  .history-row { animation: row-enter .38s var(--ease-out) both; animation-delay: var(--row-delay); transition: background-color .2s var(--ease-standard); }
  .history-row:hover { background: rgba(93,225,158,.035); }
  @keyframes row-enter { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
  .experiment-link { color: var(--blue); font-family: "SFMono-Regular", monospace; }
  .experiment-link:hover { text-decoration: underline; }
  .run-footer { display: flex; justify-content: space-between; gap: 20px; padding: 22px 3px 0; color: var(--muted); font-size: 10px; }
  .run-footer b { color: #bdd0c9; }
  @media (max-width: 1100px) { .stats { grid-template-columns: repeat(2, 1fr); } .insights-grid, .research-grid { grid-template-columns: 1fr; } .dashboard-grid { grid-template-columns: 1fr; } }
  @media (max-width: 620px) { .hero { align-items: flex-start; flex-direction: column; } .stats { grid-template-columns: 1fr; } .phase { grid-template-columns: auto 1fr; } .phase time { display: none; } .run-footer { flex-direction: column; } }
</style>
