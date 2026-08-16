<script module lang="ts">
  import type { Edge } from "@xyflow/svelte";

  export type ExperimentEdgeData = {
    laneIndex: number;
    laneCount: number;
  };
  export type ExperimentEdgeType = Edge<ExperimentEdgeData, "experiment-route">;
</script>

<script lang="ts">
  import { BaseEdge, type EdgeProps } from "@xyflow/svelte";
  import { routeExperimentEdge } from "$lib/experiment-edge-routing";

  let {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerStart,
    markerEnd,
    style,
    label,
    labelStyle,
    interactionWidth,
    data,
  }: EdgeProps<ExperimentEdgeType> = $props();

  const route = $derived(routeExperimentEdge({
    sourceX,
    sourceY,
    targetX,
    targetY,
    laneIndex: data?.laneIndex ?? 0,
    laneCount: data?.laneCount ?? 1,
    borderRadius: 10,
  }));
</script>

<BaseEdge
  {id}
  path={route.path}
  labelX={route.labelX}
  labelY={route.labelY}
  {label}
  {labelStyle}
  {markerStart}
  {markerEnd}
  {interactionWidth}
  {style}
/>
