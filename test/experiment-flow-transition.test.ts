import { describe, expect, test } from "bun:test";
import { easeOutCubic, interpolateNodes, planNodeTransition } from "../web/src/lib/experiment-flow-transition";

type TestNode = {
  id: string;
  position: { x: number; y: number };
  data: { label: string };
  selected?: boolean;
};

describe("experiment flow transitions", () => {
  test("preserves existing node state and spawns a new node near its parent", () => {
    const current: TestNode[] = [
      { id: "baseline", position: { x: 0, y: 100 }, data: { label: "baseline" } },
      { id: "exp-0001", position: { x: 360, y: 100 }, data: { label: "old" }, selected: true },
    ];
    const next: TestNode[] = [
      { id: "baseline", position: { x: 0, y: 0 }, data: { label: "baseline" } },
      { id: "exp-0001", position: { x: 360, y: 0 }, data: { label: "updated" } },
      { id: "exp-0002", position: { x: 720, y: 168 }, data: { label: "running" } },
    ];

    const plan = planNodeTransition(current, next, [
      { source: "baseline", target: "exp-0001" },
      { source: "exp-0001", target: "exp-0002" },
    ]);

    expect(plan.shouldAnimate).toBe(true);
    expect(plan.startNodes.find((node) => node.id === "exp-0001")?.position).toEqual({ x: 360, y: 100 });
    expect(plan.targetNodes.find((node) => node.id === "exp-0001")?.selected).toBe(true);
    expect(plan.targetNodes.find((node) => node.id === "exp-0001")?.data).not.toBe(next[1]!.data);
    expect(plan.startNodes.find((node) => node.id === "exp-0002")?.position).toEqual({ x: 460.8, y: 112.24 });
  });

  test("interpolates real node coordinates so connected edges can follow every frame", () => {
    const start: TestNode[] = [{ id: "exp-0001", position: { x: 0, y: 0 }, data: { label: "one" } }];
    const target: TestNode[] = [{ id: "exp-0001", position: { x: 100, y: 50 }, data: { label: "one" } }];

    expect(interpolateNodes(start, target, 0.5)[0]?.position).toEqual({ x: 50, y: 25 });
    expect(interpolateNodes(start, target, 2)[0]?.position).toEqual({ x: 100, y: 50 });
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });
});
