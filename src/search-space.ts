/**
 * Deterministic search-space utilities used by research planners.
 *
 * Suggestions are plain JSON objects keyed by dotted paths.  The module never
 * reads or writes files; applying a suggestion returns a new JSON value.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SearchScale = "linear" | "log";

export interface FloatSearchParameter {
  type: "float";
  min: number;
  max: number;
  step?: number;
  scale?: SearchScale;
  /** Optional when the parameter is stored in a named map. */
  path?: string;
}

export interface IntegerSearchParameter {
  type: "int" | "integer";
  min: number;
  max: number;
  step?: number;
  path?: string;
}

export interface CategoricalSearchParameter {
  type: "categorical";
  values: readonly JsonValue[];
  path?: string;
}

export interface BooleanSearchParameter {
  type: "bool" | "boolean";
  path?: string;
}

export type SearchParameter =
  | FloatSearchParameter
  | IntegerSearchParameter
  | CategoricalSearchParameter
  | BooleanSearchParameter;

export type FloatParameter = FloatSearchParameter;
export type IntParameter = IntegerSearchParameter;
export type CategoricalParameter = CategoricalSearchParameter;
export type BoolParameter = BooleanSearchParameter;
export type SearchSpaceParameter = SearchParameter;

export type SearchSpace = Readonly<Record<string, SearchParameter>>;
export interface SearchSpaceDefinition {
  parameters: SearchSpace;
}
export type SearchSpaceInput = SearchSpace | SearchSpaceDefinition;
export type SearchSuggestion = Record<string, JsonValue>;

export interface SearchSuggestionOptions {
  /** Enables local sampling around `leader`. */
  local?: boolean;
  leader?: JsonValue;
  /** Numeric radius in normalized [0, 1] parameter space; defaults to 0.2. */
  locality?: number;
}

export interface SearchSuggestionRequest extends SearchSuggestionOptions {
  seed: number;
  index: number;
}

export interface SearchSpaceValidationResult {
  valid: boolean;
  errors: string[];
  parameters: Record<string, SearchParameter>;
}

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53] as const;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const DEFAULT_LOCALITY = 0.2;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.entries(value).every(([key, child]) => !FORBIDDEN_PATH_SEGMENTS.has(key) && isJsonValue(child));
}

function asParameterMap(space: SearchSpaceInput): SearchSpace {
  if (isObject(space) && "parameters" in space && isObject(space.parameters)) {
    return space.parameters as SearchSpace;
  }
  return space as SearchSpace;
}

function parameterPath(name: string, parameter: SearchParameter): string {
  return parameter.path?.trim() || name.trim();
}

function pathSegments(path: string): string[] {
  const segments = path.split(".");
  if (!path.trim() || segments.some((segment) => !segment.trim())) throw new Error(`search-space path must not be empty: ${path}`);
  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) throw new Error(`unsafe search-space path: ${path}`);
  return segments;
}

function validateParameter(path: string, parameter: SearchParameter): string[] {
  const errors: string[] = [];
  try {
    pathSegments(path);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!parameter || typeof parameter !== "object" || !["float", "int", "integer", "categorical", "bool", "boolean"].includes(parameter.type)) {
    return [...errors, `${path}: unknown parameter type`];
  }
  if (parameter.type === "float" || parameter.type === "int" || parameter.type === "integer") {
    if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max)) errors.push(`${path}: min and max must be finite`);
    if (parameter.min > parameter.max) errors.push(`${path}: min must be at most max`);
    if ((parameter.type === "int" || parameter.type === "integer") && (!Number.isInteger(parameter.min) || !Number.isInteger(parameter.max))) errors.push(`${path}: int min and max must be integers`);
    if (parameter.step !== undefined && (!Number.isFinite(parameter.step) || parameter.step <= 0)) errors.push(`${path}: step must be positive`);
    if ((parameter.type === "int" || parameter.type === "integer") && parameter.step !== undefined && !Number.isInteger(parameter.step)) errors.push(`${path}: int step must be an integer`);
    if (parameter.type === "float" && parameter.scale === "log" && (parameter.min <= 0 || parameter.max <= 0)) errors.push(`${path}: log scale requires positive bounds`);
    if (parameter.type === "float" && parameter.scale !== undefined && parameter.scale !== "linear" && parameter.scale !== "log") errors.push(`${path}: unsupported scale`);
  } else if (parameter.type === "categorical") {
    if (parameter.values.length === 0) errors.push(`${path}: categorical values must not be empty`);
    if (!parameter.values.every(isJsonValue)) errors.push(`${path}: categorical values must be JSON values`);
    const serialized = parameter.values.map(stableJson);
    if (new Set(serialized).size !== serialized.length) errors.push(`${path}: categorical values must be unique`);
  }
  return errors;
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Validates a space and returns its normalized dotted-path representation. */
export function validateSearchSpace(space: SearchSpaceInput): Record<string, SearchParameter> {
  const raw = asParameterMap(space);
  if (!isObject(raw)) throw new Error("search space must be an object");
  const normalized: Record<string, SearchParameter> = {};
  const errors: string[] = [];
  for (const [name, parameter] of Object.entries(raw)) {
    if (!parameter || typeof parameter !== "object") {
      errors.push(`${name}: parameter must be an object`);
      continue;
    }
    const path = parameterPath(name, parameter);
    errors.push(...validateParameter(path, parameter));
    if (path in normalized) errors.push(`${path}: duplicate parameter path`);
    else normalized[path] = parameter;
  }
  if (errors.length > 0) throw new Error(`invalid search space:\n${errors.join("\n")}`);
  return normalized;
}

