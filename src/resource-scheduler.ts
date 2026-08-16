import type { HarnessConfig, ResourceConfig, ResourceRequest } from "./types.js";

export interface ResourceLease {
  id: string;
  resource: ResourceConfig;
  ordinal: number;
}

function satisfies(resource: ResourceConfig, request: ResourceRequest | undefined): boolean {
  if (!request) return true;
  return resource.cpu >= (request.cpu ?? 0)
    && resource.memoryGb >= (request.memoryGb ?? 0)
    && resource.gpu >= (request.gpu ?? 0)
    && resource.vramGb >= (request.vramGb ?? 0);
}

export function configuredResourceLeases(config: HarnessConfig): ResourceLease[] {
  const resources = config.execution?.resources ?? [];
  if (resources.length > 0) {
    return resources.flatMap((resource) => Array.from({ length: resource.maxConcurrent }, (_, ordinal) => ({
      id: resource.maxConcurrent === 1 ? resource.id : `${resource.id}#${ordinal + 1}`,
      resource,
      ordinal,
    })));
  }
  const legacy = config.execution?.resourceSlots ?? [];
  if (legacy.length > 0) {
    return legacy.map((id) => ({ id, ordinal: 0, resource: { id, cpu: 1, memoryGb: 1, gpu: 0, vramGb: 0, maxConcurrent: 1 } }));
  }
  const count = config.execution?.experimentConcurrency ?? 1;
  return Array.from({ length: count }, (_, ordinal) => ({
    id: `worker-${ordinal + 1}`,
    ordinal,
    resource: { id: `worker-${ordinal + 1}`, cpu: 1, memoryGb: 1, gpu: 0, vramGb: 0, maxConcurrent: 1 },
  }));
}

export function allocateResourceLeases(
  config: HarnessConfig,
  requests: Array<ResourceRequest | undefined>,
): ResourceLease[] {
  const available = configuredResourceLeases(config);
  return requests.map((request) => {
    const index = available.findIndex((lease) => satisfies(lease.resource, request));
    if (index < 0) throw new Error(`No execution resource satisfies request ${JSON.stringify(request ?? {})}`);
    return available.splice(index, 1)[0]!;
  });
}
