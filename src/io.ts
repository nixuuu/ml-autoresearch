import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export class EventLog {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(type: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), type, ...data })}\n`, "utf8");
  }
}

export function makeRunId(name: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "run";
  return `${timestamp}-${slug}-${randomUUID().slice(0, 8)}`;
}
