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

# Disable only the wall-time limit; other stop conditions remain active
ml-autoresearch run path/to/autoresearch.config.json \
  --max-experiments 50 \
  --max-wall-time-minutes 0

# Inspect state and regenerate the Markdown report
ml-autoresearch status path/to/runs/<run-id>
ml-autoresearch report path/to/runs/<run-id>
```

The config path defaults to `autoresearch.config.json`. `--max-experiments` requires a positive integer. `--max-wall-time-minutes` accepts a finite non-negative number; `0` means unlimited wall time. `--model` should use `provider/model`; `--reasoning` is an alias for `--thinking-level`.

## Safe Rollout

1. Run `validate` and review the resolved project, evaluator, runner, metric, and budgets.
2. Run the evaluator directly and establish that repeated baseline results are stable.
3. Start with `--max-experiments 1`. Inspect the report, changed files, evaluation logs, and decision.
4. Increase the budget only after confirming isolation and measurement integrity.
5. Stop with Ctrl+C if needed. The harness stops at a safe experiment boundary.

Do not copy an accepted candidate over the source project automatically. Review `acceptedWorkspacePath` and its diff first.

## Interpret Outcomes

- `promote`: the candidate exceeded `minimumDelta`, passed guardrails, and became the global leader.
- `retain`: the candidate remains on the bounded frontier as an alternative branch or completed an exact replication.
- `discard`: the candidate exceeded branch limits, lost a beam slot, violated a guardrail, or duplicated prior work.
- `failure`: the agent changed no mutable file, touched forbidden paths, or evaluation failed; repeated failures can stop the run.

Inspect `REPORT.md` for the narrative and generated Mermaid graph, `RESEARCH_MEMORY.md` for facts, notes, question lifecycle, and evidence reviews, `frontier.json` for the branch graph, `accepted.json` for the policy leader, `best-observed.json` for the raw metric winner, `state.json` for complete machine-readable state, per-attempt logs for evaluation, and `pi-events.jsonl` for agent activity and the effective model. Distinguish a wall-time stop from an error: reaching a configured budget is a normal completed run.
