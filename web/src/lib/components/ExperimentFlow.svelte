<script lang="ts">
  import { Background, BackgroundVariant, Controls, MiniMap, SvelteFlow } from "@xyflow/svelte";
  import { layoutExperimentGraph, type ExperimentLayoutRecord } from "$lib/experiment-layout";
  import type { RunState } from "$lib/types";
  import ExperimentEdge, { type ExperimentEdgeType } from "./ExperimentEdge.svelte";
  import ExperimentNode, { type ExperimentNodeData, type ExperimentNodeType } from "./ExperimentNode.svelte";

  type EdgeDraft = Omit<ExperimentEdgeType, "data"> & { merge?: boolean };

  let { run }: { run: RunState } = $props();
  let nodes = $state.raw<ExperimentNodeType[]>([]);
  let edges = $state.raw<ExperimentEdgeType[]>([]);
  const nodeTypes = { experiment: ExperimentNode };
  const edgeTypes = { "experiment-route": ExperimentEdge };

  function handleOffsets(count: number): number[] {
    if (count <= 0) return [];
    if (count === 1) return [50];
    const start = count > 5 ? 16 : 22;
    const end = 100 - start;
    return Array.from({ length: count }, (_, index) => start + (index * (end - start)) / (count - 1));
  }

  function graphElements(current: RunState): { nodes: ExperimentNodeType[]; edges: ExperimentEdgeType[] } {
    const primaryName = current.primaryMetric?.name ?? Object.keys(current.acceptedMetrics)[0] ?? "primary";
    const graphNodes = new Map(current.researchGraph?.nodes.map((node) => [node.id, node]) ?? []);
    const experimentById = new Map(current.experiments.map((experiment) => [experiment.id, experiment]));
    const records: ExperimentLayoutRecord[] = [
      { id: "baseline", order: 0 },
      ...current.experiments.map((experiment, index) => ({
        id: experiment.id,
        order: index + 1,
        parentId: experiment.parentId ?? "baseline",
        sourceIds: graphNodes.get(experiment.id)?.sourceIds ?? experiment.plan?.merge?.sourceExperimentIds,
      })),
    ];
    const layout = layoutExperimentGraph(records);

    const edgeDrafts: EdgeDraft[] = current.experiments.flatMap((experiment) => {
      const delta = experiment.decision.primaryDelta;
      const stroke = delta === null ? "#71857e" : delta > 0 ? "#5de19e" : delta < 0 ? "#ff7474" : "#8fa79f";
      const parentId = layout.predecessors.get(experiment.id)?.includes(experiment.parentId ?? "baseline")
        ? experiment.parentId ?? "baseline"
        : "baseline";
      const parentEdge: EdgeDraft = {
        id: `${parentId}-${experiment.id}`,
        source: parentId,
        target: experiment.id,
        type: "experiment-route",
        animated: current.status === "running" && experiment.id === current.experiments.at(-1)?.id,
        label: experiment.strategy ?? "legacy",
        style: `stroke: ${stroke}; stroke-width: 1.5`,
        labelStyle: "color: #a9bbb5; font-size: 9px; padding: 2px 4px; border-radius: 4px; background: rgba(11, 27, 23, .92)",
        interactionWidth: 14,
        zIndex: 1,
      };
      const mergeSources = graphNodes.get(experiment.id)?.sourceIds ?? experiment.plan?.merge?.sourceExperimentIds ?? [];
      const sourceEdges: EdgeDraft[] = mergeSources
        .filter((sourceId) => sourceId !== parentId && layout.predecessors.get(experiment.id)?.includes(sourceId))
        .map((sourceId) => ({
          id: `${sourceId}-${experiment.id}-merge`,
          source: sourceId,
          target: experiment.id,
          type: "experiment-route",
          animated: current.status === "running" && experiment.id === current.experiments.at(-1)?.id,
          style: "stroke: #efbd65; stroke-width: 1.35; stroke-dasharray: 5 4",
          label: "merge",
          labelStyle: "color: #efbd65; font-size: 9px; padding: 2px 4px; border-radius: 4px; background: rgba(11, 27, 23, .92)",
          interactionWidth: 14,
          zIndex: 2,
          merge: true,
        }));
      return [parentEdge, ...sourceEdges];
    });

    const outgoing = new Map<string, EdgeDraft[]>();
    const incoming = new Map<string, EdgeDraft[]>();
    for (const edge of edgeDrafts) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
      incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    }
    const positionOf = (id: string) => layout.positions.get(id) ?? { depth: 0, lane: 0, x: 0, y: 0 };
    for (const list of outgoing.values()) {
      list.sort((left, right) => positionOf(left.target).y - positionOf(right.target).y || left.id.localeCompare(right.id));
    }
    for (const list of incoming.values()) {
      list.sort((left, right) => positionOf(left.source).y - positionOf(right.source).y || left.id.localeCompare(right.id));
    }

    const corridors = new Map<string, EdgeDraft[]>();
    for (const edge of edgeDrafts) {
      const corridor = `${positionOf(edge.source).depth}:${positionOf(edge.target).depth}`;
      corridors.set(corridor, [...(corridors.get(corridor) ?? []), edge]);
    }
    for (const list of corridors.values()) {
      list.sort((left, right) =>
        positionOf(left.target).y - positionOf(right.target).y
        || positionOf(left.source).y - positionOf(right.source).y
        || left.id.localeCompare(right.id));
    }

    const resultEdges: ExperimentEdgeType[] = edgeDrafts.map((edge) => {
      const sourceSlot = outgoing.get(edge.source)?.findIndex((candidate) => candidate.id === edge.id) ?? 0;
      const targetSlot = incoming.get(edge.target)?.findIndex((candidate) => candidate.id === edge.id) ?? 0;
      const corridor = corridors.get(`${positionOf(edge.source).depth}:${positionOf(edge.target).depth}`) ?? [edge];
      const laneIndex = corridor.findIndex((candidate) => candidate.id === edge.id);
      const { merge: _merge, ...edgeProperties } = edge;
      return {
        ...edgeProperties,
        sourceHandle: `out-${sourceSlot}`,
        targetHandle: `in-${targetSlot}`,
        data: { laneIndex: Math.max(0, laneIndex), laneCount: corridor.length },
      };
    });

    const resultNodes: ExperimentNodeType[] = records.map((record) => {
      const position = positionOf(record.id);
      const targetHandles = handleOffsets(incoming.get(record.id)?.length ?? 0).map((offset, index) => ({ id: `in-${index}`, offset }));
      const sourceHandles = handleOffsets(outgoing.get(record.id)?.length ?? 0).map((offset, index) => ({ id: `out-${index}`, offset }));
      if (record.id === "baseline") {
        const topology = graphNodes.get("baseline")?.status ?? (current.researchGraph?.leaderId === "baseline" ? "leader" : "retired");
        return {
          id: "baseline",
          type: "experiment",
          position: { x: position.x, y: position.y },
          data: {
            label: "baseline",
            metricName: primaryName,
            metricValue: current.baseline.aggregatedMetrics[primaryName],
            decision: "baseline",
            topology,
            category: "reference",
            baseline: true,
            active: current.status === "running" && current.experiments.length === 0,
            paretoOptimal: current.researchGraph?.paretoFrontierIds?.includes("baseline") ?? false,
            operation: "reference",
            targetHandles,
            sourceHandles,
            href: "/",
          },
          draggable: false,
        };
      }
      const experiment = experimentById.get(record.id)!;
      const topology = graphNodes.get(record.id)?.status
        ?? (experiment.strategy === "replicate" || (experiment.pairedEvaluation && experiment.duplicateOf) ? "audit-only" : "not-in-frontier");
      const data: ExperimentNodeData = {
        label: experiment.id,
        metricName: primaryName,
        metricValue: experiment.evaluation.aggregatedMetrics[primaryName],
        delta: experiment.decision.primaryDelta,
        decision: experiment.decision.status,
        topology,
        category: experiment.plan?.changeCategory ?? "other",
        active: current.status === "running" && experiment.id === current.experiments.at(-1)?.id,
        paretoOptimal: graphNodes.get(record.id)?.paretoOptimal ?? experiment.decision.paretoOptimal,
        operation: experiment.strategy,
        sourceIds: graphNodes.get(record.id)?.sourceIds ?? experiment.plan?.merge?.sourceExperimentIds,
        targetHandles,
        sourceHandles,
        href: `/experiments/${experiment.id}`,
      };
      return {
        id: experiment.id,
        type: "experiment",
        position: { x: position.x, y: position.y },
        data,
        draggable: false,
      };
    });

    return { nodes: resultNodes, edges: resultEdges };
  }

  $effect(() => {
    const next = graphElements(run);
    nodes = next.nodes;
    edges = next.edges;
  });
