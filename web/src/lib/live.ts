import { writable } from "svelte/store";
import type { DashboardSnapshot, LiveProgressEvent } from "$lib/types";

const emptySnapshot: DashboardSnapshot = {
  schemaVersion: 2,
  updatedAt: new Date(0).toISOString(),
  run: null,
  phase: null,
  progress: [],
  activeExperiments: [],
};

export const dashboard = writable<DashboardSnapshot>(emptySnapshot);
export const connection = writable<"connecting" | "live" | "offline">("connecting");

let source: EventSource | undefined;

export function uniqueBy<T, K>(values: T[], key: (value: T) => K): T[] {
  const indexes = new Map<K, number>();
  const unique: T[] = [];
  for (const value of values) {
    const valueKey = key(value);
    const existingIndex = indexes.get(valueKey);
    if (existingIndex === undefined) {
      indexes.set(valueKey, unique.length);
      unique.push(value);
    } else {
      // A later snapshot entry is the freshest representation of this entity.
      unique[existingIndex] = value;
    }
  }
  return unique;
}

export function normalizeDashboardSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  const run = snapshot.run;
  return {
    ...snapshot,
    progress: uniqueBy(snapshot.progress, (event) => event.sequence),
    activeExperiments: uniqueBy(snapshot.activeExperiments, (experiment) => experiment.id),
    run: run ? {
      ...run,
      experiments: uniqueBy(run.experiments, (experiment) => experiment.id),
      ...(run.campaign ? {
        campaign: {
          ...run.campaign,
          tickets: uniqueBy(run.campaign.tickets, (ticket) => ticket.id),
        },
      } : {}),
      ...(run.metaResearch ? {
        metaResearch: {
          ...run.metaResearch,
          agentPerformance: uniqueBy(run.metaResearch.agentPerformance, (profile) => profile.profileId),
          strategyPerformance: uniqueBy(run.metaResearch.strategyPerformance, (strategy) => strategy.strategy),
        },
      } : {}),
    } : null,
  };
}

export function applyProgressEvent(snapshot: DashboardSnapshot, progress: LiveProgressEvent): DashboardSnapshot {
  return {
    ...snapshot,
    updatedAt: progress.timestamp,
    phase: progress,
    progress: uniqueBy([...snapshot.progress, progress], (event) => event.sequence).slice(-500),
  };
}

export function connectDashboard(): () => void {
  if (source) return disconnectDashboard;
  connection.set("connecting");
  void fetch("/api/state", { cache: "no-store" })
    .then((response) => response.ok ? response.json() as Promise<DashboardSnapshot> : Promise.reject(new Error(response.statusText)))
    .then((snapshot) => dashboard.set(normalizeDashboardSnapshot(snapshot)))
    .catch(() => connection.set("offline"));

  source = new EventSource("/api/events");
  source.addEventListener("snapshot", (event) => {
    dashboard.set(normalizeDashboardSnapshot(JSON.parse((event as MessageEvent<string>).data) as DashboardSnapshot));
  });
  source.addEventListener("progress", (event) => {
    const progress = JSON.parse((event as MessageEvent<string>).data) as LiveProgressEvent;
    dashboard.update((snapshot) => applyProgressEvent(snapshot, progress));
  });
  source.onopen = () => connection.set("live");
  source.onerror = () => connection.set("offline");
  return disconnectDashboard;
}

function disconnectDashboard(): void {
  source?.close();
  source = undefined;
  connection.set("offline");
}
