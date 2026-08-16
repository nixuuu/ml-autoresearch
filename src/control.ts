import { appendFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CampaignTicket, RunControl } from "./types.js";
import { writeJsonAtomic } from "./io.js";

/**
 * The revision is intentionally kept in control.json rather than RunState's
 * public type.  Older callers can continue to pass a RunControl, while
 * control writers get a monotonic compare-and-swap contract.
 */
export type VersionedRunControl = RunControl & { revision: number };

const CONTROL_LOCK_TIMEOUT_MS = 10_000;
const CONTROL_LOCK_STALE_MS = 30_000;
const CONTROL_LOCK_POLL_MS = 10;

export type ControlCommand =
  | { id: string; type: "pause" | "resume" | "stop"; createdAt: string; reason?: string }
  | { id: string; type: "enqueue"; createdAt: string; ticket: CampaignTicket };

export function runningControl(now = new Date().toISOString()): VersionedRunControl {
  return { desiredState: "running", updatedAt: now, revision: 0 };
}

function parseControl(raw: unknown): VersionedRunControl {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("control.json must contain an object");
  const value = raw as Record<string, unknown>;
  if (!["running", "paused", "stopped"].includes(String(value.desiredState))) {
    throw new Error("control.json desiredState is invalid");
  }
  const revision = value.revision === undefined ? 0 : value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("control.json revision must be a non-negative safe integer");
  }
  return { ...(value as unknown as RunControl), revision };
}

async function readRunControlUnlocked(runDir: string): Promise<VersionedRunControl> {
  try {
    const raw = JSON.parse(await readFile(path.join(runDir, "control.json"), "utf8")) as unknown;
    return parseControl(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return runningControl();
    throw error;
  }
}

async function withControlLock<T>(runDir: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(runDir, "control.json.lock");
  await mkdir(runDir, { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockAge = await lstat(lockPath).then((details) => Date.now() - details.mtimeMs, () => 0);
      if (lockAge > CONTROL_LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= CONTROL_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring run control lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_LOCK_POLL_MS));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assignControl(target: RunControl, source: VersionedRunControl): VersionedRunControl {
  Object.assign(target as object, source);
  return source;
}

export async function readRunControl(runDir: string): Promise<VersionedRunControl> {
  return readRunControlUnlocked(runDir);
}

/**
 * Writes with compare-and-swap semantics when the caller supplies a revision.
 * A stale harness heartbeat never overwrites a newer operator command; it is
 * merged with the current control and copied back into the caller object so
 * the existing harness loop observes the winning desired state.
 */
export async function writeRunControl(runDir: string, control: RunControl): Promise<VersionedRunControl> {
  return withControlLock(runDir, async () => {
    const current = await readRunControlUnlocked(runDir);
    const expectedRevision = (control as Partial<VersionedRunControl>).revision;
    const hasExpectedRevision = expectedRevision !== undefined;
    if (hasExpectedRevision && expectedRevision !== current.revision) {
      const incomingOwner = control.ownerPid;
      const currentOwner = current.ownerPid;
      if (currentOwner !== undefined && processIsAlive(currentOwner) && incomingOwner !== currentOwner) {
        throw new Error(`Run control is owned by active harness pid ${currentOwner}`);
      }
      if (incomingOwner !== undefined && incomingOwner === currentOwner) {
        const merged: VersionedRunControl = {
          ...current,
          ...(control.heartbeatAt === undefined ? {} : { heartbeatAt: control.heartbeatAt }),
        };
        const next: VersionedRunControl = { ...merged, revision: current.revision + 1 };
        await writeJsonAtomic(path.join(runDir, "control.json"), next);
        return assignControl(control, next);
      }
      const takeover: VersionedRunControl = {
        ...control,
        revision: current.revision + 1,
      };
      await writeJsonAtomic(path.join(runDir, "control.json"), takeover);
      return assignControl(control, takeover);
    }
    if (
      !hasExpectedRevision
      && control.ownerPid !== undefined
      && current.ownerPid !== undefined
      && control.ownerPid !== current.ownerPid
      && processIsAlive(current.ownerPid)
    ) {
      throw new Error(`Run control is owned by active harness pid ${current.ownerPid}`);
    }
    const next: VersionedRunControl = {
      ...control,
      revision: current.revision + 1,
    };
    await writeJsonAtomic(path.join(runDir, "control.json"), next);
    return assignControl(control, next);
  });
}

export async function setRunControl(
  runDir: string,
  desiredState: RunControl["desiredState"],
  reason?: string,
): Promise<VersionedRunControl> {
  return withControlLock(runDir, async () => {
    const previous = await readRunControlUnlocked(runDir);
    const control: VersionedRunControl = {
      desiredState,
      updatedAt: new Date().toISOString(),
      revision: previous.revision + 1,
      ...(previous.ownerPid === undefined ? {} : { ownerPid: previous.ownerPid }),
      ...(previous.heartbeatAt === undefined ? {} : { heartbeatAt: previous.heartbeatAt }),
      ...(reason ? { reason } : {}),
    };
    await writeJsonAtomic(path.join(runDir, "control.json"), control);
    return control;
  });
}

export async function appendControlCommand(runDir: string, command: ControlCommand): Promise<void> {
  await appendFile(path.join(runDir, "commands.jsonl"), `${JSON.stringify(command)}\n`, { encoding: "utf8", flag: "a" });
}

export async function readControlCommands(runDir: string, after = 0): Promise<{ commands: ControlCommand[]; cursor: number }> {
  const content = await readFile(path.join(runDir, "commands.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines = content.split("\n").filter(Boolean);
  const commands = lines.slice(after).map((line, index) => {
    try {
      return JSON.parse(line) as ControlCommand;
    } catch {
      throw new Error(`Invalid control command at line ${after + index + 1}`);
    }
  });
  return { commands, cursor: lines.length };
}
