/*
 * The single, shared implementation of "merge a proposed change onto a
 * topology, lay it out, and validate it." Used by BOTH drivers of this
 * project: the hosted Gemini planner (packages/lesson-planner) and the
 * MCP server a coding agent drives directly (packages/mcp-server). Extracted
 * here specifically so those two paths cannot drift into two different
 * ideas of what a valid step is -- whichever agent proposes a step, Gemini
 * internally or Claude Code/Codex through MCP, the exact same code decides
 * whether it's accepted.
 *
 * Returns a result object rather than throwing, and collects every error in
 * one pass rather than stopping at the first -- the same shape Breakscale's
 * own buildTopology uses ("buildTopology gives better errors than a schema
 * can"), so a caller (human or agent) gets everything wrong with an attempt
 * in one round trip instead of discovering problems one at a time.
 */
import { defaultConfig } from './sim/presets';
import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from './sim/types';
import { isTopology } from './topology-schema';
import { assignLayout, GraphCycleError } from './layout';

export interface StepNode {
  id: string;
  kind: NodeKind;
  label: string;
  config?: Partial<NodeConfig>;
  /**
   * Explicit placement -- e.g. where a human dropped it on the interactive
   * canvas (apps/web/app/components/InteractiveCanvas.tsx). Omitted (the
   * LLM-driven path never sets this) leaves the node unpositioned so
   * assignLayout auto-places it by BFS depth, exactly as before. A human
   * placing a node by hand is the only caller with a real position to give
   * it, so this is the one thing that path skips assignLayout for.
   */
  x?: number;
  y?: number;
}

export interface StepEdge {
  from: string;
  to: string;
}

export interface StepDiff {
  addNodes: StepNode[];
  addEdges: StepEdge[];
  removeEdges: StepEdge[];
  /**
   * Node ids to delete, cascading: any edge touching a removed node is
   * removed too (independent of removeEdges), since a dangling edge would
   * fail isTopology outright. Optional and deliberately NOT exposed to
   * either LLM-driven path (the Gemini/DeepSeek system prompt and the MCP
   * schema never mention it) -- this project's tutor teaches by adding one
   * thing at a time and never un-teaches a component. A human free-building
   * on the interactive canvas has every reason to fix a mistake by deleting
   * it, which is the one caller that sets this.
   */
  removeNodes?: string[];
}

export type ApplyStepResult = { ok: true; topology: Topology } | { ok: false; errors: string[] };

function toSimNode(n: StepNode): SimNode {
  const base = defaultConfig(n.kind) as NodeConfig;
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    // Real values come from assignLayout below when not given explicitly;
    // NaN is an explicit, detectable "not yet positioned" placeholder,
    // never a silent 0,0.
    x: n.x ?? NaN,
    y: n.y ?? NaN,
    config: { ...base, ...n.config },
  };
}

function toSimEdge(e: StepEdge, index: number): SimEdge {
  return { id: `${e.from}->${e.to}-${index}`, from: e.from, to: e.to, weight: 1 };
}

export function applyStep(current: Topology, diff: StepDiff): ApplyStepResult {
  const errors: string[] = [];
  const removeNodeIds = new Set(diff.removeNodes ?? []);

  const existingIds = new Set(current.nodes.map((n) => n.id));
  for (const n of diff.addNodes) {
    if (existingIds.has(n.id)) {
      errors.push(
        `Reused an existing node id: "${n.id}". Every id in addNodes must be new. ` +
          `Existing ids: ${[...existingIds].join(', ')}.`,
      );
    }
  }

  for (const id of removeNodeIds) {
    if (!existingIds.has(id)) {
      errors.push(
        `Tried to remove a nonexistent node: "${id}". Existing ids: ${[...existingIds].join(', ')}.`,
      );
    }
  }

  for (const r of diff.removeEdges) {
    const exists = current.edges.some((e) => e.from === r.from && e.to === r.to);
    if (!exists) {
      const currentEdges = current.edges.map((e) => `${e.from}->${e.to}`).join(', ') || '(none)';
      errors.push(
        `Tried to remove a nonexistent edge: "${r.from}->${r.to}". ` +
          `Edges that currently exist: ${currentEdges}.`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const survivingNodes = current.nodes.filter((n) => !removeNodeIds.has(n.id));
  const survivingEdges = current.edges.filter(
    (e) =>
      !diff.removeEdges.some((r) => r.from === e.from && r.to === e.to) &&
      !removeNodeIds.has(e.from) &&
      !removeNodeIds.has(e.to),
  );

  const nodes = [...survivingNodes, ...diff.addNodes.map(toSimNode)];
  const edges = [...survivingEdges, ...diff.addEdges.map((e, i) => toSimEdge(e, survivingEdges.length + i))];

  try {
    assignLayout(nodes, edges);
  } catch (err) {
    // A real, live crash found under stress testing (RangeError: Invalid
    // array length, from an unbounded BFS on a cyclic graph) turned into
    // a proper validation error here instead -- same discipline as every
    // other check in this function: report it specifically, let the
    // caller retry with feedback, never crash the caller.
    if (err instanceof GraphCycleError) return { ok: false, errors: [err.message] };
    throw err;
  }

  const topology: Topology = { nodes, edges };
  if (!isTopology(topology)) {
    return {
      ok: false,
      errors: [
        'The merged topology failed structural validation (isTopology). Common ' +
          'causes: an edge referencing a node id that does not exist, or a ' +
          'config value of the wrong type.',
      ],
    };
  }

  return { ok: true, topology };
}
