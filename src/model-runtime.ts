import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";

/** Use the same operator-supplied provider catalog in validation and every role. */
export async function createAgentModelRuntime(agent: { modelsPath?: string | undefined }): Promise<ModelRuntime> {
  if (agent.modelsPath && !await stat(agent.modelsPath).then((info) => info.isFile()).catch(() => false)) {
    throw new Error(`Agent model catalog is not a readable file: ${agent.modelsPath}`);
  }
  const runtime = await ModelRuntime.create({ ...(agent.modelsPath ? { modelsPath: agent.modelsPath } : {}), allowModelNetwork: false });
  if (agent.modelsPath && runtime.getError()) {
    // A model catalog may contain secret references; do not echo parser contents.
    throw new Error(`Could not load the configured agent model catalog: ${agent.modelsPath}`);
  }
  return runtime;
}
