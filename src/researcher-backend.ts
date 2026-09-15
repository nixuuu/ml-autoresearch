import type { HarnessConfig, ResearcherFactory } from "./types.js";
import { PiResearcher } from "./pi-researcher.js";
import { PrimeAgentResearcher } from "./prime-agent-researcher.js";
import { ResearchLabPool } from "./research-lab.js";
import path from "node:path";
import { DirectedResearcher } from "./directed-researcher.js";
import { PiResearchDirector } from "./pi-director.js";

export function createResearcherFactory(
  config: HarnessConfig,
  labPool = new ResearchLabPool(config.agent.lab),
): { factory: ResearcherFactory; labPool: ResearchLabPool } {
  const factory: ResearcherFactory = async (workspacePath, experimentDir, profile) => {
    const lab = labPool.forExperiment(experimentDir);
    if (config.agent.orchestration?.mode === "directed") {
      if (config.agent.backend.type !== "pi-sdk") throw new Error("Directed research requires pi-sdk");
      return new DirectedResearcher(config, workspacePath, experimentDir,
        new PiResearchDirector(config, workspacePath, experimentDir),
        async (attempt, attemptDir) => new PiResearcher(config, workspacePath, attemptDir, profile, lab,
          { transcriptPath: path.join(experimentDir, "agent-transcript.jsonl"), namespace: `implementation-${attempt}`, requireFinalValidation: true }));
    }
    switch (config.agent.backend.type) {
      case "pi-sdk":
        return new PiResearcher(config, workspacePath, experimentDir, profile, lab);
      case "prime-agent-rpc":
        return new PrimeAgentResearcher(config, workspacePath, experimentDir, profile, lab);
      default: {
        const exhaustive: never = config.agent.backend.type;
        throw new Error(`Unsupported researcher backend: ${exhaustive}`);
      }
    }
  };
  return { factory, labPool };
}
