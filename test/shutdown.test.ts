import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTwoStageShutdownHandler } from "../src/shutdown";
import { activeSubprocessCount, killActiveSubprocesses, trackSubprocess } from "../src/subprocess-registry";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForEvaluatorPid(pidPath: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pid = Number((await readFile(pidPath, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // The evaluator has not written its PID yet.
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for the evaluator PID");
}

describe("two-stage shutdown", () => {
  test("first signal requests interruption and second signal forces shutdown once", () => {
    const events: string[] = [];
    const shutdown = createTwoStageShutdownHandler({
      onInterrupt: (signal) => events.push(`interrupt:${signal}`),
      onForce: (signal) => events.push(`force:${signal}`),
    });

    shutdown("SIGINT");
    shutdown("SIGINT");
    shutdown("SIGINT");

    expect(events).toEqual(["interrupt:SIGINT", "force:SIGINT"]);
  });

  test("forced shutdown kills a tracked detached subprocess group", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    await once(child, "spawn");
    trackSubprocess(child, process.platform !== "win32");
    expect(activeSubprocessCount()).toBe(1);

    let interrupted = false;
    let killed = 0;
    const shutdown = createTwoStageShutdownHandler({
      onInterrupt: () => { interrupted = true; },
      onForce: () => { killed = killActiveSubprocesses("SIGKILL"); },
    });
    shutdown("SIGINT");
    expect(interrupted).toBeTrue();
    expect(child.exitCode).toBeNull();

    shutdown("SIGINT");
    await once(child, "close");
    expect(killed).toBe(1);
    expect(child.signalCode).toBe("SIGKILL");
    expect(activeSubprocessCount()).toBe(0);
  });

  test("CLI keeps running after the first Ctrl+C and kills its evaluator after the second", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ml-autoresearch-force-shutdown-"));
    const sourceDir = path.join(root, "project");
    const evaluatorPidPath = path.join(root, "evaluator.pid");
    const configPath = path.join(root, "config.json");
    await mkdir(sourceDir);
    await writeFile(path.join(sourceDir, "model.json"), "{\"value\":1}\n", "utf8");
    await writeFile(path.join(sourceDir, "evaluate.mjs"), `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.EVALUATOR_PID_PATH, String(process.pid));
setInterval(() => {}, 1_000);
`, "utf8");
    await writeFile(configPath, JSON.stringify({
      version: 2,
      name: "force-shutdown-test",
      project: { sourceDir, mutablePaths: ["model.json"], protectedPaths: ["evaluate.mjs"], copyIgnore: ["runs"] },
      agent: { thinkingLevel: "off" },
      evaluator: {
        command: [process.execPath, "evaluate.mjs"], timeoutSeconds: 60, repetitions: 1, seeds: [1],
        inheritEnv: ["PATH"], env: { EVALUATOR_PID_PATH: evaluatorPidPath },
        runner: { mode: "local" },
      },
      metrics: { primary: { name: "score", direction: "maximize", minimumDelta: 0.1, aggregation: "mean" }, guardrails: [] },
      budget: { maxExperiments: 1, maxWallTimeMinutes: 0, maxConsecutiveFailures: 1 },
      learning: {
        beamWidth: 1, maxBranchDepth: 1, maxTemporaryRegressionRatio: 0, recentExperiments: 1, maxContextLessons: 1,
        supportThreshold: 1, contradictionThreshold: 1,
        strategy: { explorationRate: 0, backtrackRate: 0, replicationRate: 0, falsificationRate: 0 }, humanLessons: [],
      },
      outputDir: path.join(sourceDir, "runs"),
      researchInstructions: "test force shutdown",
    }, null, 2), "utf8");

    const cli = spawn(process.execPath, [path.join(import.meta.dir, "..", "src", "cli.ts"), "run", configPath, "--no-ui"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    cli.stderr.setEncoding("utf8");
    cli.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const evaluatorPid = await waitForEvaluatorPid(evaluatorPidPath);
    try {
      cli.kill("SIGINT");
      await Bun.sleep(50);
      expect(cli.exitCode).toBeNull();
      expect(processIsAlive(evaluatorPid)).toBeTrue();

      cli.kill("SIGINT");
      const [exitCode] = await once(cli, "close") as [number | null, NodeJS.Signals | null];
      expect(exitCode).toBe(130);
      expect(stderr).toContain("Interruption requested");
      expect(stderr).toContain("Forced shutdown requested; killed 1 active subprocess group.");
      for (let attempt = 0; attempt < 100 && processIsAlive(evaluatorPid); attempt += 1) await Bun.sleep(20);
      expect(processIsAlive(evaluatorPid)).toBeFalse();
    } finally {
      if (cli.exitCode === null) cli.kill("SIGKILL");
      if (processIsAlive(evaluatorPid)) {
        try {
          process.kill(process.platform === "win32" ? evaluatorPid : -evaluatorPid, "SIGKILL");
        } catch {
          // Already stopped during test cleanup.
        }
      }
    }
  }, 10_000);
});
