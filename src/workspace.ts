import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function normalizeRule(rule: string): string {
  const normalized = rule.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(rule)) {
    throw new Error(`Unsafe relative path rule: ${rule}`);
  }
  return normalized;
}

export function isPathMatched(relativePath: string, rules: string[]): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return rules.map(normalizeRule).some((rule) => normalized === rule || normalized.startsWith(`${rule}/`));
}

export async function assertWorkspace(sourceDir: string): Promise<void> {
  const details = await stat(sourceDir).catch(() => undefined);
  if (!details?.isDirectory()) throw new Error(`Project sourceDir does not exist or is not a directory: ${sourceDir}`);
}

export async function copyWorkspace(sourceDir: string, destinationDir: string, ignoreRules: string[]): Promise<void> {
  await mkdir(path.dirname(destinationDir), { recursive: true });
  const sourceReal = await realpath(sourceDir);
  const destinationResolved = path.resolve(destinationDir);
  const destinationParentReal = await realpath(path.dirname(destinationResolved));
  const destinationCanonical = path.join(destinationParentReal, path.basename(destinationResolved));
  const effectiveIgnore = [...ignoreRules, ".git", "node_modules", ".venv", "__pycache__"];
  const destinationIsInsideSource = destinationCanonical.startsWith(`${sourceReal}${path.sep}`);
  const stagingRoot = destinationIsInsideSource
    ? await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-copy-"))
    : undefined;
  const copyTarget = stagingRoot ? path.join(stagingRoot, "workspace") : destinationResolved;

  try {
    await cp(sourceReal, copyTarget, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      filter: async (source) => {
        const relative = path.relative(sourceReal, source);
        if (!relative) return true;
        if (isPathMatched(relative, effectiveIgnore)) return false;
        const details = await lstat(source);
        if (details.isSymbolicLink()) {
          const resolved = await realpath(source);
          if (resolved !== sourceReal && !resolved.startsWith(`${sourceReal}${path.sep}`)) {
            throw new Error(`Refusing to copy symlink outside source workspace: ${relative}`);
          }
        }
        return true;
      },
    });

    if (stagingRoot) {
      try {
        await rename(copyTarget, destinationResolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        try {
          await cp(copyTarget, destinationResolved, {
            recursive: true,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
          });
        } catch (copyError) {
          await rm(destinationResolved, { recursive: true, force: true });
          throw copyError;
        }
      }
    }
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function resolveSafeWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  options: { allowMissing?: boolean; requireMutable?: string[]; protectedPaths?: string[] } = {},
): Promise<{ absolutePath: string; relativePath: string }> {
  if (!requestedPath || path.isAbsolute(requestedPath)) throw new Error("Path must be non-empty and relative to the experiment workspace");
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, requestedPath);
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes the experiment workspace: ${requestedPath}`);
  const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
  if (options.requireMutable && !isPathMatched(relativePath, options.requireMutable)) {
    throw new Error(`Path is not mutable in this experiment: ${relativePath}`);
  }
  if (options.protectedPaths && isPathMatched(relativePath, options.protectedPaths)) {
    throw new Error(`Path is protected from agent changes: ${relativePath}`);
  }

  const segments = relativePath.split("/");
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const details = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && options.allowMissing) return undefined;
      throw error;
    });
    if (!details) break;
    if (details.isSymbolicLink()) throw new Error(`Symlinks are not allowed in agent-accessible paths: ${relativePath}`);
  }
  return { absolutePath, relativePath };
}

async function walkFiles(root: string, cursor = root): Promise<string[]> {
  const entries = await readdir(cursor, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(cursor, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute).replaceAll("\\", "/"));
    else if (entry.isSymbolicLink()) output.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return output;
}

export async function listWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  return walkFiles(path.resolve(workspaceRoot));
}

export async function snapshotWorkspace(workspaceRoot: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const relativePath of await listWorkspaceFiles(workspaceRoot)) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink()) {
      snapshot.set(relativePath, `symlink:${await realpath(absolutePath)}`);
    } else {
      snapshot.set(relativePath, createHash("sha256").update(await readFile(absolutePath)).digest("hex"));
    }
  }
  return snapshot;
}

export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

export function fingerprintSnapshot(snapshot: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const [file, fingerprint] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(file).update("\0").update(fingerprint).update("\0");
  }
  return hash.digest("hex");
}

export async function isExecutableAvailable(command: string, envPath = process.env.PATH): Promise<boolean> {
  if (command.includes(path.sep)) return access(command, constants.X_OK).then(() => true, () => false);
  for (const directory of (envPath ?? "").split(path.delimiter)) {
    if (directory && await access(path.join(directory, command), constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
}
