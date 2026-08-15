"""Hidden ground-truth function used by the toy evaluator.

The harness copies this file into each isolated workspace, but project.hiddenPaths
prevents the research agent from listing or reading it. This keeps the demo about
learning through experiments instead of reading the answer from the evaluator.
"""


def target(x: float) -> float:
    return 0.75 - 1.2 * x + 0.4 * x**2 + 1.8 * x**3
