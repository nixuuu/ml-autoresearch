import type { ChildProcess } from "node:child_process";

interface TrackedSubprocess {
  child: ChildProcess;
  detached: boolean;
}

const activeSubprocesses = new Map<number, TrackedSubprocess>();

export function killSubprocessTree(
  child: ChildProcess,
  detached: boolean,
  signal: NodeJS.Signals,
): boolean {
  if (detached && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // It may have exited between the registry lookup and signal delivery.
    }
  }
  return child.kill(signal);
}

export function trackSubprocess(child: ChildProcess, detached: boolean): () => void {
  const pid = child.pid;
  if (!pid) return () => {};
  activeSubprocesses.set(pid, { child, detached });
  const unregister = () => activeSubprocesses.delete(pid);
  child.once("exit", unregister);
  child.once("close", unregister);
  return unregister;
}

export function killActiveSubprocesses(signal: NodeJS.Signals = "SIGKILL"): number {
  let killed = 0;
  for (const tracked of activeSubprocesses.values()) {
    if (killSubprocessTree(tracked.child, tracked.detached, signal)) killed += 1;
  }
  return killed;
}

export function activeSubprocessCount(): number {
  return activeSubprocesses.size;
}
