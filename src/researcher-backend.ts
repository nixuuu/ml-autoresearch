import type { HarnessConfig, ResearcherFactory } from "./types.js";
import { PiResearcher } from "./pi-researcher.js";
import { PrimeAgentResearcher } from "./prime-agent-researcher.js";
import { ResearchLabPool } from "./research-lab.js";

export function createResearcherFactory(
  config: HarnessConfig,
  labPool = new ResearchLabPool(config.agent.lab),
): { factory: ResearcherFactory; labPool: ResearchLabPool } {
  const factory: ResearcherFactory = async (workspacePath, experimentDir, profile) => {
    const lab = labPool.forExperiment(experimentDir);
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
