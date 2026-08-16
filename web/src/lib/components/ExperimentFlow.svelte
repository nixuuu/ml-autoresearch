<script lang="ts">
  import { Background, BackgroundVariant, Controls, MiniMap, SvelteFlow, type Edge } from "@xyflow/svelte";
  import type { RunState } from "$lib/types";
  import ExperimentNode, { type ExperimentNodeData, type ExperimentNodeType } from "./ExperimentNode.svelte";

  let { run }: { run: RunState } = $props();
  let nodes = $state.raw<ExperimentNodeType[]>([]);
  let edges = $state.raw<Edge[]>([]);
  const nodeTypes = { experiment: ExperimentNode };

  function graphElements(current: RunState): { nodes: ExperimentNodeType[]; edges: Edge[] } {
    const primaryName = current.primaryMetric?.name ?? Object.keys(current.acceptedMetrics)[0] ?? "primary";
    const graphNodes = new Map(current.researchGraph?.nodes.map((node) => [node.id, node]) ?? []);
    const records = [{ id: "baseline", parentId: undefined }, ...current.experiments.map((experiment) => ({ id: experiment.id, parentId: experiment.parentId ?? "baseline" }))];
    const depths = new Map<string, number>([["baseline", 0]]);
    for (const record of records.slice(1)) depths.set(record.id, (depths.get(record.parentId ?? "baseline") ?? 0) + 1);
    const groups = new Map<number, string[]>();
    for (const record of records) groups.set(depths.get(record.id) ?? 0, [...(groups.get(depths.get(record.id) ?? 0) ?? []), record.id]);

    const resultNodes: ExperimentNodeType[] = records.map((record) => {
      const depth = depths.get(record.id) ?? 0;
      const peers = groups.get(depth) ?? [record.id];
      const verticalIndex = peers.indexOf(record.id);
      if (record.id === "baseline") {
        const topology = graphNodes.get("baseline")?.status ?? (current.researchGraph?.leaderId === "baseline" ? "leader" : "retired");
        return {
          id: "baseline",
          type: "experiment",
          position: { x: 0, y: Math.max(0, (Math.max(...[...groups.values()].map((group) => group.length)) - 1) * 72) },
          data: {
            label: "baseline",
            metricName: primaryName,
            metricValue: current.baseline.aggregatedMetrics[primaryName],
            decision: "baseline",
            topology,
            category: "reference",
            baseline: true,
            href: "/",
          },
          draggable: false,
        };
      }
      const experiment = current.experiments.find((candidate) => candidate.id === record.id)!;
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
        href: `/experiments/${experiment.id}`,
      };
      return {
        id: experiment.id,
        type: "experiment",
        position: { x: depth * 285, y: verticalIndex * 148 },
        data,
        draggable: false,
      };
    });

    const resultEdges: Edge[] = current.experiments.map((experiment) => {
      const delta = experiment.decision.primaryDelta;
      const stroke = delta === null ? "#71857e" : delta > 0 ? "#5de19e" : delta < 0 ? "#ff7474" : "#8fa79f";
      return {
        id: `${experiment.parentId ?? "baseline"}-${experiment.id}`,
        source: experiment.parentId ?? "baseline",
        target: experiment.id,
        type: "smoothstep",
        animated: current.status === "running" && experiment.id === current.experiments.at(-1)?.id,
        label: experiment.strategy ?? "legacy",
        style: `stroke: ${stroke}; stroke-width: 1.5`,
        labelStyle: `fill: #8fa79f; font-size: 9px`,
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
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    fitView
    minZoom={0.2}
    maxZoom={1.6}
    nodesConnectable={false}
    nodesDraggable={false}
    elementsSelectable={true}
    colorMode="dark"
  >
    <Background variant={BackgroundVariant.Dots} gap={18} size={1} patternColor="#29443b" />
    <Controls showLock={false} />
    <MiniMap pannable zoomable />
  </SvelteFlow>
</div>

<style>
  .flow-wrap { height: 510px; border-top: 1px solid rgba(157,190,178,.12); border-radius: 0 0 16px 16px; overflow: hidden; background: rgba(5,14,11,.5); }
  :global(.svelte-flow__edge-textbg) { fill: #0b1b17; }
  :global(.svelte-flow__controls) { border: 1px solid rgba(157,190,178,.16); border-radius: 9px; overflow: hidden; box-shadow: none; }
  :global(.svelte-flow__controls-button) { border-color: rgba(157,190,178,.12); background: #12241f; fill: #afc2bb; }
  :global(.svelte-flow__minimap) { border: 1px solid rgba(157,190,178,.14); border-radius: 9px; background: #0b1b17; }
</style>
