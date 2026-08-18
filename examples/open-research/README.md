# Open research example

This scenario gives the implementer broad freedom over `candidate/` and enables
audited data-inspection, Python, test, command and background-job tools. The agent can create EDA scripts,
inspect the visible training set, compare outlier policies, change temporal
windows, select features, and replace the baseline with any model available in
the pinned image. The evaluator contract is visible but protected from edits;
the hidden holdout stays outside that terminal.

Build the shared analysis/evaluation image:

```bash
cd examples/open-research
docker build -t ml-autoresearch-open-research:latest .
cd ../..
```

Then validate and run:

```bash
bun run build
./dist/ml-autoresearch validate examples/open-research/autoresearch.config.json
./dist/ml-autoresearch run examples/open-research/autoresearch.config.json --max-experiments 10 --max-wall-time-minutes 0
```

Each experiment stores complete command audit artifacts under:

```text
runs/<run-id>/experiments/<experiment-id>/analysis/
```

Docker mode runs commands in a persistent mirror that excludes `hiddenPaths`,
has no network by default, drops Linux capabilities, and does not mount the
candidate's real evaluation workspace. Files created by commands remain
scratch-only. The agent must use `research_write`/`research_replace` to make a
candidate change, keeping the final workspace diff explicit and reviewable.

The configured canonical interpreter is `python3`, project imports include the
workspace and `candidate/`, and `research_test` syntax-checks the final solution
without writing bytecode.
Every command records a candidate/runtime fingerprint. An edit invalidates
older evidence, so the final proposal must cite a successful evidence ID
measured after the last mutation. Long work can be started in the background
and polled, but all jobs must settle or be cancelled before proposal completion.
The example also enables the run-scoped Research Lab: bounded evidence summaries
and recurring tool/runtime failures remain visible to later experiment sessions.

The example also enables the controlled runtime dependency broker. The agent
may inspect and install only allowlisted Python packages. A package requested
with `scope=analysis` is available only to subsequent `research_exec` calls. A
package requested with `scope=candidate` is resolved into a content-addressed
overlay and writes `candidate/autoresearch.dependencies.json`. Both later
analysis commands and the protected evaluator mount that exact overlay and use
the same pinned Docker image ID. The evaluator therefore sees a package needed
by the submitted model; it never runs a second implicit `pip install`.

This example intentionally enables only `allowedManagers: ["python"]`; Bun
packages are not available to the broker here. Enabling them requires a Docker
image containing Bun plus `"bun"` in `allowedManagers` and explicit Bun package
rules in the dependency policy.

Dependency downloads are the sole exception to the scenario's no-network
execution policy: only the broker receives temporary registry access. Candidate
analysis and evaluation continue to run with `network: none`. Broker calls,
resolved versions, stdout/stderr and fingerprints are stored under
`analysis/dependencies/`. The reusable physical cache is
`.autoresearch/dependencies/` next to this config and is excluded from candidate
workspace copies.

`hiddenPaths` is an agent-visibility boundary, not a complete defense against
malicious candidate code once that code is invoked by an evaluator. A
production adversarial setup should execute candidate inference in a separate
sandbox that receives features but cannot mount holdout labels or scoring code,
then score its predictions in a trusted process.
