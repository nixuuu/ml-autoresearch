import type { ExperimentRecord, HarnessConfig, SearchParameterConfig } from "./types.js";
import { suggestSearchSpace, type JsonValue, type SearchParameter } from "./search-space.js";

type Suggestion = Record<string, string | number | boolean>;

function flattenedKey(parameter: SearchParameterConfig): string {
  return `${parameter.file}:${parameter.path}`;
}

function searchParameter(parameter: SearchParameterConfig): SearchParameter {
  if (parameter.type === "float") return { type: "float", min: parameter.min!, max: parameter.max!, ...(parameter.scale ? { scale: parameter.scale } : {}) };
  if (parameter.type === "integer") return { type: "integer", min: parameter.min!, max: parameter.max! };
  if (parameter.type === "categorical") return { type: "categorical", values: parameter.values! as JsonValue[] };
  return { type: "boolean" };
}

function coordinate(parameter: SearchParameterConfig, value: string | number | boolean): number {
  if (parameter.type === "boolean") return value ? 1 : 0;
  if (parameter.type === "categorical") {
    const values = parameter.values ?? [];
    return Math.max(0, values.indexOf(value)) / Math.max(1, values.length - 1);
  }
  const numeric = Number(value);
  if (parameter.scale === "log") {
    const low = Math.log(parameter.min!);
    return (Math.log(numeric) - low) / Math.max(Number.EPSILON, Math.log(parameter.max!) - low);
  }
  return (numeric - parameter.min!) / Math.max(Number.EPSILON, parameter.max! - parameter.min!);
}

function distance(parameters: SearchParameterConfig[], left: Suggestion, right: Suggestion): number {
  const sum = parameters.reduce((total, parameter) => {
    const key = flattenedKey(parameter);
    if (left[key] === undefined || right[key] === undefined) return total + 1;
    const delta = coordinate(parameter, left[key]!) - coordinate(parameter, right[key]!);
    return total + delta * delta;
  }, 0);
  return Math.sqrt(sum / Math.max(1, parameters.length));
}

export function selectSurrogateSuggestion(
  config: HarnessConfig,
  experiments: ExperimentRecord[],
  experimentIndex: number,
): Suggestion | undefined {
  const search = config.search;
  const policy = search?.surrogate;
  if (!search?.enabled || !policy?.enabled || search.parameters.length === 0) return undefined;
  const observations = experiments.flatMap((experiment) => {
    const suggestion = experiment.plan?.searchSuggestion;
    const improvement = experiment.accounting.primaryImprovement;
    if (!suggestion || improvement === null || !experiment.evaluation.ok) return [];
    return [{ suggestion, improvement, durationMs: Math.max(1, experiment.accounting.evaluatorDurationMs) }];
  });
  if (observations.length < policy.minimumObservations) return undefined;
  const space = Object.fromEntries(search.parameters.map((parameter) => [flattenedKey(parameter), searchParameter(parameter)]));
  const observed = new Set(observations.map((observation) => JSON.stringify(observation.suggestion)));
  const candidates = Array.from({ length: policy.candidatePoolSize }, (_, offset) =>
    suggestSearchSpace(space, search.seed, experimentIndex * policy.candidatePoolSize + offset))
    .map((candidate) => Object.fromEntries(Object.entries(candidate).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]))))
    .filter((candidate) => !observed.has(JSON.stringify(candidate)));
  const neighbors = Math.max(2, Math.min(observations.length, Math.ceil(Math.sqrt(observations.length))));
  return candidates.map((candidate) => {
    const nearest = observations
      .map((observation) => ({ ...observation, distance: distance(search.parameters, candidate, observation.suggestion) }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, neighbors);
    const weights = nearest.map((entry) => 1 / Math.max(0.02, entry.distance));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const mean = nearest.reduce((sum, entry, index) => sum + entry.improvement * weights[index]!, 0) / totalWeight;
    const variance = nearest.reduce((sum, entry, index) => sum + weights[index]! * (entry.improvement - mean) ** 2, 0) / totalWeight;
    const duration = nearest.reduce((sum, entry, index) => sum + entry.durationMs * weights[index]!, 0) / totalWeight;
    const acquisition = (mean + policy.explorationWeight * Math.sqrt(Math.max(0, variance))) / Math.sqrt(Math.max(1, duration));
    return { candidate, acquisition };
  }).sort((left, right) => right.acquisition - left.acquisition)[0]?.candidate;
}
