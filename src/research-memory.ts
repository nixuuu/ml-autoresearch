import type {
  ExperimentRecord,
  EvaluationResult,
  HarnessConfig,
  LessonEvidenceReview,
  LessonUpdate,
  ResearchConclusion,
  ResearchFact,
  ResearchLesson,
  ResearchMemory,
  ResearchQuestion,
} from "./types.js";

export function normalizeClaim(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function currentResearchMemory(value: ResearchMemory): ResearchMemory {
  if (value.schemaVersion !== 3) throw new Error("Only future research-memory schemaVersion 3 artifacts are supported");
  return value;
}

export function createResearchMemory(config: HarnessConfig, now = new Date().toISOString()): ResearchMemory {
  return {
    schemaVersion: 3,
    updatedAt: now,
    facts: [],
    notes: [],
    lessons: config.learning.humanLessons.map((lesson) => ({
      id: lesson.id,
      claim: lesson.claim,
      normalizedClaim: normalizeClaim(lesson.claim),
      status: "human-approved",
      guidance: lesson.guidance,
      confidence: 1,
      evidenceFor: ["human"],
      evidenceAgainst: [],
      createdAt: now,
      updatedAt: now,
    })),
    questions: [],
    evidenceReviews: [],
  };
}

export function recordBaselineFact(
  memoryValue: ResearchMemory,
  evaluation: EvaluationResult,
  workspaceFingerprint: string,
  createdAt: string,
): ResearchMemory {
  const memory = currentResearchMemory(memoryValue);
  const metrics = evaluation.aggregatedMetrics;
  const fact: ResearchFact = {
    id: "fact-baseline",
    experimentId: "baseline",
    kind: evaluation.ok ? "measurement" : "decision",
    statement: evaluation.ok
      ? `Baseline produced ${JSON.stringify(metrics)} from ${evaluation.attempts.length} repetitions.`
      : `Baseline evaluation failed: ${evaluation.error ?? "unknown evaluator error"}.`,
    parentId: "source",
    strategy: "exploit",
    metrics,
    evidence: {
      repetitions: evaluation.attempts.length,
      seeds: evaluation.attempts.map((attempt) => attempt.seed),
      primaryDelta: null,
      workspaceFingerprint,
    },
    createdAt,
  };
  return { ...memory, updatedAt: createdAt, facts: [...memory.facts, fact] };
}

function factForExperiment(experiment: ExperimentRecord): ResearchFact {
  const kind = experiment.duplicateOf || experiment.repeatedHypothesisOf ? "duplicate" : experiment.evaluation.ok ? "measurement" : "decision";
  const strategy = experiment.strategy ?? "exploit";
  const parentId = experiment.parentId ?? "baseline";
  const metrics = experiment.evaluation.aggregatedMetrics;
  const metricText = Object.keys(metrics).length === 0 ? "no metrics" : JSON.stringify(metrics);
  const duplicateText = experiment.duplicateOf
    ? `; duplicate workspace of ${experiment.duplicateOf}`
    : experiment.repeatedHypothesisOf ? `; repeated hypothesis from ${experiment.repeatedHypothesisOf}` : "";
  const pairedText = experiment.pairedEvaluation
    ? `; paired against ${experiment.pairedEvaluation.referenceId} on seeds ${experiment.pairedEvaluation.seeds.join(",")} with candidate ${JSON.stringify(experiment.pairedEvaluation.candidate.aggregatedMetrics)}, reference ${JSON.stringify(experiment.pairedEvaluation.reference.aggregatedMetrics)}, and check ${experiment.pairedEvaluation.decision.status}`
    : "";
  return {
    id: `fact-${experiment.id}`,
    experimentId: experiment.id,
    kind,
    statement: `${experiment.id} from ${parentId} used ${strategy}, produced ${metricText}, and was ${experiment.decision.status}${duplicateText}${pairedText}.`,
    parentId,
    strategy,
    metrics,
    evidence: {
      repetitions: experiment.evaluation.attempts.length,
      seeds: experiment.evaluation.attempts.map((attempt) => attempt.seed),
      primaryDelta: experiment.decision.primaryDelta,
      workspaceFingerprint: experiment.workspaceFingerprint ?? "unknown",
    },
    createdAt: experiment.finishedAt,
  };
}

function safeConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function findLesson(lessons: ResearchLesson[], update: LessonUpdate): ResearchLesson | undefined {
  if (update.lessonId) {
    const byId = lessons.find((lesson) => lesson.id === update.lessonId);
    if (byId) return byId;
  }
  const normalized = normalizeClaim(update.claim);
  return lessons.find((lesson) => lesson.normalizedClaim === normalized);
}

function nextLessonId(lessons: ResearchLesson[]): string {
  let index = lessons.length + 1;
  while (lessons.some((lesson) => lesson.id === `lesson-${String(index).padStart(4, "0")}`)) index += 1;
  return `lesson-${String(index).padStart(4, "0")}`;
}

function nextQuestionId(questions: ResearchQuestion[]): string {
  let index = questions.length + 1;
  while (questions.some((question) => question.id === `question-${String(index).padStart(4, "0")}`)) index += 1;
  return `question-${String(index).padStart(4, "0")}`;
}

function updateLessonStatus(lesson: ResearchLesson, relation: LessonUpdate["relation"], config: HarnessConfig): void {
  if (lesson.status === "human-approved") return;
  if (relation === "retire" && lesson.evidenceFor.length >= config.learning.supportThreshold) {
    lesson.status = "retired";
  } else if (lesson.evidenceAgainst.length >= config.learning.contradictionThreshold) {
    lesson.status = "contradicted";
  } else if (lesson.evidenceFor.length >= config.learning.supportThreshold) {
    lesson.status = "supported";
  } else {
    lesson.status = "tentative";
  }
}

function reviewEvidence(
  update: LessonUpdate,
  lesson: ResearchLesson,
  isNewLesson: boolean,
  experiment: ExperimentRecord,
): Omit<LessonEvidenceReview, "createdAt"> {
  const base = {
    experimentId: experiment.id,
    lessonId: lesson.id,
    relation: update.relation,
    evidenceKind: update.evidenceKind,
    rationale: update.evidenceRationale,
  };
  const freshSeedReplication = Boolean(
    experiment.pairedEvaluation?.reference.ok
    && experiment.pairedEvaluation.candidate.ok
    && update.evidenceKind === "replication",
  );
  if (!experiment.evaluation.ok) return { ...base, accepted: false, reason: "The evaluator did not produce a valid result." };
  if (lesson.status === "human-approved") return { ...base, accepted: false, reason: "Human-approved lessons are immutable." };
  if ((experiment.strategy === "replicate" || experiment.duplicateOf) && !freshSeedReplication) {
    return { ...base, accepted: false, reason: "An exact or duplicate checkpoint is not independent lesson evidence." };
  }
  if (isNewLesson) {
    if (update.relation !== "new") return { ...base, accepted: false, reason: "A new lesson must use relation=new." };
    if (update.evidenceKind !== "direct") return { ...base, accepted: false, reason: "A new lesson needs direct evidence from the originating experiment." };
    return { ...base, accepted: true, reason: "Direct evidence created a tentative lesson." };
  }
  if (update.relation === "new") return { ...base, accepted: false, reason: "The lesson already exists; use supports, contradicts, or retire." };
  if (update.evidenceKind !== "direct" && !freshSeedReplication) {
    return { ...base, accepted: false, reason: "Only direct tests or harness-controlled fresh-seed replications change lesson evidence counters." };
  }
  const preRegistered = experiment.plan?.lessonTests?.includes(lesson.id) || experiment.targetLessonId === lesson.id;
  if (!preRegistered) return { ...base, accepted: false, reason: "The lesson was not pre-registered in plan.lessonTests." };
  return {
    ...base,
    accepted: true,
    reason: freshSeedReplication
      ? "Harness-controlled fresh-seed replication matched a pre-registered lesson test."
      : "Direct evidence matched a pre-registered lesson test.",
  };
}

function applyQuestionLifecycle(
  memory: ResearchMemory,
  experiment: ExperimentRecord,
  conclusion: ResearchConclusion | undefined,
): ResearchQuestion[] {
  const now = experiment.finishedAt;
  const addressed = new Set([
    ...(experiment.plan?.questionsAddressed ?? []),
    ...(experiment.targetQuestionId ? [experiment.targetQuestionId] : []),
  ]);
  const updates = new Map((conclusion?.questionUpdates ?? []).map((update) => [update.questionId, update]));
  const questions: ResearchQuestion[] = memory.questions.map((question) => {
    if (question.status !== "open" || !addressed.has(question.id)) return { ...question };
    if (!experiment.evaluation.ok) {
      if (!experiment.evaluation.skipped || (!experiment.duplicateOf && !experiment.repeatedHypothesisOf)) return { ...question };
      const duplicateReason = experiment.duplicateOf
        ? `the candidate duplicates workspace ${experiment.duplicateOf}`
        : `the hypothesis repeats ${experiment.repeatedHypothesisOf}`;
      return {
        ...question,
        status: "invalidated",
        updatedAt: now,
        resolvedBy: experiment.id,
        resolution: `${experiment.id} did not spend another evaluation because ${duplicateReason}; use the existing experiment evidence instead.`,
      };
    }
    const update = updates.get(question.id);
    return {
      ...question,
      status: update?.status ?? "resolved",
      updatedAt: now,
      resolvedBy: experiment.id,
      resolution: update?.resolution || conclusion?.summary || `${experiment.id} evaluated this question and was ${experiment.decision.status}.`,
    };
  });
  for (const text of unique(conclusion?.nextHypotheses ?? [])) {
    const normalizedText = normalizeClaim(text);
    if (!normalizedText || questions.some((question) => question.normalizedText === normalizedText)) continue;
    questions.push({
      id: nextQuestionId(questions),
      text,
      normalizedText,
      status: "open",
      createdBy: experiment.id,
      createdAt: now,
      updatedAt: now,
    });
  }
  return questions;
}

export function applyExperimentKnowledge(
  memoryValue: ResearchMemory,
  experiment: ExperimentRecord,
  conclusion: ResearchConclusion | undefined,
  config: HarnessConfig,
): ResearchMemory {
  const memory = currentResearchMemory(memoryValue);
  const now = experiment.finishedAt;
  const lessons = memory.lessons.map((lesson) => ({
    ...lesson,
    evidenceFor: [...lesson.evidenceFor],
    evidenceAgainst: [...lesson.evidenceAgainst],
  }));
  const evidenceReviews = [...memory.evidenceReviews];

  if (conclusion) {
    for (const update of conclusion.lessonUpdates) {
      if (!update.claim.trim()) continue;
      let lesson = findLesson(lessons, update);
      const isNewLesson = !lesson;
      if (!lesson && update.relation !== "new") {
        evidenceReviews.push({
          experimentId: experiment.id,
          lessonId: update.lessonId ?? "unknown-lesson",
          relation: update.relation,
          evidenceKind: update.evidenceKind,
          accepted: false,
          reason: "The referenced lesson does not exist; only relation=new may create one.",
          rationale: update.evidenceRationale,
          createdAt: now,
        });
        continue;
      }
      if (!lesson) {
        lesson = {
          id: nextLessonId(lessons),
          claim: update.claim.trim(),
          normalizedClaim: normalizeClaim(update.claim),
          status: "tentative",
          guidance: update.guidance,
          confidence: safeConfidence(update.confidence),
          evidenceFor: [],
          evidenceAgainst: [],
          createdAt: now,
          updatedAt: now,
        };
        lessons.push(lesson);
      }

      const review = { ...reviewEvidence(update, lesson, isNewLesson, experiment), createdAt: now };
      evidenceReviews.push(review);
      if (!review.accepted) continue;

      lesson.guidance = update.guidance;
      lesson.confidence = Math.max(lesson.confidence, safeConfidence(update.confidence));
      lesson.updatedAt = now;
      if (update.relation === "contradicts") {
        lesson.evidenceAgainst = unique([...lesson.evidenceAgainst, experiment.id]);
      } else if (update.relation !== "retire") {
        lesson.evidenceFor = unique([...lesson.evidenceFor, experiment.id]);
      }
      updateLessonStatus(lesson, update.relation, config);
    }
  }

  return {
    schemaVersion: 3,
    updatedAt: now,
    facts: [...memory.facts, factForExperiment(experiment)],
    notes: [
      ...memory.notes,
      ...unique(experiment.plan?.notes ?? []).map((text, index) => ({
        id: `note-${experiment.id}-proposal-${index + 1}`,
        experimentId: experiment.id,
        text,
        source: "agent" as const,
        phase: "proposal" as const,
        createdAt: now,
      })),
      ...unique(conclusion ? [conclusion.summary, ...conclusion.notes] : []).map((text, index) => ({
        id: `note-${experiment.id}-conclusion-${index + 1}`,
        experimentId: experiment.id,
        text,
        source: "agent" as const,
        phase: "conclusion" as const,
        createdAt: now,
      })),
    ],
    lessons,
    questions: applyQuestionLifecycle(memory, experiment, conclusion),
    evidenceReviews,
  };
}

export function memoryForAgent(memoryValue: ResearchMemory, maxLessons: number): ResearchMemory {
  const memory = currentResearchMemory(memoryValue);
  const rank = (lesson: ResearchLesson): number => {
    switch (lesson.status) {
      case "human-approved": return 5;
      case "supported": return 4;
      case "contradicted": return 3;
      case "retired": return 2;
      case "tentative": return 1;
    }
  };
  const lessons = [...memory.lessons]
    .sort((left, right) => rank(right) - rank(left) || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maxLessons);
  const open = memory.questions.filter((question) => question.status === "open");
  const closed = memory.questions.filter((question) => question.status !== "open").slice(-10);
  return {
    ...memory,
    facts: memory.facts.slice(-20),
    notes: memory.notes.slice(-20),
    lessons,
    questions: [...open, ...closed].slice(-30),
    evidenceReviews: memory.evidenceReviews.slice(-20),
  };
}

export function renderResearchMemory(memoryValue: ResearchMemory): string {
  const memory = currentResearchMemory(memoryValue);
  const lessons = memory.lessons.map((lesson) => [
    `### ${lesson.id}: ${lesson.status}`,
    "",
    `- Claim: ${lesson.claim}`,
    `- Guidance: ${lesson.guidance}`,
    `- Confidence: ${lesson.confidence}`,
    `- Evidence for: ${lesson.evidenceFor.join(", ") || "none"}`,
    `- Evidence against: ${lesson.evidenceAgainst.join(", ") || "none"}`,
  ].join("\n")).join("\n\n");
  const facts = memory.facts.map((fact) => `- **${fact.id}**: ${fact.statement}`).join("\n");
  const notes = memory.notes.map((note) => `- **${note.id}** (${note.experimentId}, ${note.phase}, agent interpretation): ${note.text}`).join("\n");
  const questions = memory.questions.map((question) => [
    `- **${question.id}** [${question.status}]: ${question.text}`,
    question.resolution ? `  - Resolution: ${question.resolution} (${question.resolvedBy ?? "unknown"})` : "",
  ].filter(Boolean).join("\n")).join("\n");
  const reviews = memory.evidenceReviews.map((review) =>
    `- ${review.experimentId} → ${review.lessonId} (${review.relation}, ${review.evidenceKind}): **${review.accepted ? "accepted" : "rejected"}** — ${review.reason} Rationale: ${review.rationale}`,
  ).join("\n");
  return `# Research Memory

Updated: ${memory.updatedAt}

## Consolidated lessons

${lessons || "No lessons have been recorded yet."}

## Research questions

${questions || "No research questions have been recorded yet."}

## Evidence review audit

${reviews || "No lesson evidence updates have been reviewed yet."}

## Agent notebook

${notes || "The agent has not recorded any free-form notes yet."}

## Harness facts

${facts || "No experiment facts have been recorded yet."}
`;
}
