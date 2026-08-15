import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { resolveSafeWorkspacePath } from "../src/workspace.js";

test("workspace path policy permits mutable files and blocks protected or escaping paths", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-paths-"));
  await writeFile(path.join(workspace, "model.py"), "VALUE = 1\n", "utf8");
  await writeFile(path.join(workspace, "evaluate.py"), "pass\n", "utf8");
  const policy = { requireMutable: ["model.py", "evaluate.py"], protectedPaths: ["evaluate.py"] };

  assert.equal((await resolveSafeWorkspacePath(workspace, "model.py", policy)).relativePath, "model.py");
  await assert.rejects(resolveSafeWorkspacePath(workspace, "evaluate.py", policy), /protected/);
  await assert.rejects(resolveSafeWorkspacePath(workspace, "../outside", policy), /escapes/);
});
