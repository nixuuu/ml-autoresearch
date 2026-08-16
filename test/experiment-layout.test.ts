import { describe, expect, test } from "bun:test";
import { layoutExperimentGraph } from "../web/src/lib/experiment-layout";

describe("experiment graph layout", () => {
  test("places merge targets after every source and keeps the result stable", () => {
    const records = [
      { id: "baseline", order: 0 },
      { id: "exp-0001", order: 1, parentId: "baseline" },
      { id: "exp-0002", order: 2, parentId: "exp-0001" },
      { id: "exp-0003", order: 3, parentId: "baseline" },
      { id: "exp-0004", order: 4, parentId: "exp-0002", sourceIds: ["exp-0002", "exp-0003"] },
    ];

    const first = layoutExperimentGraph(records);
    const second = layoutExperimentGraph(records);

    expect(first.positions.get("exp-0004")?.depth).toBe(3);
    expect(first.predecessors.get("exp-0004")).toEqual(["exp-0002", "exp-0003"]);
    expect([...first.positions]).toEqual([...second.positions]);
  });

  test("centers sparse layers against the widest branch layer", () => {
    const layout = layoutExperimentGraph([
      { id: "baseline", order: 0 },
      { id: "branch-a", order: 1, parentId: "baseline" },
      { id: "branch-b", order: 2, parentId: "baseline" },
      { id: "branch-c", order: 3, parentId: "baseline" },
      { id: "leaf", order: 4, parentId: "branch-b" },
    ]);

    expect(layout.positions.get("baseline")?.y).toBe(layout.positions.get("leaf")?.y);
    expect(layout.positions.get("branch-a")?.y).toBeLessThan(layout.positions.get("branch-b")?.y ?? 0);
    expect(layout.positions.get("branch-c")?.y).toBeGreaterThan(layout.positions.get("branch-b")?.y ?? 0);
  });
});
