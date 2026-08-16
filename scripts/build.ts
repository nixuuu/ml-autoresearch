import path from "node:path";
import { mkdir, readdir, readFile } from "node:fs/promises";
import type { BunPlugin } from "bun";
import { contentTypeFor, type EmbeddedWebAsset } from "../src/web-assets.js";

const rootDir = path.resolve(import.meta.dir, "..");
const webDir = path.join(rootDir, "web");
const webBuildDir = path.join(webDir, "build");
const outfile = path.join(rootDir, "dist", "ml-autoresearch");

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(filePath) : [filePath];
  }));
  return nested.flat();
}

async function embeddedAssets(): Promise<Record<string, EmbeddedWebAsset>> {
  const files = (await filesBelow(webBuildDir)).filter((filePath) => !filePath.endsWith(".map"));
  return Object.fromEntries(await Promise.all(files.map(async (filePath) => {
    const route = `/${path.relative(webBuildDir, filePath).split(path.sep).join("/")}`;
    return [route, { contentType: contentTypeFor(filePath), base64: Buffer.from(await readFile(filePath)).toString("base64") }];
  })));
}

console.log("[build] Building static SvelteKit dashboard");
await run([process.execPath, "x", "vite", "build"], webDir);
const assets = await embeddedAssets();
const embeddedModule = `export async function loadWebAssets() { return ${JSON.stringify(assets)}; }`;
const assetPlugin: BunPlugin = {
  name: "embedded-autoresearch-dashboard",
  setup(build) {
    build.onResolve({ filter: /^\.\/web-assets\.js$/, namespace: "file" }, () => ({
      path: "autoresearch-dashboard-assets",
      namespace: "embedded-dashboard",
    }));
    build.onLoad({ filter: /.*/, namespace: "embedded-dashboard" }, () => ({
      contents: embeddedModule,
      loader: "js",
    }));
  },
};

await mkdir(path.dirname(outfile), { recursive: true });
console.log(`[build] Compiling executable with ${Object.keys(assets).length} embedded dashboard assets`);
const result = await Bun.build({
  entrypoints: [path.join(rootDir, "src/cli.ts")],
  target: "bun",
  plugins: [assetPlugin],
  compile: { outfile },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Executable build failed");
}
console.log(`[build] Wrote ${outfile}`);
