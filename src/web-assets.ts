import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

export interface EmbeddedWebAsset {
  contentType: string;
  base64: string;
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeFor(filePath: string): string {
  return contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(filePath) : [filePath];
  }));
  return nested.flat();
}

export async function loadWebAssets(): Promise<Record<string, EmbeddedWebAsset>> {
  const buildDir = path.resolve(import.meta.dir, "../web/build");
  let files: string[];
  try {
    files = await filesBelow(buildDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Dashboard assets are missing. Run 'bun run build:web' before starting the source CLI.");
    }
    throw error;
  }
  return Object.fromEntries(await Promise.all(files.map(async (filePath) => {
    const route = `/${path.relative(buildDir, filePath).split(path.sep).join("/")}`;
    return [route, { contentType: contentTypeFor(filePath), base64: Buffer.from(await readFile(filePath)).toString("base64") }];
  })));
}
