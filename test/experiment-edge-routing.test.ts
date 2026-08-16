import { describe, expect, test } from "bun:test";
import { orderExperimentEdgeLanes, routeExperimentEdge } from "../web/src/lib/experiment-edge-routing";

describe("experiment edge routing", () => {
  test("assigns sibling edges distinct tracks inside the column gap", () => {
    const routes = Array.from({ length: 7 }, (_, laneIndex) => routeExperimentEdge({
      sourceX: 218,
      sourceY: 80 + laneIndex * 10,
      targetX: 360,
      targetY: laneIndex * 168,
      laneIndex,
      laneCount: 7,
    }));

    expect(new Set(routes.map((route) => route.trackX)).size).toBe(7);
    expect(routes.every((route) => route.trackX > 218 && route.trackX < 360)).toBe(true);
    expect(routes.map((route) => route.trackX)).toEqual([...routes].map((route) => route.trackX).sort((left, right) => left - right));
  });

  test("keeps a level connection straight", () => {
    const route = routeExperimentEdge({ sourceX: 10, sourceY: 20, targetX: 100, targetY: 20, laneIndex: 0, laneCount: 1 });

    expect(route.path).toBe("M 10 20 L 100 20");
    expect(route.trackX).toBe(55);
  });

  test("nests lower fan-out lanes in the opposite order to upper fan-out lanes", () => {
    const positions = new Map([
      ["parent", { y: 500 }],
      ["top-far", { y: 50 }],
      ["top-near", { y: 300 }],
      ["bottom-near", { y: 700 }],
      ["bottom-far", { y: 1_000 }],
    ]);
    const edges = ["top-near", "bottom-near", "top-far", "bottom-far"].map((target) => ({
      id: `parent-${target}`,
      source: "parent",
      target,
    }));

    const ordered = orderExperimentEdgeLanes(edges, (id) => positions.get(id)!);

    expect(ordered.map((edge) => edge.target)).toEqual([
      "top-far",
      "top-near",
      "bottom-far",
      "bottom-near",
    ]);
  });
});
