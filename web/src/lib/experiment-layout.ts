export type ExperimentLayoutRecord = {
  id: string;
  order: number;
  parentId?: string;
  sourceIds?: string[];
};

export type ExperimentLayoutPosition = {
  depth: number;
  lane: number;
  x: number;
  y: number;
};

export type ExperimentLayout = {
  positions: Map<string, ExperimentLayoutPosition>;
  predecessors: Map<string, string[]>;
};

const COLUMN_SPACING = 360;
const ROW_SPACING = 168;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizedRanks(layers: Map<number, string[]>): Map<string, number> {
  const result = new Map<string, number>();
  for (const layer of layers.values()) {
    const divisor = Math.max(1, layer.length - 1);
    layer.forEach((id, index) => result.set(id, layer.length === 1 ? 0.5 : index / divisor));
  }
  return result;
}

function averageNeighborRank(ids: string[], ranks: Map<string, number>): number | undefined {
  const values = ids.flatMap((id) => {
    const rank = ranks.get(id);
    return rank === undefined ? [] : [rank];
  });
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Produces a stable layered layout for the experiment DAG. Repeated forward and
 * backward barycentric sweeps keep related branches close and reduce crossings
 * without making the dashboard depend on a heavyweight layout runtime.
 */
export function layoutExperimentGraph(records: ExperimentLayoutRecord[]): ExperimentLayout {
  const ordered = [...records].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const recordById = new Map(ordered.map((record) => [record.id, record]));
  const orderById = new Map(ordered.map((record) => [record.id, record.order]));
  const predecessors = new Map<string, string[]>();

  for (const record of ordered) {
    if (record.id === "baseline") {
      predecessors.set(record.id, []);
      continue;
    }
    const candidates = unique([record.parentId ?? "baseline", ...(record.sourceIds ?? [])]);
    const valid = candidates.filter((id) => {
      if (!recordById.has(id) || id === record.id) return false;
      return (orderById.get(id) ?? Number.POSITIVE_INFINITY) < record.order;
    });
    predecessors.set(record.id, valid.length > 0 ? valid : ["baseline"]);
  }

  const depths = new Map<string, number>([["baseline", 0]]);
  for (const record of ordered) {
    if (record.id === "baseline") continue;
    const parentDepths = (predecessors.get(record.id) ?? ["baseline"]).map((id) => depths.get(id) ?? 0);
    depths.set(record.id, Math.max(...parentDepths, 0) + 1);
  }

  const layers = new Map<number, string[]>();
  for (const record of ordered) {
    const depth = depths.get(record.id) ?? 0;
    layers.set(depth, [...(layers.get(depth) ?? []), record.id]);
  }

  const successors = new Map(ordered.map((record) => [record.id, [] as string[]]));
  for (const [targetId, sourceIds] of predecessors) {
    for (const sourceId of sourceIds) successors.set(sourceId, [...(successors.get(sourceId) ?? []), targetId]);
  }

  const maxDepth = Math.max(0, ...layers.keys());
  const stableOrder = (leftId: string, rightId: string) =>
    (orderById.get(leftId) ?? 0) - (orderById.get(rightId) ?? 0) || leftId.localeCompare(rightId);

  const sortLayer = (depth: number, neighbors: Map<string, string[]>) => {
    const layer = layers.get(depth);
    if (!layer || layer.length < 2) return;
    const ranks = normalizedRanks(layers);
    layer.sort((leftId, rightId) => {
      const left = averageNeighborRank(neighbors.get(leftId) ?? [], ranks) ?? ranks.get(leftId) ?? 0.5;
      const right = averageNeighborRank(neighbors.get(rightId) ?? [], ranks) ?? ranks.get(rightId) ?? 0.5;
      return left - right || stableOrder(leftId, rightId);
    });
  };

  for (let sweep = 0; sweep < 6; sweep += 1) {
    for (let depth = 1; depth <= maxDepth; depth += 1) sortLayer(depth, predecessors);
    for (let depth = maxDepth - 1; depth >= 0; depth -= 1) sortLayer(depth, successors);
  }

  const widestLayer = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const graphHeight = (widestLayer - 1) * ROW_SPACING;
  const positions = new Map<string, ExperimentLayoutPosition>();
  for (const [depth, layer] of layers) {
    const layerHeight = (layer.length - 1) * ROW_SPACING;
    const startY = (graphHeight - layerHeight) / 2;
    layer.forEach((id, lane) => positions.set(id, {
      depth,
      lane,
      x: depth * COLUMN_SPACING,
      y: startY + lane * ROW_SPACING,
    }));
  }

  return { positions, predecessors };
}
