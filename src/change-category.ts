import type { ChangeCategory } from "./types.js";

export const CHANGE_CATEGORIES: readonly ChangeCategory[] = [
  "model-architecture",
  "regularization",
  "optimization",
  "data",
  "features",
  "objective",
  "training-budget",
  "inference",
  "evaluation",
  "other",
];

const CATEGORY_PATTERNS: Array<[ChangeCategory, RegExp]> = [
  ["regularization", /\b(regulari[sz](?:e|ed|ing|ation)?|ridge|lasso|elastic|weight decay|l1|l2|dropout|penalty)\b/u],
  ["optimization", /\b(optimi[sz]|learning rate|lr|scheduler|momentum|adam|sgd|gradient|warmup)\b/u],
  ["data", /\b(data|dataset|sample|sampling|split|label|noise|curriculum|batch mix)\b/u],
  ["features", /\b(feature|embedding|preprocess|normaliz|standardiz|tokeni[sz]|representation)\b/u],
  ["objective", /\b(loss|objective|reward|criterion|metric surrogate)\b/u],
  ["training-budget", /\b(epoch|step|batch size|compute|training budget|accumulation|early stop)\b/u],
  ["inference", /\b(inference|decode|decoding|beam search|temperature|threshold|postprocess|ensemble)\b/u],
  ["evaluation", /\b(evaluation|evaluator|replicat(?:e|ed|ing|ion)?|measurement|ablation|seed|holdout|validation protocol)\b/u],
  ["model-architecture", /\b(model|architecture|layer|width|depth|degree|polynomial|activation|attention|head|network|tree)\b/u],
];

function categoryText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeChangeCategory(value: string): ChangeCategory {
  const normalized = categoryText(value);
  const exact = CHANGE_CATEGORIES.find((category) => category === normalized);
  if (exact) return exact;
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(normalized)) return category;
  }
  return "other";
}
