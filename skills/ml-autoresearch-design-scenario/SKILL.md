---
name: ml-autoresearch-design-scenario
description: Design an end-to-end controlled ML autoresearch scenario, including experiment boundaries, metrics, guardrails, evaluator strategy, configuration, and staged execution. Use when preparing a new model-improvement campaign or asking an LLM to turn an existing ML project into a safe ml-autoresearch experiment.
---

# Design an ML Autoresearch Scenario

Create a reproducible experiment package that lets the harness, rather than the research agent, decide whether a candidate is better.

## Workflow

1. Inspect the project, training entry points, data split, current evaluation, dependencies, and compute requirements. Preserve existing user changes.
2. Define one measurable objective and explicit non-goals. Identify leakage, overfitting, nondeterminism, cost, latency, and resource risks.
3. Establish an untouched baseline using the same evaluator and compute budget intended for candidates.
4. Select exactly one primary metric. Add guardrails for constraints such as latency, parameter count, memory, fairness, or training duration.
5. Estimate metric noise across fixed seeds. Set `minimumDelta` above ordinary noise; do not use zero merely to accept tiny fluctuations.
6. Define a deliberate candidate surface in `project.mutablePaths`: one file for simple tuning, several files for coupled model/config work, or a dedicated candidate directory. Put the evaluator and split logic in `protectedPaths`; additionally put held-out labels, private targets, and hidden scoring logic in `hiddenPaths`.
7. Prepare the evaluator with `$ml-autoresearch-build-evaluator`, then author the configuration with `$ml-autoresearch-author-config`.
8. Validate and stage the run with `$ml-autoresearch-operate-cli`: baseline validation, one experiment, then the larger budget.
9. Configure the learning frontier, per-category cap, temporary-regression allowance, strategy rates, evidence thresholds, and any human-approved lessons. Select the research model and reasoning level explicitly when reproducibility matters. For noisy objectives, consider bounded paired comparisons on fresh seeds so the harness can confirm a candidate and the current leader under identical conditions.
10. Decide whether the campaign needs staged screening, adaptive seed replication, multiple objectives/Pareto selection, a search space, automatic ablations/merges, project knowledge, agent roles, or parallel workers. Keep the first run small enough to validate each mechanism independently.

If the other skills are not already available, read them with:

```bash
ml-autoresearch skill show ml-autoresearch-build-evaluator
ml-autoresearch skill show ml-autoresearch-author-config
ml-autoresearch skill show ml-autoresearch-operate-cli
```

## Required Deliverables

Create or propose:

- `autoresearch.config.json` beside the project or with a deliberate `project.sourceDir`;
- one evaluator entry point that obeys the metrics-file contract;
- the smallest necessary training/model files exposed as mutable;
- dependency or container files needed to reproduce evaluation;
- a short experiment brief covering objective, hypothesis space, metric semantics, guardrails, expected noise, budgets, and stop conditions;
- a learning policy covering branch width/depth, backtracking, replication, falsification, and evidence promotion;
- optional stage/statistics policy, multi-objective/Pareto definitions, campaign ticket policy, search-space parameters, project-knowledge scope, agent profiles/roles, and execution concurrency;
- exact `validate`, smoke-run, full-run, `status`, and `report` commands.

Do not start a paid or long-running agent loop unless the user asks. It is acceptable to run the evaluator directly and use `validate` while preparing the scenario.

## Quality Gate

Before handing off, verify that:

- the evaluator never trains on or exposes held-out targets;
- baseline and candidates receive identical data, seeds, time limits, and resources;
- every configured metric is emitted as a finite JSON number;
- the output directory is ignored when it sits below `sourceDir`;
- evaluator and split logic cannot be edited by the research agent;
- a failed, timed-out, or missing metrics attempt cannot be interpreted as an improvement;
- the user knows where reports, logs, isolated workspaces, and the accepted candidate will be written.
- free-form agent notes from both proposal and conclusion phases remain distinguishable from deterministic harness facts and evidence-backed lessons.
- lesson evidence is tied to preregistered direct tests, and research questions can be resolved or invalidated instead of accumulating forever.
- agent-requested paired comparisons, when enabled, use unique fresh seeds, a configured cap, the same evaluator for both sides, and separate audit artifacts.
- stage-specific `AUTORESEARCH_STAGE`/`AUTORESEARCH_BUDGET_RATIO` values change only the intended compute budget;
- every configured objective and data slice remains finite and present in each stage;
- search parameters point only at mutable files and valid dotted JSON paths;
- ablation and merge tickets have explicit source/dependency checkpoints and can be reproduced from their parent artifacts;
- project knowledge includes a dataset/evaluator/model scope so facts are not silently transferred across incompatible runs;
- parallel execution is safe for the declared resource slots, or is deliberately set to `1`.
