# @systemsage/engine

The real discrete-event simulation engine, vendored from
[Breakscale](https://github.com/xevrion/breakscale) (MIT licensed — see
`BREAKSCALE_LICENSE`). `src/sim/**` and `src/topology-schema.ts` are
Breakscale's own code, unmodified except for `topology-schema.ts` being
extracted from its original `src/clipboard.ts` to drop DOM/clipboard-only
code this package doesn't need.

`src/index.ts` is SystemSage's own addition: a narrow `simulate(topology,
opts)` function a lesson step calls instead of driving the `Engine` class
directly.

**Why this exists instead of asking an LLM to describe what a system would
do:** every number `simulate()` returns comes from a real, seeded,
deterministic discrete-event run (finite server slots, gamma-distributed
service times, real queueing and retry behavior). The same topology and
seed always produce the same stats. That determinism is the thing the
Playwright suite in `e2e/` proves directly, and it's the whole reason this
project exists instead of freehand-generating a diagram and narrating
plausible-sounding numbers over it.
