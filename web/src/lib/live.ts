import { writable } from "svelte/store";
import type { DashboardSnapshot, LiveProgressEvent } from "$lib/types";

const emptySnapshot: DashboardSnapshot = {
  schemaVersion: 1,
  updatedAt: new Date(0).toISOString(),
  run: null,
  phase: null,
  progress: [],
};

export const dashboard = writable<DashboardSnapshot>(emptySnapshot);
export const connection = writable<"connecting" | "live" | "offline">("connecting");

let source: EventSource | undefined;

export function connectDashboard(): () => void {
  if (source) return disconnectDashboard;
  connection.set("connecting");
  void fetch("/api/state", { cache: "no-store" })
    .then((response) => response.ok ? response.json() as Promise<DashboardSnapshot> : Promise.reject(new Error(response.statusText)))
    .then((snapshot) => dashboard.set(snapshot))
    .catch(() => connection.set("offline"));

  source = new EventSource("/api/events");
  source.addEventListener("snapshot", (event) => {
    dashboard.set(JSON.parse((event as MessageEvent<string>).data) as DashboardSnapshot);
  });
  source.addEventListener("progress", (event) => {
    const progress = JSON.parse((event as MessageEvent<string>).data) as LiveProgressEvent;
    dashboard.update((snapshot) => ({
      ...snapshot,
      updatedAt: progress.timestamp,
      phase: progress,
      progress: [...snapshot.progress, progress].slice(-500),
    }));
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
