<script lang="ts">
  import type { RunState } from "$lib/types";
  import { formatMetric, improvementClass } from "$lib/format";

  let { run }: { run: RunState } = $props();
  const width = 900;
  const height = 290;
  const margin = { top: 28, right: 24, bottom: 42, left: 78 };

  const points = $derived.by(() => {
    const metric = run.primaryMetric?.name ?? Object.keys(run.acceptedMetrics)[0] ?? "primary";
    return [
      { id: "baseline", value: run.baseline.aggregatedMetrics[metric], delta: null as number | null },
      ...run.experiments
        .filter((experiment) => experiment.evaluation.ok && experiment.evaluation.aggregatedMetrics[metric] !== undefined)
        .map((experiment) => ({ id: experiment.id, value: experiment.evaluation.aggregatedMetrics[metric]!, delta: experiment.decision.primaryDelta })),
    ].filter((point) => Number.isFinite(point.value));
  });
  const extent = $derived.by(() => {
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = max === min ? Math.max(Math.abs(max) * 0.08, 1) : (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  });
  const x = (index: number) => margin.left + index * ((width - margin.left - margin.right) / Math.max(points.length - 1, 1));
  const y = (value: number) => margin.top + (extent.max - value) / Math.max(extent.max - extent.min, Number.EPSILON) * (height - margin.top - margin.bottom);
  const path = $derived(points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.value)}`).join(" "));
  const ticks = $derived(Array.from({ length: 5 }, (_, index) => extent.min + (extent.max - extent.min) * index / 4));
</script>

<div class="chart" role="img" aria-label="Primary metric across experiments">
  {#if points.length > 0}
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
      {#each ticks as tick}
        <line x1={margin.left} y1={y(tick)} x2={width - margin.right} y2={y(tick)} class="grid" />
        <text x={margin.left - 12} y={y(tick) + 4} text-anchor="end" class="axis-label">{formatMetric(tick)}</text>
      {/each}
      {#key path}
        <path d={path} class="series" pathLength="1" />
      {/key}
      {#each points as point, index (point.id)}
        <g class="point" style={`--point-delay: ${Math.min(index * 45, 420)}ms`}>
          <circle cx={x(index)} cy={y(point.value)} r="6" class={index === 0 ? "baseline" : improvementClass(point.delta)} />
          <title>{point.id}: {formatMetric(point.value)}{point.delta === null ? "" : ` · delta ${formatMetric(point.delta)}`}</title>
          <text x={x(index)} y={height - 17} text-anchor="middle" class="x-label">{point.id === "baseline" ? "base" : point.id.replace("exp-", "")}</text>
        </g>
      {/each}
    </svg>
  {/if}
</div>

<style>
  .chart { width: 100%; overflow-x: auto; }
  svg { display: block; width: 100%; min-width: 620px; height: auto; }
  .grid { stroke: rgba(157,190,178,.1); stroke-width: 1; }
  .series { fill: none; stroke: rgba(203,222,215,.4); stroke-width: 1.5; stroke-dasharray: 1; stroke-dashoffset: 1; animation: chart-draw .7s var(--ease-out) forwards; }
  .point { animation: point-enter .36s var(--ease-out) both; animation-delay: var(--point-delay); }
  circle { stroke: #07110f; stroke-width: 3; transform-box: fill-box; transform-origin: center; transition: filter .22s var(--ease-standard), transform .22s var(--ease-out); }
  circle.baseline { fill: #8fa79f; }
  circle.improvement { fill: #5de19e; }
  circle.regression { fill: #ff7474; }
  circle.neutral { fill: #efbd65; }
  .axis-label, .x-label { fill: #8fa79f; font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .point:hover circle { filter: drop-shadow(0 0 5px currentColor); transform: scale(1.28); }
  @keyframes chart-draw { to { stroke-dashoffset: 0; } }
  @keyframes point-enter { from { opacity: 0; transform: translateY(5px) scale(.88); } to { opacity: 1; transform: translateY(0) scale(1); } }
</style>
