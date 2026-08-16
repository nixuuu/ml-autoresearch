import type {
  AgentPerformance,
  AgentProfileConfig,
  HarnessConfig,
  MetaResearchState,
  ResearchStrategy,
  StrategyPerformance,
} from "./types.js";

const STRATEGIES: ResearchStrategy[] = ["exploit", "explore", "backtrack", "replicate", "falsify", "optimize", "merge", "ablate"];

export function createMetaResearchState(config: HarnessConfig): MetaResearchState {
  const profiles = config.agent.pool?.length
    ? config.agent.pool
    : [config.agent.roles?.implementer ?? { id: "default", ...(config.agent.model ? { model: config.agent.model } : {}), thinkingLevel: config.agent.thinkingLevel }];
  return {
    schemaVersion: 1,
    agentPerformance: profiles.map((profile) => ({ profileId: profile.id, trials: 0, totalReward: 0, meanReward: 0, promotions: 0, failures: 0 })),
    strategyPerformance: STRATEGIES.map((strategy) => ({ strategy, trials: 0, totalReward: 0, meanReward: 0 })),
    policyUpdates: [],
  };
}

function ucbScore(performance: AgentPerformance, totalTrials: number): number {
  if (performance.trials === 0) return Number.POSITIVE_INFINITY;
  return performance.meanReward + Math.sqrt(2 * Math.log(Math.max(totalTrials, 1)) / performance.trials);
}

export function selectAgentProfile(config: HarnessConfig, state: MetaResearchState): AgentProfileConfig {
  const profiles = config.agent.pool?.length
    ? config.agent.pool
    : [config.agent.roles?.implementer ?? { id: "default", ...(config.agent.model ? { model: config.agent.model } : {}), thinkingLevel: config.agent.thinkingLevel }];
  if (!config.learning.meta?.enabled || profiles.length === 1) return profiles[0]!;
  const totalTrials = state.agentPerformance.reduce((sum, item) => sum + item.trials, 0);
  return [...profiles].sort((left, right) => {
    const leftPerformance = state.agentPerformance.find((item) => item.profileId === left.id)!;
    const rightPerformance = state.agentPerformance.find((item) => item.profileId === right.id)!;
    const score = ucbScore(rightPerformance, totalTrials) - ucbScore(leftPerformance, totalTrials);
    return score || left.id.localeCompare(right.id);
  })[0]!;
}

export function normalizedResearchReward(primaryDelta: number | null, referenceValue: number, failed: boolean): number {
  if (failed || primaryDelta === null || !Number.isFinite(primaryDelta)) return -1;
  return Math.max(-1, Math.min(1, primaryDelta / Math.max(Math.abs(referenceValue), 1e-12)));
}

function updateMean<T extends AgentPerformance | StrategyPerformance>(entry: T, reward: number): void {
  entry.trials += 1;
  entry.totalReward += reward;
  entry.meanReward = entry.totalReward / entry.trials;
}

export function recordMetaOutcome(
  state: MetaResearchState,
  profileId: string,
  strategy: ResearchStrategy,
  reward: number,
  outcome: "promote" | "failure" | "other",
): void {
  const agent = state.agentPerformance.find((item) => item.profileId === profileId);
  if (agent) {
    updateMean(agent, reward);
    if (outcome === "promote") agent.promotions += 1;
    if (outcome === "failure") agent.failures += 1;
  }
  const strategyEntry = state.strategyPerformance.find((item) => item.strategy === strategy);
  if (strategyEntry) updateMean(strategyEntry, reward);
}

export function maybeUpdateMetaPolicy(config: HarnessConfig, state: MetaResearchState, experimentIndex: number): void {
  const policy = config.learning.meta;
  if (!policy?.enabled || experimentIndex < policy.warmupExperiments || experimentIndex % policy.updateInterval !== 0) return;
  const active = state.strategyPerformance.filter((entry) => entry.trials > 0 && entry.strategy !== "replicate");
  if (active.length === 0) return;
  const floor = policy.explorationFloor;
  const weights = active.map((entry) => ({ strategy: entry.strategy, weight: Math.exp(Math.max(-4, Math.min(4, entry.meanReward * 8))) }));
  const available = Math.max(0, 1 - floor * weights.length);
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const rates = Object.fromEntries(weights.map((entry) => [entry.strategy, floor + available * entry.weight / total])) as Partial<Record<ResearchStrategy, number>>;
  state.policyUpdates.push({
    experimentIndex,
    reason: `Rebalanced research moves from normalized rewards after ${experimentIndex} experiments`,
    strategyRates: rates,
    createdAt: new Date().toISOString(),
  });
}
