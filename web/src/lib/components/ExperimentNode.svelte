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
    active?: boolean;
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
    class:active={data.active}
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
  .node-shell { width: 218px; animation: node-enter .48s var(--ease-out) both; }
  .experiment-node { position: relative; display: block; width: 218px; overflow: hidden; padding: 13px 14px; border: 1px solid rgba(157,190,178,.2); border-radius: 13px; background: #10231e; color: #e7f0ed; text-decoration: none; box-shadow: 0 12px 26px rgba(0,0,0,.2); transition: border-color .25s var(--ease-standard), box-shadow .25s var(--ease-standard), opacity .25s var(--ease-standard), transform .25s var(--ease-out); }
  .experiment-node:hover { transform: translateY(-1px); border-color: rgba(157,190,178,.42); }
  .experiment-node.leader { border-color: rgba(93,225,158,.72); box-shadow: 0 0 0 2px rgba(93,225,158,.08), 0 12px 30px rgba(0,0,0,.2); }
  .experiment-node.frontier { border-color: rgba(115,170,248,.58); }
  .experiment-node.discarded { opacity: .7; }
  .experiment-node.active { border-color: rgba(115,170,248,.78); box-shadow: 0 0 0 2px rgba(115,170,248,.08), 0 0 32px rgba(115,170,248,.12), 0 12px 30px rgba(0,0,0,.2); }
  .experiment-node.active::after { position: absolute; inset: 0; content: ""; pointer-events: none; background: linear-gradient(105deg, transparent 30%, rgba(115,170,248,.11) 50%, transparent 70%); transform: translateX(-125%); animation: node-scan 2.8s var(--ease-standard) infinite; }
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
  @keyframes node-enter { from { opacity: 0; transform: translateX(-8px) scale(.96); } to { opacity: 1; transform: translateX(0) scale(1); } }
  @keyframes node-scan { 0%, 42% { transform: translateX(-125%); } 72%, 100% { transform: translateX(125%); } }
</style>
