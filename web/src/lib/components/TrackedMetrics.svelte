<script lang="ts">
  import type { RunState } from "$lib/types";
  import { dashboardMetrics, metricImprovement } from "$lib/metrics";
  import { formatMetric, formatPercent, improvementClass, signedMetric } from "$lib/format";

  let { run }: { run: RunState } = $props();
  const metrics = $derived(dashboardMetrics(run));
</script>

<section class="tracked-metrics" aria-label="Tracked metrics">
  {#each metrics as metric (metric.name)}
    {@const value = run.acceptedMetrics[metric.name]}
    {@const baseline = run.baseline.aggregatedMetrics[metric.name]}
    {@const gain = metricImprovement(baseline, value, metric.direction)}
    <article class="card tracked-metric">
      <div class="metric-heading">
        <h2 title={metric.name}>{metric.label}</h2>
        <span class="pill">{metric.name === run.primaryMetric?.name ? "primary" : "tracked"}</span>
      </div>
      <div class="metric-value">
        <strong>{metric.format === "percentage" ? formatPercent(value, 2) : formatMetric(value, metric.format)}</strong>
        <span>{metric.direction === "minimize" ? "Lower is better" : metric.direction === "maximize" ? "Higher is better" : "Diagnostic metric"}</span>
      </div>
      <p class="muted">Policy leader · <span class="mono">{run.researchGraph?.leaderId ?? "baseline"}</span></p>
      <dl>
        <div><dt>Baseline</dt><dd>{metric.format === "percentage" ? formatPercent(baseline, 2) : formatMetric(baseline, metric.format)}</dd></div>
        <div><dt>Improvement vs baseline</dt><dd class={improvementClass(gain)}>{signedMetric(gain, metric.format)}</dd></div>
      </dl>
    </article>
  {/each}
</section>

<style>
  .tracked-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 13px; margin-bottom: 13px; }
  .tracked-metric { min-width: 0; padding: 22px; }
  .metric-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  h2 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
  .metric-value { display: flex; align-items: baseline; flex-wrap: wrap; gap: 14px; margin-top: 18px; }
  .metric-value strong { color: var(--green); font: 700 34px "SFMono-Regular", monospace; letter-spacing: -.04em; }
  .metric-value span, p { color: var(--muted); font-size: 11px; }
  p { margin: 8px 0 18px; }
  dl { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 0; padding-top: 14px; border-top: 1px solid var(--border); }
  dt { color: var(--muted); font-size: 10px; }
  dd { margin: 5px 0 0; font: 600 13px "SFMono-Regular", monospace; }
</style>
