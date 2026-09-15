import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { test } from "bun:test";
import { analysisReadOnlyMountArgs, validateAnalysisReadOnlyMounts } from "../src/analysis-mounts.js";

test("external analysis data stays read-only and cannot shadow workspace or runtime paths", () => {
  const source = path.resolve("external datasets", "development");
  assert.deepEqual(analysisReadOnlyMountArgs([{ source, target: "/data/development" }]), [
    "--mount", `type=bind,src=${source},dst=/data/development,readonly`,
  ]);
  for (const target of ["/", "/workspace", "/tmp", "/data/../workspace", "data", "/database", "/data//nested", "/data,x"]) {
    assert.throws(() => analysisReadOnlyMountArgs([{ source, target }]));
  }
  assert.throws(() => analysisReadOnlyMountArgs([{ source, target: "/data" }, { source, target: "/data/private" }]), /overlap/);
  assert.throws(() => analysisReadOnlyMountArgs([{ source: "/repo/private", target: "/data" }], "/repo"), /overlap/);
  assert.throws(() => analysisReadOnlyMountArgs([{ source: "/repo", target: "/data" }], "/repo/project"), /overlap/);
});

test("analysis data inspection rejects nested links and canonical workspace aliases", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "analysis-data-"));
  try {
    const workspace = path.join(temporary, "workspace");
    const data = path.join(temporary, "data");
    await mkdir(workspace);
    await mkdir(data);
    await writeFile(path.join(data, "public.json"), "{}");
    await validateAnalysisReadOnlyMounts([{source:data,target:"/data/development"}],workspace);
    await symlink(workspace,path.join(data,"private-alias"));
    await assert.rejects(validateAnalysisReadOnlyMounts([{source:data,target:"/data/development"}],workspace), /symlinks/);
    await assert.rejects(validateAnalysisReadOnlyMounts([{source:path.join(data,"private-alias"),target:"/data/development"}],workspace), /overlap/);
  } finally {
    await rm(temporary,{recursive:true,force:true});
  }
});
