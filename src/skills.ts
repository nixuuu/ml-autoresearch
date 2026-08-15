import authorConfig from "../skills/ml-autoresearch-author-config/SKILL.md" with { type: "text" };
import buildEvaluator from "../skills/ml-autoresearch-build-evaluator/SKILL.md" with { type: "text" };
import designScenario from "../skills/ml-autoresearch-design-scenario/SKILL.md" with { type: "text" };
import operateCli from "../skills/ml-autoresearch-operate-cli/SKILL.md" with { type: "text" };

export interface AgentSkill {
  name: string;
  summary: string;
  content: string;
}

const AGENT_SKILLS: readonly AgentSkill[] = Object.freeze([
  {
    name: "ml-autoresearch-design-scenario",
    summary: "Design an end-to-end controlled ML experiment scenario.",
    content: designScenario,
  },
  {
    name: "ml-autoresearch-author-config",
    summary: "Create and review autoresearch.config.json.",
    content: authorConfig,
  },
  {
    name: "ml-autoresearch-build-evaluator",
    summary: "Build a deterministic, protected ML evaluator.",
    content: buildEvaluator,
  },
  {
    name: "ml-autoresearch-operate-cli",
    summary: "Validate, run, monitor, and diagnose experiments.",
    content: operateCli,
  },
]);

export function listAgentSkills(): readonly AgentSkill[] {
  return AGENT_SKILLS;
}

export function getAgentSkill(name: string): AgentSkill | undefined {
  return AGENT_SKILLS.find((skill) => skill.name === name);
}

export function renderAllAgentSkills(): string {
  return AGENT_SKILLS.map((skill) => skill.content.trim()).join("\n\n---\n\n");
}
