import type {
  ExperimentRecord,
  ResearchMethodEntry,
  ResearchMethodRefinementConfig,
  ResearchMethodState,
  ResearchMethodUpdate,
} from "./types.js";

export function createResearchMethodState(): ResearchMethodState {
  return { schemaVersion: 1, entries: [], reviews: [] };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function nextId(state: ResearchMethodState): string {
  const used = new Set(state.entries.map((entry) => entry.id));
  for (let index = 1; ; index += 1) {
    const id = `method-${String(index).padStart(3, "0")}`;
    if (!used.has(id)) return id;
  }
}

function review(
  state: ResearchMethodState,
  experimentId: string,
  update: ResearchMethodUpdate,
  methodId: string,
  accepted: boolean,
  reason: string,
  createdAt: string,
): void {
  state.reviews.push({ experimentId, methodId, relation: update.relation, accepted, reason, createdAt });
}

export function applyResearchMethodUpdates(
  current: ResearchMethodState | undefined,
  experiment: ExperimentRecord,
  config: ResearchMethodRefinementConfig | undefined,
): ResearchMethodState {
  const state: ResearchMethodState = current
    ? structuredClone(current)
    : createResearchMethodState();
  if (!config?.enabled) return state;
  const now = experiment.finishedAt;
  const updates = experiment.conclusion?.methodUpdates ?? [];
  const preregistered = new Set(experiment.plan?.methodTests ?? []);

  for (const update of updates.slice(0, 20)) {
    if (!config.allowedKinds.includes(update.kind)) {
      review(state, experiment.id, update, update.methodId ?? "unassigned", false, `Method kind ${update.kind} is not allowed.`, now);
      continue;
    }
    const content = update.content.trim().slice(0, 2_000);
    if (!content) {
      review(state, experiment.id, update, update.methodId ?? "unassigned", false, "Method content is empty.", now);
      continue;
    }
    if (!experiment.evaluation.ok || experiment.decision.status === "failure") {
      review(state, experiment.id, update, update.methodId ?? "unassigned", false, "The experiment did not produce valid evaluator evidence.", now);
      continue;
    }

    if (update.relation === "new") {
      const normalizedContent = normalize(content);
      const duplicate = state.entries.find((entry) => entry.normalizedContent === normalizedContent && entry.kind === update.kind);
      if (duplicate) {
        review(state, experiment.id, update, duplicate.id, false, "An equivalent method already exists; cite its ID and pre-register a direct test.", now);
        continue;
      }
      if (state.entries.length >= config.maxEntries) {
        review(state, experiment.id, update, "unassigned", false, `Method capacity ${config.maxEntries} has been reached.`, now);
        continue;
      }
      const id = nextId(state);
      state.entries.push({
        id,
        kind: update.kind,
        content,
        normalizedContent,
        status: "trial",
        evidenceFor: [experiment.id],
        evidenceAgainst: [],
        createdAt: now,
        updatedAt: now,
      });
      review(state, experiment.id, update, id, true, "Created as a trial method; it cannot become supported without independent pre-registered evidence.", now);
      continue;
    }

    const method = state.entries.find((entry) => entry.id === update.methodId);
    if (!method) {
      review(state, experiment.id, update, update.methodId ?? "missing", false, "The cited method does not exist.", now);
      continue;
    }
    if (!preregistered.has(method.id)) {
      review(state, experiment.id, update, method.id, false, "The method was not pre-registered in plan.methodTests.", now);
      continue;
    }
    if (method.status === "retired" && update.relation !== "retire") {
      review(state, experiment.id, update, method.id, false, "Retired methods cannot receive new evidence.", now);
      continue;
    }

    if (update.relation === "retire") {
      method.status = "retired";
    } else if (update.relation === "supports") {
      if (!method.evidenceFor.includes(experiment.id)) method.evidenceFor.push(experiment.id);
      method.status = method.evidenceFor.length >= config.minimumEvidence ? "supported" : "trial";
    } else {
      if (!method.evidenceAgainst.includes(experiment.id)) method.evidenceAgainst.push(experiment.id);
      if (method.evidenceAgainst.length >= config.contradictionThreshold) method.status = "contradicted";
    }
    method.updatedAt = now;
    review(state, experiment.id, update, method.id, true, `Accepted pre-registered ${update.relation} evidence.`, now);
  }
  return state;
}

export function methodsForAgent(state: ResearchMethodState | undefined): ResearchMethodEntry[] {
  return (state?.entries ?? []).filter((entry) => entry.status === "trial" || entry.status === "supported");
}

export function renderResearchMethods(state: ResearchMethodState): string {
  const entries = state.entries.length
    ? state.entries.map((entry) => `- ${entry.id} [${entry.kind}; ${entry.status}; for=${entry.evidenceFor.length}; against=${entry.evidenceAgainst.length}]: ${entry.content}`).join("\n")
    : "No research methods have been proposed.";
  return `# Research methods\n\nThese are advisory research procedures. They cannot change evaluator code, metrics, protected paths, hidden data, or sandbox policy.\n\n${entries}\n`;
}
