export type FlowPosition = { x: number; y: number };

type TransitionNode = {
  id: string;
  position: FlowPosition;
  data: unknown;
  selected?: boolean;
};

type TransitionEdge = {
  source: string;
  target: string;
};

export type NodeTransitionPlan<NodeType extends TransitionNode> = {
  startNodes: NodeType[];
  targetNodes: NodeType[];
  shouldAnimate: boolean;
};

function samePosition(left: FlowPosition, right: FlowPosition): boolean {
  return Math.abs(left.x - right.x) < 0.01 && Math.abs(left.y - right.y) < 0.01;
}

function cloneData<Data>(data: Data): Data {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  return { ...data };
}

function spawnPosition<NodeType extends TransitionNode>(
  node: NodeType,
  currentById: Map<string, NodeType>,
  targetById: Map<string, NodeType>,
  edges: TransitionEdge[],
): FlowPosition {
  const incoming = edges.find((edge) => edge.target === node.id);
  const source = incoming ? currentById.get(incoming.source) ?? targetById.get(incoming.source) : undefined;
  if (!source) return { x: node.position.x - 48, y: node.position.y };
  return {
    x: source.position.x + (node.position.x - source.position.x) * 0.28,
    y: source.position.y + (node.position.y - source.position.y) * 0.18,
  };
}

/**
 * Reconciles Svelte Flow nodes by id. Existing runtime state is retained while
 * new nodes begin near their incoming edge source and move into the DAG layout.
 */
export function planNodeTransition<NodeType extends TransitionNode>(
  currentNodes: NodeType[],
  nextNodes: NodeType[],
  nextEdges: TransitionEdge[],
): NodeTransitionPlan<NodeType> {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  const targetNodes = nextNodes.map((node) => {
    const current = currentById.get(node.id);
    return {
      ...node,
      data: cloneData(node.data),
      ...(current?.selected === undefined ? {} : { selected: current.selected }),
    } as NodeType;
  });
  const targetById = new Map(targetNodes.map((node) => [node.id, node]));
  let shouldAnimate = false;
  const startNodes = targetNodes.map((node) => {
    const current = currentById.get(node.id);
    const position = current?.position ?? spawnPosition(node, currentById, targetById, nextEdges);
    if (!samePosition(position, node.position)) shouldAnimate = true;
    return { ...node, position: { ...position } } as NodeType;
  });

  return { startNodes, targetNodes, shouldAnimate };
}

export function interpolateNodes<NodeType extends TransitionNode>(
  startNodes: NodeType[],
  targetNodes: NodeType[],
  progress: number,
): NodeType[] {
  const clamped = Math.max(0, Math.min(1, progress));
  const startById = new Map(startNodes.map((node) => [node.id, node]));
  return targetNodes.map((node) => {
    const start = startById.get(node.id)?.position ?? node.position;
    return {
      ...node,
      position: {
        x: start.x + (node.position.x - start.x) * clamped,
        y: start.y + (node.position.y - start.y) * clamped,
      },
    } as NodeType;
  });
}

export function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, progress)), 3);
}
