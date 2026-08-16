import { readFile, writeFile } from "node:fs/promises";
import type { HarnessConfig, ParameterSweepRequest, SearchParameterConfig, SweepValue } from "./types.js";
import { applySearchSuggestion, type JsonValue } from "./search-space.js";
import { resolveSafeWorkspacePath } from "./workspace.js";

export interface ResolvedSweepParameter {
  parameter: SearchParameterConfig;
  values: SweepValue[];
}

function serialized(value: SweepValue): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function validateValue(parameter: SearchParameterConfig, value: SweepValue): string | undefined {
  if (parameter.type === "boolean") return typeof value === "boolean" ? undefined : "must be boolean";
  if (parameter.type === "categorical") {
    return parameter.values?.some((candidate) => serialized(candidate) === serialized(value))
      ? undefined
      : `must be one of ${JSON.stringify(parameter.values ?? [])}`;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return "must be a finite number";
  if (parameter.type === "integer" && !Number.isInteger(value)) return "must be an integer";
  if (parameter.min !== undefined && value < parameter.min) return `must be >= ${parameter.min}`;
  if (parameter.max !== undefined && value > parameter.max) return `must be <= ${parameter.max}`;
  return undefined;
}

export function resolveParameterSweep(config: HarnessConfig, request: ParameterSweepRequest): ResolvedSweepParameter {
  const policy = config.search?.sweeps;
  if (!config.search?.enabled || !policy?.enabled) throw new Error("Parameter sweeps are disabled by search.sweeps");
  const parameter = config.search.parameters.find((candidate) => candidate.name === request.parameter);
  if (!parameter) throw new Error(`Unknown sweep parameter ${request.parameter}; use a name declared in search.parameters`);
  if (request.values.length < 2) throw new Error("A parameter sweep requires at least two values");
  if (request.values.length > policy.maxValues) throw new Error(`Parameter sweep requested ${request.values.length} values; maximum is ${policy.maxValues}`);
  const unique = new Set(request.values.map(serialized));
  if (unique.size !== request.values.length) throw new Error("Parameter sweep values must be unique");
  request.values.forEach((value, index) => {
    const error = validateValue(parameter, value);
    if (error) throw new Error(`Parameter sweep value ${index + 1} for ${parameter.name} ${error}`);
  });
  return { parameter, values: [...request.values] };
}

function readPath(document: unknown, dottedPath: string): SweepValue | undefined {
  let current = document;
  for (const segment of dottedPath.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" || typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))
    ? current
    : undefined;
}

export async function readSweepReferenceValue(
  config: HarnessConfig,
  workspacePath: string,
  parameter: SearchParameterConfig,
): Promise<SweepValue | undefined> {
  const { absolutePath } = await resolveSafeWorkspacePath(workspacePath, parameter.file, {
    requireMutable: config.project.mutablePaths,
    protectedPaths: config.project.protectedPaths,
  });
  return readPath(JSON.parse(await readFile(absolutePath, "utf8")) as unknown, parameter.path);
}

export async function applySweepValue(
  config: HarnessConfig,
  workspacePath: string,
  parameter: SearchParameterConfig,
  value: SweepValue,
): Promise<void> {
  const error = validateValue(parameter, value);
  if (error) throw new Error(`Invalid value for sweep parameter ${parameter.name}: ${error}`);
  const { absolutePath } = await resolveSafeWorkspacePath(workspacePath, parameter.file, {
    requireMutable: config.project.mutablePaths,
    protectedPaths: config.project.protectedPaths,
  });
  const document = JSON.parse(await readFile(absolutePath, "utf8")) as JsonValue;
  const updated = applySearchSuggestion(document, { [parameter.path]: value });
  await writeFile(absolutePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}

export async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