</script>

<div class="flow-wrap">
  {#key nodes.map((node) => node.id).join("|")}
    <SvelteFlow
      bind:nodes
      bind:edges
      {nodeTypes}
      {edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.16, minZoom: 0.2, maxZoom: 1, duration: 500 }}
      defaultEdgeOptions={{ zIndex: 1 }}
      minZoom={0.16}
      maxZoom={1.6}
      nodesConnectable={false}
      nodesDraggable={false}
      elementsSelectable={true}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} patternColor="#29443b" />
      <Controls showLock={false} fitViewOptions={{ padding: 0.16, maxZoom: 1, duration: 350 }} />
      <MiniMap pannable zoomable />
    </SvelteFlow>
  {/key}
</div>

<style>
  .flow-wrap { height: calc(100dvh - var(--topbar-height)); border-top: 1px solid rgba(157,190,178,.12); border-radius: 0 0 16px 16px; overflow: hidden; background: rgba(5,14,11,.5); animation: flow-reveal .55s var(--ease-out) both; }
  :global(.svelte-flow__edge-path) { transition: stroke .25s var(--ease-standard), stroke-width .25s var(--ease-standard), opacity .25s var(--ease-standard); }
  :global(.svelte-flow__edge:hover .svelte-flow__edge-path) { stroke-width: 2.5 !important; filter: drop-shadow(0 0 4px currentColor); }
  :global(.svelte-flow__edge-textbg) { fill: #0b1b17; fill-opacity: .92; }
  :global(.svelte-flow__edge-text) { paint-order: stroke; stroke: #0b1b17; stroke-width: 3px; }
  :global(.svelte-flow__controls) { border: 1px solid rgba(157,190,178,.16); border-radius: 9px; overflow: hidden; box-shadow: none; }
  :global(.svelte-flow__controls-button) { border-color: rgba(157,190,178,.12); background: #12241f; fill: #afc2bb; }
  :global(.svelte-flow__minimap) { border: 1px solid rgba(157,190,178,.14); border-radius: 9px; background: #0b1b17; }
  @keyframes flow-reveal { from { opacity: 0; clip-path: inset(0 0 100% 0 round 0 0 16px 16px); } to { opacity: 1; clip-path: inset(0 0 0 0 round 0 0 16px 16px); } }
</style>