/** Non-throwing counterpart useful for config UIs. */
export function inspectSearchSpace(space: SearchSpaceInput): SearchSpaceValidationResult {
  try {
    const parameters = validateSearchSpace(space);
    return { valid: true, errors: [], parameters };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, errors: message.replace(/^invalid search space:\n?/u, "").split("\n").filter(Boolean), parameters: {} };
  }
}

export function isValidSearchSpace(space: SearchSpaceInput): boolean {
  return inspectSearchSpace(space).valid;
}

function assertSeedIndex(seed: number, index: number): void {
  if (!Number.isFinite(seed)) throw new Error("seed must be finite");
  if (!Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer");
}

function hashUnit(seed: number, dimension: number): number {
  let state = (Math.trunc(seed) ^ Math.imul(dimension + 1, 0x9e3779b9)) | 0;
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state ^= state >>> 16;
  return (state >>> 0) / 4_294_967_296;
}

function radicalInverse(index: number, base: number): number {
  let value = index + 1;
  let inverse = 0;
  let fraction = 1 / base;
  while (value > 0) {
    inverse += (value % base) * fraction;
    value = Math.floor(value / base);
    fraction /= base;
  }
  return inverse;
}

/** A deterministic low-discrepancy sample in [0, 1). */
export function quasiRandomUnit(seed: number, index: number, dimension = 0): number {
  assertSeedIndex(seed, index);
  if (!Number.isInteger(dimension) || dimension < 0) throw new Error("dimension must be a non-negative integer");
  const base = PRIMES[dimension % PRIMES.length]!;
  return (radicalInverse(index, base) + hashUnit(seed, dimension)) % 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readPath(root: JsonValue | undefined, path: string): JsonValue | undefined {
  if (root === undefined) return undefined;
  if (isObject(root) && Object.prototype.hasOwnProperty.call(root, path)) return root[path];
  let current: JsonValue | undefined = root;
  for (const segment of pathSegments(path)) {
    if (isObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) current = current[segment];
    else if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/u.test(segment)) current = current[Number(segment)];
    else return undefined;
  }
  return current;
}

function localUnit(globalUnit: number, leader: number | undefined, locality: number, index: number): number {
  if (leader === undefined) return globalUnit;
  if (index === 0) return clamp(leader, 0, 1);
  return clamp(leader + (globalUnit - 0.5) * 2 * locality, 0, 1);
}

function roundFloat(value: number, parameter: FloatSearchParameter): number {
  const stepped = parameter.step === undefined ? value : Math.round((value - parameter.min) / parameter.step) * parameter.step + parameter.min;
  return Number(clamp(stepped, parameter.min, parameter.max).toPrecision(15));
}

function roundInt(value: number, parameter: IntegerSearchParameter): number {
  const step = parameter.step ?? 1;
  const count = Math.floor((parameter.max - parameter.min) / step);
  const candidate = parameter.min + Math.min(count, Math.max(0, Math.round(value * count))) * step;
  return Math.round(clamp(candidate, parameter.min, parameter.max));
}

function sampleParameter(path: string, parameter: SearchParameter, unit: number, index: number, options: SearchSuggestionOptions): JsonValue {
  const locality = options.locality ?? DEFAULT_LOCALITY;
  const leaderValue = options.local ? readPath(options.leader, path) : undefined;
  if (parameter.type === "float") {
    const leaderNormalized = typeof leaderValue === "number" && Number.isFinite(leaderValue)
      ? parameter.scale === "log" ? (Math.log(clamp(leaderValue, parameter.min, parameter.max)) - Math.log(parameter.min)) / (Math.log(parameter.max) - Math.log(parameter.min) || 1) : (leaderValue - parameter.min) / (parameter.max - parameter.min || 1)
      : undefined;
    const normalized = localUnit(unit, leaderNormalized, locality, index);
    const value = parameter.scale === "log"
      ? Math.exp(Math.log(parameter.min) + normalized * (Math.log(parameter.max) - Math.log(parameter.min)))
      : parameter.min + normalized * (parameter.max - parameter.min);
    return roundFloat(value, parameter);
  }
  if (parameter.type === "int" || parameter.type === "integer") {
    const leaderNormalized = typeof leaderValue === "number" && Number.isInteger(leaderValue)
      ? (leaderValue - parameter.min) / (parameter.max - parameter.min || 1)
      : undefined;
    return roundInt(localUnit(unit, leaderNormalized, locality, index), parameter);
  }
  if (parameter.type === "bool" || parameter.type === "boolean") {
    if (options.local && (leaderValue === true || leaderValue === false) && index === 0) return leaderValue;
    if (options.local && (leaderValue === true || leaderValue === false) && unit >= locality) return leaderValue;
    return unit >= 0.5;
  }
  if (parameter.type !== "categorical") throw new Error(`unsupported search parameter type at ${path}`);
  if (options.local && leaderValue !== undefined && isJsonValue(leaderValue) && index === 0 && parameter.values.some((value) => stableJson(value) === stableJson(leaderValue))) return leaderValue;
  if (options.local && leaderValue !== undefined && isJsonValue(leaderValue) && unit >= locality && parameter.values.some((value) => stableJson(value) === stableJson(leaderValue))) return leaderValue;
  return parameter.values[Math.min(parameter.values.length - 1, Math.floor(unit * parameter.values.length))]!;
}

/** Generates one deterministic quasi-random suggestion. */
export function suggestSearchSpace(
  space: SearchSpaceInput,
  seed: number,
  index: number,
  options: SearchSuggestionOptions = {},
): SearchSuggestion {
  assertSeedIndex(seed, index);
  const locality = options.locality ?? DEFAULT_LOCALITY;
  if (!Number.isFinite(locality) || locality < 0 || locality > 1) throw new Error("locality must be between 0 and 1");
  const parameters = validateSearchSpace(space);
  const suggestion: SearchSuggestion = {};
  Object.entries(parameters).forEach(([path, parameter], dimension) => {
    suggestion[path] = sampleParameter(path, parameter, quasiRandomUnit(seed, index, dimension), index, options);
  });
  return suggestion;
}

/** Request-object overload for planner integrations. */
export function suggestSearchSuggestion(space: SearchSpaceInput, request: SearchSuggestionRequest): SearchSuggestion {
  const { seed, index, ...options } = request;
  return suggestSearchSpace(space, seed, index, options);
}

export const generateSearchSuggestion = suggestSearchSpace;
export const generateSuggestion = suggestSearchSpace;
export const suggest = suggestSearchSpace;

/** Generates a deterministic batch, preserving the same parameter ordering. */
export function generateSearchSuggestions(
  space: SearchSpaceInput,
  seed: number,
  count: number,
  options: SearchSuggestionOptions = {},
): SearchSuggestion[] {
  if (!Number.isInteger(count) || count < 0) throw new Error("count must be a non-negative integer");
  return Array.from({ length: count }, (_, index) => suggestSearchSpace(space, seed, index, options));
}

/** Convenience API for local exploitation around a leader JSON object. */
export function suggestLocalSearchSpace(
  space: SearchSpaceInput,
  leader: JsonValue,
  seed: number,
  index: number,
  locality = DEFAULT_LOCALITY,
): SearchSuggestion {
  return suggestSearchSpace(space, seed, index, { local: true, leader, locality });
}

export const suggestLocal = suggestLocalSearchSpace;

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child!)]));
  return value;
}

