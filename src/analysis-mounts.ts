import path from "node:path";
import { lstat, readdir, realpath } from "node:fs/promises";

export interface AnalysisReadOnlyMount {
  source: string;
  target: string;
}

/** Read-only external data may not shadow the workspace, tools or container runtime. */
export function analysisReadOnlyMountArgs(mounts: AnalysisReadOnlyMount[], workspace?: string): string[] {
  const targets: string[] = [];
  const args: string[] = [];
  for (const mount of mounts) {
    const source = path.resolve(mount.source);
    const target = mount.target;
    if (!mount.source || /[,\r\n\0]/u.test(source) || /[,\r\n\0]/u.test(target)) {
      throw new Error("analysis readOnlyMounts paths cannot be empty or contain commas/control characters");
    }
    if (path.posix.normalize(target) !== target || !(target === "/data" || target.startsWith("/data/"))) {
      throw new Error("analysis readOnlyMounts targets must be normalized paths under /data");
    }
    if (targets.some((existing) => target === existing || target.startsWith(`${existing}/`) || existing.startsWith(`${target}/`))) {
      throw new Error("analysis readOnlyMounts targets cannot overlap");
    }
    if (workspace) {
      const root = path.resolve(workspace);
      if (source === root || source.startsWith(`${root}${path.sep}`) || root.startsWith(`${source}${path.sep}`)) {
        throw new Error("analysis readOnlyMounts sources cannot overlap the candidate source workspace");
      }
    }
    targets.push(target);
    args.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
  }
  return args;
}

export async function validateAnalysisReadOnlyMounts(mounts: AnalysisReadOnlyMount[], workspace: string): Promise<void> {
  const canonical = await Promise.all(mounts.map(async (mount) => ({ ...mount, source: await realpath(mount.source) })));
  analysisReadOnlyMountArgs(canonical, await realpath(workspace));
  async function inspect(source: string): Promise<void> {
    const details = await lstat(source);
    if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) {
      throw new Error("Analysis data mounts may contain only regular files/directories; sockets, devices and symlinks are forbidden");
    }
    if (details.isDirectory()) {
      for (const name of await readdir(source)) await inspect(path.join(source, name));
    }
  }
  for (const mount of canonical) await inspect(mount.source);
}
