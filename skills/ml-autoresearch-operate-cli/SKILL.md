---
name: ml-autoresearch-operate-cli
description: Operate the ml-autoresearch CLI safely by validating configurations, staging agent runs, setting experiment and wall-time budgets, monitoring research memory and branches, regenerating reports, and interpreting promote, retain, discard, and failure outcomes. Use when executing or diagnosing a configured autoresearch campaign.
---

# Operate the Autoresearch CLI

Use the executable name available in the environment, such as `./dist/ml-autoresearch` or `bun run dev`.

## Commands

```bash
# Discover agent guidance
ml-autoresearch skill list
ml-autoresearch skill show ml-autoresearch-design-scenario

# Validate configuration and evaluator executable
ml-autoresearch validate path/to/autoresearch.config.json

# Override run budgets from the CLI
ml-autoresearch run path/to/autoresearch.config.json \
  --max-experiments 20 \
  --max-wall-time-minutes 120 \
  --model openai-codex/gpt-5.6-sol \
  --thinking-level xhigh

# Open the live dashboard; it remains available after research finishes
ml-autoresearch run path/to/autoresearch.config.json \
  --open-ui

# Disable only the wall-time limit; other stop conditions remain active
ml-autoresearch run path/to/autoresearch.config.json \
  --max-experiments 50 \
  --max-wall-time-minutes 0

# Inspect state and regenerate the Markdown report
ml-autoresearch status path/to/runs/<run-id>
ml-autoresearch report path/to/runs/<run-id>
ml-autoresearch serve path/to/runs/<run-id> --port 0 --open

# Control a campaign at safe experiment boundaries
ml-autoresearch pause path/to/runs/<run-id>
ml-autoresearch resume path/to/runs/<run-id>
ml-autoresearch stop path/to/runs/<run-id>
ml-autoresearch enqueue path/to/runs/<run-id> "Test a smaller learning rate" \
  --expected-gain 0.01 --probability 0.4 --information-gain 0.8 --estimated-cost 1
```

The config path defaults to `autoresearch.config.json`. `--max-experiments` requires a positive integer. `--max-wall-time-minutes` accepts a finite non-negative number; `0` means unlimited wall time. `--model` should use `provider/model`; `--reasoning` is an alias for `--thinking-level`.

`run` and `resume` start the embedded dashboard on loopback and a random free port by default. Progress phases and state snapshots are streamed over SSE. The dashboard remains available after research finishes until the user closes the application with `Ctrl+C`. Use `--open-ui` to open the browser, `--ui-port PORT` to select a port, or `--no-ui` to disable the dashboard and exit as soon as research finishes. Use `serve <run-directory>` to inspect a completed run or follow a run written by another process; port `0` means a random free port.

During active research, the first `Ctrl+C` requests a safe-boundary interruption. A second `Ctrl+C` force-kills every tracked evaluator subprocess group before the CLI exits, preventing orphan processes.

`pause` preserves artifacts and lets the active evaluator reach its safe
boundary. `resume` continues from persisted state and the campaign queue;
`stop` records an operator decision without deleting a run. `enqueue` adds a
human `hypothesis` ticket with optional cost/value estimates. The scheduler
creates typed `search`, `ablation`, and `merge` tickets from configuration and
campaign evidence. Duplicate hypotheses are ignored before costly evaluation.

## Safe Rollout

1. Run `validate` and review the resolved project, evaluator, runner, metric, and budgets.
2. Run the evaluator directly and establish that repeated baseline results are stable.
3. Start with `--max-experiments 1`. Inspect the report, changed files, evaluation logs, and decision.
4. Increase the budget only after confirming isolation and measurement integrity.
5. Monitor the metric trajectory, branch flow, current phase, individual experiment pages, durable memory, agent cost, duration, cost/improvement, and time/improvement in the dashboard.
6. Stop with Ctrl+C if needed. The harness stops at a safe experiment boundary.
7. For a long campaign, pause it before changing configuration or resource
   availability; resume only after checking `state.json`, the queue, and the
   knowledge scope.

Do not copy an accepted candidate over the source project automatically. Review `acceptedWorkspacePath` and its diff first.

## Interpret Outcomes

- `promote`: the candidate exceeded `minimumDelta`, passed guardrails, and became the global leader.
- `retain`: the candidate remains on the bounded frontier as an alternative branch or completed an exact replication.
- `discard`: the candidate exceeded branch limits, lost a beam slot, violated a guardrail, or duplicated prior work.
- `failure`: the agent changed no mutable file, touched forbidden paths, or evaluation failed; repeated failures can stop the run.
- `inconclusive`/`pruned`: statistical evidence did not separate the candidate
  from its reference, or an early stage found a clear regression; these are
  measurement outcomes, not evaluator crashes.

Inspect `REPORT.md` for the narrative and generated Mermaid graph, `RESEARCH_MEMORY.md` for facts, notes, question lifecycle, and evidence reviews, `frontier.json` for the branch graph, `accepted.json` for the policy leader, `best-observed.json` for the raw metric winner, `state.json` for complete machine-readable state, per-attempt logs for evaluation, and `pi-events.jsonl` for agent activity and the effective model. Distinguish a wall-time stop from an error: reaching a configured budget is a normal completed run.