function assertSafeSegment(segment: string, path: string): void {
  if (!segment || FORBIDDEN_PATH_SEGMENTS.has(segment)) throw new Error(`unsafe JSON path: ${path}`);
}

function assignPath(root: JsonValue, path: string, value: JsonValue): void {
  const segments = pathSegments(path);
  let current: JsonValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const nextSegment = segments[index + 1]!;
    assertSafeSegment(segment, path);
    const nextIsArray = /^(?:0|[1-9]\d*)$/u.test(nextSegment);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) throw new Error(`array path segment must be an index: ${path}`);
      const arrayIndex = Number(segment);
      if (!Object.prototype.hasOwnProperty.call(current, arrayIndex)) current[arrayIndex] = nextIsArray ? [] : {};
      const child = current[arrayIndex];
      if (!isObject(child) && !Array.isArray(child)) throw new Error(`cannot descend through JSON value at ${path}`);
      current = child;
    } else if (isObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) current[segment] = nextIsArray ? [] : {};
      const child = current[segment];
      if (!isObject(child) && !Array.isArray(child)) throw new Error(`cannot descend through JSON value at ${path}`);
      current = child;
    } else {
      throw new Error(`cannot descend through JSON value at ${path}`);
    }
  }
  const last = segments[segments.length - 1]!;
  assertSafeSegment(last, path);
  if (Array.isArray(current)) {
    if (!/^(?:0|[1-9]\d*)$/u.test(last)) throw new Error(`array path segment must be an index: ${path}`);
    current[Number(last)] = value;
  } else if (isObject(current)) current[last] = value;
  else throw new Error(`cannot assign into JSON value at ${path}`);
}

/** Applies one or more dotted-path values without mutating the input object. */
export function applySearchSuggestion<T extends JsonValue>(document: T, suggestion: Readonly<Record<string, JsonValue>>): T {
  if (!isJsonValue(document)) throw new Error("document must be a JSON value");
  const copy = cloneJson(document);
  if (!isObject(copy) && !Array.isArray(copy)) throw new Error("document must be an object or array");
  for (const [path, value] of Object.entries(suggestion)) {
    if (!isJsonValue(value)) throw new Error(`suggestion value is not JSON: ${path}`);
    assignPath(copy, path, cloneJson(value));
  }
  return copy as T;
}

export const applySuggestion = applySearchSuggestion;
