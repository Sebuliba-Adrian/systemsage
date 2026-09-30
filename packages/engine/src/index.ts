/*
 * Public surface of the vendored Breakscale simulation engine. See
 * BREAKSCALE_LICENSE for the original MIT notice; the engine itself
 * (src/sim/**) is unmodified from https://github.com/xevrion/breakscale.
 *
 * This file is SystemSage's own addition: a narrow, deterministic function
 * a lesson step can call instead of talking to the Engine class directly.
 */
import { Engine } from './sim/engine';
import type { NodeStats, RequestTrace, SystemStats, Topology } from './sim/types';

export { NODE_KINDS, isTopology } from './topology-schema';
export type { NodeConfig, NodeKind, SimEdge, SimNode, SystemStats, Topology, RequestTrace, TraceHop, NodeStats } from './sim/types';
export { defaultConfig } from './sim/presets';
export { assignLayout, GraphCycleError } from './layout';
export { applyStep, type ApplyStepResult, type StepDiff, type StepEdge, type StepNode } from './apply-step';
export { buildDesignFormatGuide, buildPaletteReference } from './design-format-guide';

export interface SimulationResult {
  /** Aggregate stats at the end of the run -- the numbers a step narrates. */
  stats: SystemStats;
  /**
   * One real request, hop by hop, sampled at the end of the run -- or null
   * if none completed. Every number in `stats` is an aggregate (a rate, a
   * percentile, a mean); those say latency ROSE without saying where it
   * went. This is the one place that answers it: a single traced request's
   * `queuedMs` vs `serviceMs` per hop distinguishes "waiting in line" from
   * "the work itself is slow," which no percentile can. Computed by the
   * engine on every run already -- this was previously discarded.
   */
  trace: RequestTrace | null;
  /**
   * Per-component stats, keyed by node id -- utilization, p50/p95/p99,
   * errorRate, shedRate, timeoutRate, throughput, each specific to that
   * ONE node. `stats` above is the whole-system aggregate; this is what
   * answers "which specific component is the bottleneck, and is it
   * shedding, timing out, or erroring" instead of one flat number for the
   * entire topology. Computed by the engine on every run already -- this
   * was previously discarded, same as `trace`.
   */
  nodeStats: Record<string, NodeStats>;
  /** Seed used, so a caller can prove a re-run reproduces the same numbers. */
  seed: number;
  simulatedSeconds: number;
}

/**
 * Run a topology forward for a fixed number of simulated seconds and return
 * the resulting stats. Deterministic for a given (topology, seed,
 * simulatedSeconds): re-running with the same three inputs must produce the
 * same SystemStats, since the whole point of using this engine instead of
 * an LLM's guess is that the numbers are reproducible, not just plausible.
 */
export function simulate(
  topology: Topology,
  opts: { seed?: number; simulatedSeconds?: number; stepMs?: number } = {},
): SimulationResult {
  const seed = opts.seed ?? 1;
  const simulatedSeconds = opts.simulatedSeconds ?? 30;
  const stepMs = opts.stepMs ?? 100;

  const engine = new Engine(topology, seed);
  const totalMs = simulatedSeconds * 1000;
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    engine.advance(stepMs);
  }

  const snapshot = engine.snapshot();
  return {
    stats: snapshot.system,
    trace: snapshot.trace,
    nodeStats: snapshot.nodes,
    seed,
    simulatedSeconds,
  };
}
