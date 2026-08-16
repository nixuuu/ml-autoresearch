<script module lang="ts">
  import type { Node } from "@xyflow/svelte";

  export type ExperimentNodeData = {
    label: string;
    metricName: string;
    metricValue?: number;
    delta?: number | null;
    decision: string;
    topology: string;
    category: string;
    baseline?: boolean;
    href: string;
  };
  export type ExperimentNodeType = Node<ExperimentNodeData, "experiment">;
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { formatMetric, improvementClass, signedMetric, statusTone } from "$lib/format";

  let { data }: NodeProps<ExperimentNodeType> = $props();
</script>

<div class="node-shell">
  <Handle type="target" position={Position.Left} />
  <a
    href={data.href}
    class="experiment-node nodrag"
    class:leader={data.topology === "leader"}
    class:frontier={data.topology === "frontier"}
    class:discarded={data.topology === "discarded" || data.topology === "failed"}
    onpointerdown={(event) => event.stopPropagation()}
    onpointerup={(event) => {
      event.stopPropagation();
      window.location.assign(data.href);
    }}
    onclick={(event) => {
      event.stopPropagation();
      window.location.assign(data.href);
    }}
  >
    <div class="node-top">
      <strong>{data.label}</strong>
      <span class="dot {statusTone(data.decision as Parameters<typeof statusTone>[0])}"></span>
    </div>
    <span class="category">{data.category}</span>
    <div class="metric">
      <small>{data.metricName}</small>
      <b>{formatMetric(data.metricValue)}</b>
    </div>
    <div class="node-bottom">
      <span class={improvementClass(data.delta)}>{data.baseline ? "reference" : signedMetric(data.delta)}</span>
      <span>{data.topology}</span>
    </div>
  </a>
  <Handle type="source" position={Position.Right} />
</div>

<style>
  .node-shell { width: 218px; }
  .experiment-node { display: block; width: 218px; padding: 13px 14px; border: 1px solid rgba(157,190,178,.2); border-radius: 13px; background: #10231e; color: #e7f0ed; text-decoration: none; box-shadow: 0 12px 26px rgba(0,0,0,.2); transition: border-color .2s, transform .2s; }
  .experiment-node:hover { transform: translateY(-1px); border-color: rgba(157,190,178,.42); }
  .experiment-node.leader { border-color: rgba(93,225,158,.72); box-shadow: 0 0 0 2px rgba(93,225,158,.08), 0 12px 30px rgba(0,0,0,.2); }
  .experiment-node.frontier { border-color: rgba(115,170,248,.58); }
  .experiment-node.discarded { opacity: .7; }
  .node-top, .node-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .node-top strong { font-size: 12px; letter-spacing: .03em; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #8fa79f; }
  .dot.improvement { background: #5de19e; box-shadow: 0 0 0 4px rgba(93,225,158,.08); }
  .dot.regression { background: #ff7474; }
  .dot.warning { background: #efbd65; }
  .category { display: block; overflow: hidden; margin-top: 3px; color: #8fa79f; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase; letter-spacing: .07em; }
  .metric { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 12px 0 8px; }
  .metric small { overflow: hidden; color: #8fa79f; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
  .metric b { font-family: "SFMono-Regular", monospace; font-size: 15px; }
  .node-bottom { padding-top: 8px; border-top: 1px solid rgba(157,190,178,.12); color: #8fa79f; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
  .improvement { color: #5de19e; }
  .regression { color: #ff7474; }
  :global(.svelte-flow__handle) { width: 7px; height: 7px; border: 1px solid #07110f; background: #6d8e83; }
</style>
