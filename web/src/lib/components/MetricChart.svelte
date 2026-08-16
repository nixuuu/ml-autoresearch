<script lang="ts">
  import type { DecisionStatus, RunState } from "$lib/types";
  import { formatMetric, formatPercent, improvementClass, signedMetric } from "$lib/format";

  let { run }: { run: RunState } = $props();
  let activePointId = $state<string | null>(null);

  const width = 900;
  const height = 320;
  const margin = { top: 44, right: 24, bottom: 42, left: 78 };
  const tooltipWidth = 238;
  const tooltipHeight = 128;
  const metricName = $derived(run.primaryMetric?.name ?? Object.keys(run.acceptedMetrics)[0] ?? "primary");
  const metricFormat = $derived(run.primaryMetric?.format ?? "number");
  const direction = $derived(run.primaryMetric?.direction ?? "maximize");
  const baselineValue = $derived(run.baseline.aggregatedMetrics[metricName]);

  interface ChartPoint {
    id: string;
    value: number;
    parentDelta: number | null;
    parentId?: string;
    strategy: string;
    status: DecisionStatus | "baseline";
    pareto: boolean;
    leader: boolean;
    best: boolean;
  }

  const points = $derived.by((): ChartPoint[] => {
    const baseline: ChartPoint = {
      id: "baseline",
      value: baselineValue,
      parentDelta: null,
      strategy: "reference",
      status: "baseline",
      pareto: run.researchGraph?.paretoFrontierIds?.includes("baseline") ?? false,
      leader: run.researchGraph?.leaderId === "baseline",
      best: run.bestObserved?.experimentId === "baseline",
    };
    return [baseline, ...run.experiments
      .filter((experiment) => experiment.evaluation.ok && experiment.evaluation.aggregatedMetrics[metricName] !== undefined)
      .map((experiment): ChartPoint => ({
        id: experiment.id,
        value: experiment.evaluation.aggregatedMetrics[metricName]!,
        parentDelta: experiment.decision.primaryDelta,
        parentId: experiment.parentId ?? "baseline",
        strategy: experiment.strategy ?? "legacy",
        status: experiment.decision.status,
        pareto: run.researchGraph?.paretoFrontierIds?.includes(experiment.id)
          ?? run.researchGraph?.nodes.find((node) => node.id === experiment.id)?.paretoOptimal
          ?? experiment.decision.paretoOptimal
          ?? false,
        leader: run.researchGraph?.leaderId === experiment.id,
        best: run.bestObserved?.experimentId === experiment.id,
      }))].filter((point) => Number.isFinite(point.value));
  });

  const extent = $derived.by(() => {
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = max === min ? Math.max(Math.abs(max) * 0.08, 1) : (max - min) * 0.14;
    return { min: min - pad, max: max + pad };
  });
  const x = (index: number) => margin.left + index * ((width - margin.left - margin.right) / Math.max(points.length - 1, 1));
  const y = (value: number) => margin.top + (extent.max - value) / Math.max(extent.max - extent.min, Number.EPSILON) * (height - margin.top - margin.bottom);
  const path = $derived(points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.value)}`).join(" "));
  const ticks = $derived(Array.from({ length: 5 }, (_, index) => extent.min + (extent.max - extent.min) * index / 4));
  const activePoint = $derived(points.find((point) => point.id === activePointId));
  const activeIndex = $derived(activePoint ? points.findIndex((point) => point.id === activePoint.id) : -1);

  function baselineGain(point: ChartPoint): number {
    return direction === "minimize" ? baselineValue - point.value : point.value - baselineValue;
  }

  function markerTone(point: ChartPoint, index: number): "baseline" | "improvement" | "regression" | "neutral" {
    return index === 0 ? "baseline" : improvementClass(point.parentDelta);
  }

  function markerFill(point: ChartPoint, index: number): string {
    const tone = markerTone(point, index);
    if (tone === "improvement") return "#5de19e";
    if (tone === "regression") return "#ff7474";
    if (tone === "neutral") return "#efbd65";
    return "#8fa79f";
  }

  function baselineRatio(point: ChartPoint): number | null {
    return baselineValue === 0 ? null : baselineGain(point) / Math.abs(baselineValue);
  }

  function pointDescription(point: ChartPoint): string {
    if (point.id === "baseline") return `Baseline ${metricName} ${formatMetric(point.value, metricFormat)}`;
    const markers = [point.leader ? "policy leader" : "", point.best ? "best observed" : "", point.pareto ? "Pareto frontier" : ""].filter(Boolean).join(", ");
    return `${point.id}, ${metricName} ${formatMetric(point.value, metricFormat)}, ${signedMetric(baselineGain(point), metricFormat)} versus baseline${markers ? `, ${markers}` : ""}. Open experiment details.`;
  }

  function tooltipX(index: number): number {
    const pointX = x(index);
    return pointX + tooltipWidth + 14 > width - margin.right ? pointX - tooltipWidth - 14 : pointX + 14;
  }

  function tooltipY(point: ChartPoint): number {
    const pointY = y(point.value);
    return pointY + tooltipHeight + 12 > height - margin.bottom ? pointY - tooltipHeight - 12 : pointY + 12;
  }

  function baselineLabelY(): number {
    const valueY = y(baselineValue);
    return valueY < margin.top + 14 ? valueY + 17 : valueY - 7;
  }
</script>

<div class="chart-legend" aria-label="Chart legend">
  <span><i class="key baseline-key"></i>baseline</span>
  <span><i class="key improvement-key"></i>better vs parent</span>
  <span><i class="key regression-key"></i>worse vs parent</span>
  <span><i class="key leader-key"></i>policy leader</span>
  <span><i class="key best-key"></i>best observed</span>
  <span><i class="key pareto-key"></i>Pareto</span>
</div>

<div class="chart" role="img" aria-label="Primary metric across experiments. Hover or focus points for comparison details; activate a point to open the experiment.">
  {#if points.length > 0}
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
      {#each ticks as tick}
        <line x1={margin.left} y1={y(tick)} x2={width - margin.right} y2={y(tick)} class="grid" />
        <text x={margin.left - 12} y={y(tick) + 4} text-anchor="end" class="axis-label">{formatMetric(tick, metricFormat)}</text>
      {/each}

      <line x1={margin.left} y1={y(baselineValue)} x2={width - margin.right} y2={y(baselineValue)} class="baseline-line" />
      <text x={width - margin.right} y={baselineLabelY()} text-anchor="end" class="baseline-label">baseline · {formatMetric(baselineValue, metricFormat)}</text>

      {#key path}
        <path d={path} class="series" pathLength="1" />
      {/key}

      {#each points as point, index (point.id)}
        {#if point.id === "baseline"}
          <g
            class="point"
            class:active={activePointId === point.id}
            role="img"
            aria-label={pointDescription(point)}
            style={`--point-delay: ${Math.min(index * 45, 420)}ms`}
            onmouseenter={() => activePointId = point.id}
            onmouseleave={() => activePointId = null}
          >
            {#if point.best}<circle cx={x(index)} cy={y(point.value)} r="12" class="best-ring" />{/if}
            {#if point.leader}<circle cx={x(index)} cy={y(point.value)} r="10" class="leader-ring" />{/if}
            <circle
              cx={x(index)}
              cy={y(point.value)}
              r="6"
              class="marker"
              class:baseline={markerTone(point, index) === "baseline"}
              class:improvement={markerTone(point, index) === "improvement"}
              class:regression={markerTone(point, index) === "regression"}
              class:neutral={markerTone(point, index) === "neutral"}
              class:pareto={point.pareto}
              fill={markerFill(point, index)}
              stroke={point.pareto ? "#efbd65" : "#07110f"}
              stroke-width={point.pareto ? 4 : 3}
            />
            <title>{pointDescription(point)}</title>
            <text x={x(index)} y={height - 17} text-anchor="middle" class="x-label" class:leader-label={point.leader} class:best-label={point.best}>base</text>
          </g>
        {:else}
          <a
            href={`/experiments/${point.id}`}
            class="point interactive"
            class:active={activePointId === point.id}
            aria-label={pointDescription(point)}
            style={`--point-delay: ${Math.min(index * 45, 420)}ms`}
            onmouseenter={() => activePointId = point.id}
            onmouseleave={() => activePointId = null}
            onfocus={() => activePointId = point.id}
            onblur={() => activePointId = null}
          >
            {#if point.best}<circle cx={x(index)} cy={y(point.value)} r="12" class="best-ring" />{/if}
            {#if point.leader}<circle cx={x(index)} cy={y(point.value)} r="10" class="leader-ring" />{/if}
            <circle
              cx={x(index)}
              cy={y(point.value)}
              r="6"
              class="marker"
              class:baseline={markerTone(point, index) === "baseline"}
              class:improvement={markerTone(point, index) === "improvement"}
              class:regression={markerTone(point, index) === "regression"}
              class:neutral={markerTone(point, index) === "neutral"}
              class:pareto={point.pareto}
              fill={markerFill(point, index)}
              stroke={point.pareto ? "#efbd65" : "#07110f"}
              stroke-width={point.pareto ? 4 : 3}
            />
            <title>{pointDescription(point)}</title>
            <text x={x(index)} y={height - 17} text-anchor="middle" class="x-label" class:leader-label={point.leader} class:best-label={point.best}>{point.id.replace("exp-", "")}</text>
          </a>
        {/if}
      {/each}

      {#if activePoint && activeIndex >= 0}
        <g class="chart-tooltip" transform={`translate(${tooltipX(activeIndex)}, ${tooltipY(activePoint)})`} aria-hidden="true">
          <rect width={tooltipWidth} height={tooltipHeight} rx="9" />
          <text x="13" y="20" class="tooltip-title">{activePoint.id}</text>
          <text x={tooltipWidth - 13} y="20" text-anchor="end" class="tooltip-status">{activePoint.status}</text>
          <line x1="13" y1="30" x2={tooltipWidth - 13} y2="30" />
          <text x="13" y="48" class="tooltip-label">{metricName}</text>
          <text x={tooltipWidth - 13} y="48" text-anchor="end" class="tooltip-value">{formatMetric(activePoint.value, metricFormat)}</text>
          <text x="13" y="67" class="tooltip-label">vs baseline</text>
          <text x={tooltipWidth - 13} y="67" text-anchor="end" class:positive={baselineGain(activePoint) > 0} class:negative={baselineGain(activePoint) < 0}>{signedMetric(baselineGain(activePoint), metricFormat)} · {formatPercent(baselineRatio(activePoint), 2)}</text>
          <text x="13" y="86" class="tooltip-label">vs parent</text>
          <text x={tooltipWidth - 13} y="86" text-anchor="end" class:positive={(activePoint.parentDelta ?? 0) > 0} class:negative={(activePoint.parentDelta ?? 0) < 0}>{activePoint.id === "baseline" ? "reference" : `${signedMetric(activePoint.parentDelta, metricFormat)} · ${activePoint.parentId}`}</text>
          <text x="13" y="105" class="tooltip-label">strategy</text>
          <text x={tooltipWidth - 13} y="105" text-anchor="end">{activePoint.strategy}{activePoint.pareto ? " · Pareto" : ""}</text>
          <text x="13" y="120" class="tooltip-hint">{activePoint.id === "baseline" ? "Reference checkpoint" : "Click to open experiment details →"}</text>
        </g>
      {/if}
    </svg>
  {/if}
</div>

<style>
  .chart-legend { display: flex; flex-wrap: wrap; gap: 7px 14px; padding: 14px 0 2px; color: #789188; font-size: 9px; letter-spacing: .02em; }
  .chart-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .key { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #8fa79f; }
  .baseline-key { width: 15px; height: 0; border-top: 1px dashed #8fa79f; border-radius: 0; background: none; }
  .improvement-key { background: #5de19e; }
  .regression-key { background: #ff7474; }
  .leader-key { border: 1.5px solid #5de19e; background: transparent; }
  .best-key { border: 1.5px dashed #73aaf8; background: transparent; }
  .pareto-key { border: 2px solid #efbd65; background: transparent; }
  .chart { width: 100%; overflow-x: auto; }
  svg { display: block; width: 100%; min-width: 620px; height: auto; overflow: visible; }
  .grid { stroke: rgba(157,190,178,.1); stroke-width: 1; }
  .baseline-line { stroke: rgba(190,211,204,.48); stroke-width: 1.2; stroke-dasharray: 5 5; }
  .baseline-label { fill: #9eb2ab; font: 8px "SFMono-Regular", monospace; letter-spacing: .03em; }
  .series { fill: none; stroke: rgba(203,222,215,.4); stroke-width: 1.5; stroke-dasharray: 1; stroke-dashoffset: 1; animation: chart-draw .7s var(--ease-out) forwards; }
  .point { outline: none; }
  .point.interactive { cursor: pointer; }
  circle { stroke: #07110f; stroke-width: 3; transform-box: fill-box; transform-origin: center; transition: filter .22s var(--ease-standard), transform .22s var(--ease-out); }
  circle.marker { animation: marker-enter .36s var(--ease-out) backwards; animation-delay: var(--point-delay); }
  circle.baseline { fill: #8fa79f; }
  circle.improvement { fill: #5de19e; }
  circle.regression { fill: #ff7474; }
  circle.neutral { fill: #efbd65; }
  circle.pareto { stroke: #efbd65; stroke-width: 4; }
  circle.leader-ring { fill: none; stroke: rgba(93,225,158,.75); stroke-width: 1.4; }
  circle.best-ring { fill: none; stroke: rgba(115,170,248,.8); stroke-width: 1.4; stroke-dasharray: 2.2 2.2; }
  .axis-label, .x-label { fill: #8fa79f; font-family: "SFMono-Regular", monospace; font-size: 10px; }
  .leader-label { fill: #5de19e; font-weight: 800; }
  .best-label { text-decoration: underline; text-decoration-color: #73aaf8; }
  .point:hover circle:not(.leader-ring, .best-ring), .point.active circle:not(.leader-ring, .best-ring), .point:focus circle:not(.leader-ring, .best-ring) { filter: drop-shadow(0 0 5px currentColor); transform: scale(1.3); }
  .point:focus circle.best-ring, .point:focus circle.leader-ring { stroke-width: 2.2; }
  .chart-tooltip { pointer-events: none; filter: drop-shadow(0 10px 18px rgba(0,0,0,.38)); animation: tooltip-enter .14s var(--ease-out) both; }
  .chart-tooltip rect { fill: #0a1b17; stroke: rgba(157,190,178,.28); stroke-width: 1; }
  .chart-tooltip line { stroke: rgba(157,190,178,.12); }
  .chart-tooltip text { fill: #bdd0c9; font: 8px "SFMono-Regular", monospace; }
  .chart-tooltip .tooltip-title { fill: #eef7f4; font-size: 10px; font-weight: 800; }
  .chart-tooltip .tooltip-status { fill: #8fa79f; font-size: 7.5px; text-transform: uppercase; }
  .chart-tooltip .tooltip-label { fill: #708a81; }
  .chart-tooltip .tooltip-value { fill: #e5f0ec; font-weight: 800; }
  .chart-tooltip .tooltip-hint { fill: #719086; font-size: 7px; }
  .chart-tooltip .positive { fill: #5de19e; }
  .chart-tooltip .negative { fill: #ff7474; }
  @keyframes chart-draw { to { stroke-dashoffset: 0; } }
  @keyframes marker-enter { from { transform: scale(.72); } to { transform: scale(1); } }
  @keyframes tooltip-enter { from { opacity: 0; } to { opacity: 1; } }
</style>
