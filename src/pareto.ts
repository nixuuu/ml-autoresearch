import type { HarnessConfig, ObjectiveMetricConfig, ResearchNode } from "./types.js";

export function configuredObjectives(config: HarnessConfig): ObjectiveMetricConfig[] {
  const primary: ObjectiveMetricConfig = { ...config.metrics.primary, weight: 1 };
  const byName = new Map<string, ObjectiveMetricConfig>([[primary.name, primary]]);
  for (const objective of config.metrics.objectives ?? []) byName.set(objective.name, objective);
  return [...byName.values()];
}

export function dominates(
  left: Record<string, number>,
  right: Record<string, number>,
  objectives: ObjectiveMetricConfig[],
): boolean {
  let strictlyBetter = false;
  for (const objective of objectives) {
    const leftValue = left[objective.name];
    const rightValue = right[objective.name];
    if (leftValue === undefined || rightValue === undefined) return false;
    const comparison = objective.direction === "maximize" ? leftValue - rightValue : rightValue - leftValue;
    if (comparison < 0) return false;
    if (comparison > 0) strictlyBetter = true;
  }
  return strictlyBetter;
}

export function paretoFrontier(nodes: ResearchNode[], objectives: ObjectiveMetricConfig[]): ResearchNode[] {
  if (objectives.length === 0) return [];
  return nodes.filter((candidate) =>
    objectives.every((objective) => Number.isFinite(candidate.metrics[objective.name]))
    && !nodes.some((other) => other.id !== candidate.id && dominates(other.metrics, candidate.metrics, objectives)));
}

export function bestByObjective(
  nodes: Array<Pick<ResearchNode, "id" | "metrics">>,
  objectives: ObjectiveMetricConfig[],
): Record<string, { experimentId: string; value: number }> {
  const result: Record<string, { experimentId: string; value: number }> = {};
  for (const objective of objectives) {
    for (const node of nodes) {
      const value = node.metrics[objective.name];
      if (value === undefined || !Number.isFinite(value)) continue;
      const current = result[objective.name];
      if (!current || (objective.direction === "maximize" ? value > current.value : value < current.value)) {
        result[objective.name] = { experimentId: node.id, value };
      }
    }
  }
  return result;
}
