# Parameter sweep example

This example demonstrates several values evaluated as **one logical research
experiment**. The agent prepares one hypothesis and one reflection. The harness
creates five isolated trial workspaces, runs the same staged evaluator for each
value, prunes weaker values between stages, and writes the selected value back
to the experiment workspace.

Run it from the repository root:

```bash
bun run build
./dist/ml-autoresearch run examples/parameter-sweep/autoresearch.config.json --max-experiments 1 --max-wall-time-minutes 0
```

The dashboard and `REPORT.md` show a Parameter sweep table. The raw machine
readable result is stored at:

```text
runs/<run-id>/experiments/exp-0001/parameter-sweep/result.json
```

The opt-in contract is in `search.sweeps`. Only parameters declared in
`search.parameters` can be swept. This keeps every trial constrained to one
known JSON path; shared agent edits, if any, are copied identically into every
trial.
