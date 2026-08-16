import { describe, expect, test } from "bun:test";
import { resolveDashboardLifecycle } from "../src/dashboard-lifecycle";

describe("dashboard lifecycle", () => {
  test("keeps the default dashboard alive after a run finishes", () => {
    expect(resolveDashboardLifecycle([])).toEqual({ enabled: true, keepOpenAfterRun: true });
    expect(resolveDashboardLifecycle(["--open-ui", "--ui-port", "4317"]))
      .toEqual({ enabled: true, keepOpenAfterRun: true });
  });

  test("no-ui disables the server and the post-run wait", () => {
    expect(resolveDashboardLifecycle(["--no-ui"]))
      .toEqual({ enabled: false, keepOpenAfterRun: false });
  });
});
