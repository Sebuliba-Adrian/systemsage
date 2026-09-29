import type { SimEdge, SimNode } from './sim/types';

const X_STEP = 220;
const Y_STEP = 120;

/**
 * Thrown when the graph contains a cycle. A REAL, live crash found under
 * stress testing, not a hypothetical: the depth-relaxation loop below has
 * no termination guarantee on a cyclic graph (A -> B -> A means every pass
 * around the cycle increases both nodes' depth by one, forever), and it
 * crashed with "RangeError: Invalid array length" once the BFS queue grew
 * past what Array.push can hold. In a graph with N nodes, no node in a
 * real DAG can legitimately need a depth greater than N-1 -- the longest
 * possible simple path visits every node once -- so exceeding that bound
 * is mathematical proof of a cycle, not a coincidence, and is now detected
 * and reported instead of looped on forever.
 */
export class GraphCycleError extends Error {
  constructor(readonly nodeId: string) {
    super(
      `Layout detected a cycle reachable from node "${nodeId}": its depth ` +
        'would have to exceed the total number of nodes, which is only ' +
        'possible if the edges form a loop. Review the edges you just ' +
        'added or removed for one that routes back to something upstream ' +
        'of itself.',
    );
    this.name = 'GraphCycleError';
  }
}

/**
 * Assigns x/y to every node that doesn't have one yet, left to right by
 * BFS depth from the client nodes (matching Breakscale's own "requests
 * flow left to right" convention), stacking nodes at the same depth
 * vertically. isTopology requires finite x/y on every node, so this must
 * run before a merged topology is validated -- there is no "auto-layout
 * later" the way Breakscale's own editor gets to rely on.
 */
export function assignLayout(nodes: SimNode[], edges: SimEdge[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from)!.push(e.to);
  }

  const depthOf = new Map<string, number>();
  const roots = nodes.filter((n) => n.kind === 'client' && !depthOf.has(n.id));
  const queue: string[] = [];
  for (const r of roots) {
    depthOf.set(r.id, 0);
    queue.push(r.id);
  }
  // Anything unreachable from a client (shouldn't normally happen once a
  // step is validated end to end, but a partially-built step mid-plan can
  // have one) still needs a position, so seed it at depth 0 too.
  for (const n of nodes) {
    if (!depthOf.has(n.id)) {
      depthOf.set(n.id, 0);
      queue.push(n.id);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const depth = depthOf.get(id)!;
    for (const childId of children.get(id) ?? []) {
      if (!byId.has(childId)) continue;
      const existing = depthOf.get(childId);
      const nextDepth = depth + 1;
      if (nextDepth > nodes.length) throw new GraphCycleError(childId);
      if (existing === undefined || existing < nextDepth) {
        depthOf.set(childId, nextDepth);
        queue.push(childId);
      }
    }
  }

  // Seed slot counts from nodes a PRIOR step already positioned, keyed by
  // their existing column (x / X_STEP): this is what a fresh call has no
  // other way to know. Without this, a new node at the same depth as an
  // already-placed one from an earlier step gets slot 0 again and is drawn
  // directly on top of it -- exactly the Step 2 "cache hides the db" bug
  // found by actually looking at the rendered canvas, not by reading the
  // code alone.
  const countAtDepth = new Map<number, number>();
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    const column = Math.round(n.x / X_STEP);
    countAtDepth.set(column, (countAtDepth.get(column) ?? 0) + 1);
  }

  for (const n of nodes) {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) continue;
    const depth = depthOf.get(n.id) ?? 0;
    const slot = countAtDepth.get(depth) ?? 0;
    countAtDepth.set(depth, slot + 1);
    n.x = depth * X_STEP;
    n.y = slot * Y_STEP;
  }
}
