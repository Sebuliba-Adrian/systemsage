import { test, expect } from '@playwright/test';
import { applyStep, defaultConfig, type Topology } from '@systemsage/engine';

/*
 * Regression test for a real, live crash found under stress testing: a
 * real DeepSeek session produced a step whose edges formed a cycle
 * (A -> B -> ... -> A), and assignLayout's depth-relaxation BFS had no
 * termination guarantee on a cycle, looping until "RangeError: Invalid
 * array length" crashed the whole session. See layout.ts's GraphCycleError
 * and apply-step.ts's catch for the fix: a cycle is now caught and
 * reported as a specific, retryable validation error instead.
 */

function node(id: string, x: number, y: number) {
  return { id, kind: 'service' as const, label: id, x, y, config: defaultConfig('service') };
}

test('a cycle in the edges is reported as a clear error, not a crash', () => {
  const cyclic: Topology = {
    nodes: [node('a', NaN, NaN), node('b', NaN, NaN), node('c', NaN, NaN)],
    edges: [
      { id: 'e1', from: 'a', to: 'b', weight: 1 },
      { id: 'e2', from: 'b', to: 'c', weight: 1 },
      { id: 'e3', from: 'c', to: 'a', weight: 1 }, // closes the loop
    ],
  };

  // The bug crashed the whole process; the fix must not throw at all --
  // applyStep is expected to return a normal {ok:false} result.
  const result = applyStep({ nodes: [], edges: [] }, {
    addNodes: cyclic.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
    addEdges: cyclic.edges.map((e) => ({ from: e.from, to: e.to })),
    removeEdges: [],
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.join(' ')).toContain('cycle');
  }
});

test('a self-loop (a node wired to itself) is also caught, not just a longer cycle', () => {
  const result = applyStep(
    { nodes: [], edges: [] },
    {
      addNodes: [{ id: 'a', kind: 'service', label: 'a' }],
      addEdges: [{ from: 'a', to: 'a' }],
      removeEdges: [],
    },
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.join(' ')).toContain('cycle');
  }
});

test('a real (non-cyclic) diamond shape -- two parallel paths that reconverge -- is NOT mistaken for a cycle', () => {
  // client -> {lb -> service-1, lb -> service-2} -> db. This is a real,
  // common, valid shape (fan-out then fan-in) and must not trip the same
  // check that catches an actual cycle.
  const result = applyStep(
    { nodes: [], edges: [] },
    {
      addNodes: [
        { id: 'client-1', kind: 'client', label: 'Client' },
        { id: 'lb-1', kind: 'lb', label: 'LB' },
        { id: 'service-1', kind: 'service', label: 'Service A' },
        { id: 'service-2', kind: 'service', label: 'Service B' },
        { id: 'db-1', kind: 'db', label: 'DB' },
      ],
      addEdges: [
        { from: 'client-1', to: 'lb-1' },
        { from: 'lb-1', to: 'service-1' },
        { from: 'lb-1', to: 'service-2' },
        { from: 'service-1', to: 'db-1' },
        { from: 'service-2', to: 'db-1' },
      ],
      removeEdges: [],
    },
  );

  expect(result.ok).toBe(true);
});
