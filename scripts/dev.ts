import path from "node:path";

const rootDir = path.resolve(import.meta.dir, "..");
const child = Bun.spawn([process.execPath, "x", "vite", "build"], {
  cwd: path.join(rootDir, "web"),
  stdin: "inherit",
  stdout: "ignore",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`Dashboard build failed with exit code ${exitCode}`);
await import("../src/cli.js");
