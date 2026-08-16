import assert from "node:assert/strict";
import { test } from "bun:test";
import { CampaignQueue, calculateCampaignPriority, createCampaignTicketsFromNextHypotheses } from "../src/campaign.js";

test("campaign priority is deterministic and rewards expected gain, information, and low cost", () => {
  const high = calculateCampaignPriority({ expectedGain: 0.5, probability: 0.8, informationGain: 0.1, estimatedCost: 2 });
  const low = calculateCampaignPriority({ expectedGain: 0.5, probability: 0.8, informationGain: 0.1, estimatedCost: 4 });
  assert.equal(high, calculateCampaignPriority({ expectedGain: 0.5, probability: 0.8, informationGain: 0.1, estimatedCost: 2 }));
  assert.ok(high > low);
});

test("campaign claim honors dependencies before priority", () => {
  const queue = new CampaignQueue({ now: () => new Date("2026-01-01T00:00:00.000Z") });
  const dependency = queue.enqueue({ id: "prep", type: "hypothesis", hypothesis: "prepare features", expectedGain: 0.1, probability: 1, estimatedCost: 1 });
  const dependent = queue.enqueue({ id: "main", type: "search", hypothesis: "search learning rate", expectedGain: 100, probability: 1, estimatedCost: 1, dependencies: [dependency.id] });

  assert.equal(queue.claim("worker")?.id, "prep");
  assert.equal(queue.get(dependent.id)?.status, "queued");
  queue.complete(dependency.id);
  assert.equal(queue.claim("worker")?.id, dependent.id);
});

test("campaign deduplicates normalized hypotheses and generates next hypotheses", () => {
  const queue = new CampaignQueue();
  const first = queue.enqueue({ type: "hypothesis", hypothesis: "  Try a larger batch  " });
  const duplicate = queue.enqueue({ type: "hypothesis", hypothesis: "try   a larger BATCH" });
  assert.equal(duplicate.id, first.id);
  assert.equal(queue.size, 1);
  assert.equal(queue.deduplicate({ type: "hypothesis", hypothesis: "try a larger batch" })?.id, first.id);

  const generated = queue.enqueueNextHypotheses(["Try a larger batch", "Try dropout"], {
    type: "ablation",
    expectedGain: 0.2,
    probability: 0.5,
    informationGain: 0.4,
    estimatedCost: 2,
    idPrefix: "ablation",
  });
  assert.equal(generated.length, 2);
  assert.deepEqual(generated.map((ticket) => ticket.id), ["ablation-0001", "ablation-0002"]);
  assert.equal(generated[0]?.type, "ablation");

  const pure = createCampaignTicketsFromNextHypotheses(["A", "", "B"], { idPrefix: "plan" });
  assert.deepEqual(pure.map((ticket) => ticket.id), ["plan-0001", "plan-0003"]);
});

test("campaign cancels stale claims and blocks their dependents", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const queue = new CampaignQueue({ now: () => now, staleAfterMs: 1_000 });
  const running = queue.enqueue({ id: "running", type: "merge", hypothesis: "merge branches" });
  const dependent = queue.enqueue({ id: "dependent", type: "hypothesis", hypothesis: "evaluate merged branch", dependencies: [running.id] });
  assert.equal(queue.claim()?.id, running.id);
  now = new Date("2026-01-01T00:00:02.000Z");

  const cancelled = queue.cancelStale();
  assert.deepEqual(cancelled.map((ticket) => ticket.id), [running.id]);
  assert.equal(queue.get(running.id)?.status, "cancelled");
  assert.equal(queue.get(dependent.id)?.status, "blocked");
  assert.match(queue.get(dependent.id)?.blockedReason ?? "", /running/);
});
