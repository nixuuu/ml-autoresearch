export type Direction = "minimize" | "maximize";
export type DecisionStatus = "promote" | "retain" | "discard" | "failure" | "keep" | "reject";

export interface MetricConfig {
  name: string;
  direction: Direction;
  minimumDelta: number;
  aggregation: string;
}

export interface EvaluationAttempt {
  repetition: number;
  seed: number;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  metrics?: Record<string, number>;
  error?: string;
}

export interface EvaluationResult {
  ok: boolean;
  skipped?: boolean;
  attempts: EvaluationAttempt[];
  aggregatedMetrics: Record<string, number>;
  error?: string;
}

export interface ExperimentRecord {
  id: string;
  index: number;
  startedAt: string;
  finishedAt: string;
  parentId?: string;
  strategy?: string;
  branchDepth?: number;
  changedPaths: string[];
  forbiddenChanges: string[];
  duplicateOf?: string;
  repeatedHypothesisOf?: string;
  targetLessonId?: string;
  targetQuestionId?: string;
  plan?: {
    hypothesis: string;
    changeCategory: string;
    expectedEffect: string;
    notes: string[];
    lessonsUsed: string[];
    contradictedLessons: string[];
    lessonTests: string[];
    questionsAddressed: string[];
    evaluationRequest?: { mode: "paired"; seeds: number[]; rationale: string };
  };
  conclusion?: {
    narrative: string;
    summary: string;
    notes: string[];
    nextHypotheses: string[];
  };
  evaluation: EvaluationResult;
  pairedEvaluation?: {
    referenceId: string;
    seeds: number[];
    rationale: string;
    reference: EvaluationResult;
    candidate: EvaluationResult;
    decision: { status: DecisionStatus; primaryDelta: number | null; reasons: string[] };
  };
  decision: {
    status: DecisionStatus;
    primaryDelta: number | null;
    reasons: string[];
  };
}

export interface ResearchNode {
  id: string;
  parentId?: string;
  metrics: Record<string, number>;
  status: "leader" | "frontier" | "retired" | "discarded" | "failed";
  wasLeader: boolean;
  strategy: string;
  changeCategory: string;
}

export interface RunState {
  runId: string;
  name: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  stopReason?: string;
  agent?: { model?: string; thinkingLevel: string };
  primaryMetric?: MetricConfig;
  baseline: EvaluationResult;
  acceptedMetrics: Record<string, number>;
  bestObserved?: {
    experimentId: string;
    metrics: Record<string, number>;
    decisionStatus: DecisionStatus | "baseline";
  };
  researchGraph?: {
    leaderId: string;
    frontierIds: string[];
    nodes: ResearchNode[];
  };
  researchMemory?: {
    facts: Array<{ id: string; experimentId: string; statement: string }>;
    notes: Array<{ id: string; experimentId: string; text: string; phase: string }>;
    lessons: Array<{ id: string; claim: string; status: string; confidence: number; guidance: string }>;
    questions: Array<{ id: string; text: string; status: string; resolution?: string }>;
    evidenceReviews: Array<{ experimentId: string; lessonId: string; accepted: boolean; reason: string }>;
  };
  experiments: ExperimentRecord[];
}

export interface LiveProgressEvent {
  sequence: number;
  timestamp: string;
  message: string;
}

export interface DashboardSnapshot {
  schemaVersion: 1;
  updatedAt: string;
  run: RunState | null;
  phase: LiveProgressEvent | null;
  progress: LiveProgressEvent[];
}

export interface ExperimentDetail {
  experiment: ExperimentRecord;
  proposal: string | null;
  conclusion: string | null;
}
