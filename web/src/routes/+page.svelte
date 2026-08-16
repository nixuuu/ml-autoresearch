<script lang="ts">
  import { onMount } from "svelte";
  import { dashboard } from "$lib/live";
  import { campaignStatusTone, comparisonTone, formatConfidence, formatDuration, formatMetric, formatPercent, formatRateDuration, formatUsd, relativeImprovement, relativePercentEfficiency, runStatusTone, statusTone } from "$lib/format";
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
  const activeExperimentCount = $derived(run
    ? $dashboard.activeExperiments.filter((active) => !run.experiments.some((experiment) => experiment.id === active.id)).length
    : 0);
  const visibleExperimentCount = $derived((run?.experiments.length ?? 0) + activeExperimentCount);
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
  const totalAgentCostUsd = $derived(run?.experiments.reduce((total, experiment) => total + (experiment.accounting?.agentUsage.costUsd ?? 0), 0) ?? 0);
  const totalAgentTokens = $derived(run?.experiments.reduce((total, experiment) => total + (experiment.accounting?.agentUsage.totalTokens ?? 0), 0) ?? 0);
  const efficiencies = $derived((run?.experiments ?? []).map((experiment) => ({
    experiment,
    ...relativePercentEfficiency(experiment.accounting),
  })).filter((entry) => entry.costUsd !== null && entry.timeMs !== null));
  const bestCostEfficiency = $derived([...efficiencies].sort((left, right) => left.costUsd! - right.costUsd!)[0]);
  const bestTimeEfficiency = $derived([...efficiencies].sort((left, right) => left.timeMs! - right.timeMs!)[0]);
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
      {#key visibleExperimentCount}<strong class="value-swap">{visibleExperimentCount}</strong>{/key}
      <small>{run.experiments.length} completed · {activeExperimentCount} running · {run.experiments.filter((experiment) => experiment.decision.status === "promote").length} promoted</small>
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

  {#if $dashboard.activeExperiments.length > 0}
    <section class="card active-agents motion-enter" style="--motion-delay: 215ms">
      <div><span class="pulse"></span><div><span class="eyebrow">Live agent activity</span><p class="muted">Inspect thinking, messages, tool calls and edits while the experiment is still running.</p></div></div>
      <div class="active-agent-links">
        {#each $dashboard.activeExperiments as activeExperiment (activeExperiment.id)}
          <a href={`/experiments/${activeExperiment.id}`}>
            <span><b>{activeExperiment.id}</b><small>{activeExperiment.transcriptEntries} transcript entries</small></span>
            <span class="mono">{new Date(activeExperiment.latestActivityAt).toLocaleTimeString()} →</span>
          </a>
        {/each}
      </div>
    </section>
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
    <article class="card insight-card motion-enter" style="--motion-delay: 300ms">
      <div class="card-header"><div><h2>Research economics</h2><p class="muted">SDK cost estimate and efficiency per relative percentage point gained.</p></div><span class="pill">USD</span></div>
      <div class="insight-body">
        <div class="insight-value"><b>{formatUsd(totalAgentCostUsd)}</b><span>{totalAgentTokens.toLocaleString()} tokens · {formatDuration(endTime - new Date(run.startedAt).getTime())} wall</span></div>
        <div><span class="label">best cost / +1%</span><b class="mono">{formatUsd(bestCostEfficiency?.costUsd)} · {bestCostEfficiency?.experiment.id ?? "—"}</b></div>
        <div><span class="label">best time / +1%</span><b class="mono">{formatRateDuration(bestTimeEfficiency?.timeMs)} · {bestTimeEfficiency?.experiment.id ?? "—"}</b></div>
      </div>
    </article>
  </section>

  <section class="dashboard-grid">
    <article class="card metric-card motion-enter" style="--motion-delay: 250ms">
      <div class="card-header">
        <div><h2>Primary metric trajectory</h2><p class="muted">Color compares each point with its parent. Hover for baseline and parent deltas; click to inspect an experiment.</p></div>
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
      <span class="pill">{run.researchGraph?.frontierIds.length ?? 0} frontier · {activeExperimentCount} running</span>
    </div>
    <ExperimentFlow {run} activeExperiments={$dashboard.activeExperiments} />
  </section>

  {#if run.campaign || run.metaResearch}
    <section class="research-grid">
      {#if run.campaign}
        <article class="card campaign-card motion-enter" style="--motion-delay: 350ms">
          <div class="card-header">
            <div><h2>Campaign queue</h2><p class="muted">Planned work selected by expected gain and information value.</p></div>
            <div class="campaign-actions"><a href="/tickets">View all {campaignTickets.length} →</a><span class="pill">{queuedTickets.length} active</span></div>
          </div>
          <div class="campaign-summary"><span><b>{campaignTickets.filter((ticket) => ticket.status === "queued").length}</b> queued</span><span><b>{campaignTickets.filter((ticket) => ticket.status === "running").length}</b> running</span><span><b>{campaignTickets.filter((ticket) => ticket.status === "completed").length}</b> completed</span></div>
          <div class="ticket-list">
            {#each [...campaignTickets].sort((left, right) => (right.priorityScore ?? right.priority ?? 0) - (left.priorityScore ?? left.priority ?? 0)).slice(0, 4) as ticket, index (ticket.id)}
              <a class="ticket-row" href={`/tickets/${ticket.id}`} style={`--row-delay: ${index * 35}ms`} aria-label={`Open ${ticket.id}`}>
                <span class="ticket-kind">{ticket.kind ?? ticket.type ?? "hypothesis"}</span>
                <div><b>{ticket.id}</b><p>{ticket.hypothesis}</p></div>
                <span class="pill {campaignStatusTone(ticket.status)}">{ticket.status}</span>
                <span class="ticket-arrow" aria-hidden="true">→</span>
              </a>
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
        <colgroup>
          <col class="col-id"><col class="col-parent"><col class="col-strategy"><col class="col-hypothesis">
          <col class="col-result"><col class="col-evidence"><col class="col-metric"><col class="col-delta">
          <col class="col-duration"><col class="col-cost"><col class="col-efficiency"><col class="col-efficiency">
        </colgroup>
        <thead><tr><th>ID</th><th>Parent</th><th>Strategy</th><th>Hypothesis</th><th>Result</th><th>Evidence</th><th>{metricName}</th><th>Delta</th><th>Actual duration</th><th>Agent cost estimate</th><th>Cost / +1%</th><th>Time / +1%</th></tr></thead>
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
              <td class="mono">{formatDuration(experiment.accounting?.durationMs ?? (new Date(experiment.finishedAt).getTime() - new Date(experiment.startedAt).getTime()))}</td>
              <td class="mono">{formatUsd(experiment.accounting?.agentUsage.costUsd)}</td>
              <td class="mono">{formatUsd(relativePercentEfficiency(experiment.accounting).costUsd)}</td>
              <td class="mono">{formatRateDuration(relativePercentEfficiency(experiment.accounting).timeMs)}</td>
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
  .phase { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 15px; min-width: 0; margin-bottom: 13px; padding: 15px 18px; }
  .phase-update { animation: phase-enter .42s var(--ease-out) both; }
  .phase > div { min-width: 0; }
  .phase p { margin: 4px 0 0; color: #cfe0da; font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; word-break: break-word; }
  .phase time { color: var(--muted); font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .active-agents { display: grid; grid-template-columns: minmax(260px, .65fr) 1.35fr; align-items: center; gap: 18px; margin-bottom: 13px; padding: 15px 18px; border-color: rgba(93,225,158,.2); background: linear-gradient(105deg, rgba(93,225,158,.055), rgba(4,15,11,.5)); }
  .active-agents > div:first-child { display: flex; align-items: center; gap: 14px; }
  .active-agents p { margin: 4px 0 0; font-size: 11px; }
  .active-agent-links { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
  .active-agent-links a { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-width: 245px; padding: 10px 12px; border: 1px solid rgba(93,225,158,.16); border-radius: 9px; color: var(--text); background: rgba(2,12,9,.55); transition: transform .2s var(--ease-out), border-color .2s, background .2s; }
  .active-agent-links a:hover { border-color: rgba(93,225,158,.42); background: rgba(93,225,158,.06); transform: translateY(-2px); }
  .active-agent-links b, .active-agent-links small { display: block; }
  .active-agent-links b { margin-bottom: 3px; font-family: "SFMono-Regular", monospace; font-size: 11px; }
  .active-agent-links small, .active-agent-links > a > span:last-child { color: var(--muted); font-size: 9px; }
  .pulse { width: 9px; height: 9px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(93,225,158,.09); animation: pulse 2s ease-out infinite; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 10px rgba(93,225,158,0); } }
  @keyframes phase-enter { from { opacity: 0; transform: translateX(-8px); border-color: rgba(93,225,158,.34); } to { opacity: 1; transform: translateX(0); border-color: var(--border); } }
  .insights-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; margin-bottom: 13px; }
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
  .campaign-actions { display: flex; align-items: center; gap: 10px; }
  .campaign-actions a { color: var(--blue); font-size: 10px; }
  .campaign-actions a:hover { text-decoration: underline; }
  .ticket-list, .performance-list { padding: 5px 22px 18px; }
  .ticket-row { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto 14px; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(157,190,178,.08); animation: row-enter .38s var(--ease-out) both; animation-delay: var(--row-delay); transition: background-color .2s var(--ease-standard); }
  .ticket-row:hover { background: rgba(93,225,158,.035); }
  .ticket-row:last-child, .performance-row:last-child { border-bottom: 0; }
  .ticket-kind { color: var(--amber); font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }
  .ticket-row b { display: block; font-family: "SFMono-Regular", monospace; font-size: 11px; }
  .ticket-row p { overflow: hidden; margin: 3px 0 0; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .ticket-arrow { color: var(--muted); transition: color .2s, transform .2s var(--ease-out); }
  .ticket-row:hover .ticket-arrow { color: var(--green); transform: translateX(3px); }
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
  .metric-card, .progress-card { min-width: 0; overflow: hidden; }
  .flow-card { margin-bottom: 13px; }
  .history { min-width: 0; overflow: hidden; }
  .table-wrap { max-width: 100%; overflow-x: auto; padding: 12px 12px 16px; }
  .history table { min-width: 1280px; table-layout: fixed; }
  .history th, .history td { overflow-wrap: anywhere; word-break: break-word; }
  .history th { white-space: normal; }
  .history .col-id { width: 86px; }
  .history .col-parent { width: 86px; }
  .history .col-strategy { width: 92px; }
  .history .col-hypothesis { width: 32%; }
  .history .col-result { width: 106px; }
  .history .col-evidence { width: 118px; }
  .history .col-metric { width: 132px; }
  .history .col-delta { width: 112px; }
  .history .col-duration { width: 78px; }
  .history .col-cost { width: 86px; }
  .history .col-efficiency { width: 88px; }
  .history .hypothesis { color: #b7cbc4; line-height: 1.45; white-space: normal; }
  .evidence-count { display: block; margin-top: 5px; color: var(--muted); font-size: 9px; white-space: nowrap; }
  .history-row { animation: row-enter .38s var(--ease-out) both; animation-delay: var(--row-delay); transition: background-color .2s var(--ease-standard); }
  .history-row:hover { background: rgba(93,225,158,.035); }
  @keyframes row-enter { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
  .experiment-link { color: var(--blue); font-family: "SFMono-Regular", monospace; }
  .experiment-link:hover { text-decoration: underline; }
  .run-footer { display: flex; justify-content: space-between; gap: 20px; padding: 22px 3px 0; color: var(--muted); font-size: 10px; }
  .run-footer b { color: #bdd0c9; }
  @media (max-width: 1100px) { .stats { grid-template-columns: repeat(2, 1fr); } .insights-grid, .research-grid, .active-agents { grid-template-columns: 1fr; } .active-agent-links { justify-content: flex-start; } .dashboard-grid { grid-template-columns: 1fr; } }
  @media (max-width: 620px) { .hero { align-items: flex-start; flex-direction: column; } .stats { grid-template-columns: 1fr; } .phase { grid-template-columns: auto 1fr; } .phase time { display: none; } .run-footer { flex-direction: column; } .campaign-actions a { display: none; } .ticket-row { grid-template-columns: minmax(0, 1fr) auto 14px; } .ticket-kind { display: none; } }
</style>
