import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { HarnessConfig, ProjectKnowledge, ResearchLesson, ResearchMemory, RunState } from "./types.js";
import { ensureDir, writeJsonAtomic } from "./io.js";

function stableObject(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

export function knowledgeScopeFingerprint(config: HarnessConfig): string {
  const payload = {
    name: config.name,
    sourceDir: path.resolve(config.project.sourceDir),
    evaluator: config.evaluator.command,
    metrics: config.metrics,
    scope: config.knowledge?.scope ?? {},
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function loadProjectKnowledge(config: HarnessConfig): Promise<ProjectKnowledge | undefined> {
  if (!config.knowledge?.enabled) return undefined;
  try {
    const parsed = JSON.parse(await readFile(config.knowledge.path, "utf8")) as ProjectKnowledge;
    if (parsed.schemaVersion !== 1) throw new Error("project knowledge schemaVersion must be 1");
    if (parsed.scopeFingerprint !== knowledgeScopeFingerprint(config)) return undefined;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function importProjectLessons(memory: ResearchMemory, knowledge: ProjectKnowledge | undefined): ResearchMemory {
  if (!knowledge) return memory;
  const existing = new Set(memory.lessons.map((lesson) => lesson.normalizedClaim));
  const imported = knowledge.lessons.filter((lesson) => !existing.has(lesson.normalizedClaim)).map((lesson): ResearchLesson => ({
    ...structuredClone(lesson),
    id: `project-${lesson.id}`,
    status: lesson.status === "human-approved" ? "human-approved" : "tentative",
    guidance: "verify",
    confidence: Math.min(lesson.confidence, 0.75),
    evidenceFor: [],
    evidenceAgainst: [],
  }));
  return { ...memory, lessons: [...memory.lessons, ...imported] };
}

export async function persistProjectKnowledge(config: HarnessConfig, state: RunState): Promise<ProjectKnowledge | undefined> {
  if (!config.knowledge?.enabled || !state.researchMemory) return undefined;
  const previous = await loadProjectKnowledge(config);
  const eligible = state.researchMemory.lessons.filter((lesson) =>
    (lesson.status === "supported" || lesson.status === "human-approved")
    && lesson.confidence >= config.knowledge!.minimumConfidence);
  const byClaim = new Map<string, ResearchLesson>();
  for (const lesson of [...(previous?.lessons ?? []), ...eligible]) {
    const current = byClaim.get(lesson.normalizedClaim);
    if (!current || lesson.updatedAt >= current.updatedAt) byClaim.set(lesson.normalizedClaim, structuredClone(lesson));
  }
  const knowledge: ProjectKnowledge = {
    schemaVersion: 1,
    scopeFingerprint: knowledgeScopeFingerprint(config),
    scope: { ...(config.knowledge.scope ?? {}), canonical: stableObject(config.knowledge.scope ?? {}) },
    updatedAt: new Date().toISOString(),
    lessons: [...byClaim.values()],
    sourceRuns: [...new Set([...(previous?.sourceRuns ?? []), state.runId])],
  };
  await ensureDir(path.dirname(config.knowledge.path));
  await writeJsonAtomic(config.knowledge.path, knowledge);
  return knowledge;
}
