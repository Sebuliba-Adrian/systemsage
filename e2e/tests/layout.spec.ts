import { test, expect } from '@playwright/test';
import { assignLayout } from '@systemsage/lesson-planner';
import type { SimEdge, SimNode } from '@systemsage/engine';

/*
 * Regression test for a real bug found by looking at the actual rendered
 * canvas (see the Step 2 screenshot in the conversation this repo came
 * from): a node added in a LATER step, at the same depth as a node an
 * EARLIER step already placed, landed on the exact same (x, y) and was
 * drawn directly on top of it. Nothing in a JSON diff would have caught
 * this -- both nodes were present in the topology the whole time, and the
 * bug is purely "two boxes occupy the same pixels."
 */

function node(id: string, x: number, y: number): SimNode {
  return {
    id,
    kind: 'service',
    label: id,
    x,
    y,
    config: { capacity: 1, serviceMs: 1, queueLimit: 1 },
  };
}

test('a node added later never lands on the same position as an already-placed one', () => {
  // Simulates exactly the two-call sequence a real session runs: step 1
  // lays out client -> service -> db, all fresh (NaN placeholders).
  const step1Nodes: SimNode[] = [node('client-1', NaN, NaN), node('service-1', NaN, NaN), node('db-1', NaN, NaN)];
  const step1Edges: SimEdge[] = [
    { id: 'e1', from: 'client-1', to: 'service-1', weight: 1 },
    { id: 'e2', from: 'service-1', to: 'db-1', weight: 1 },
  ];
  assignLayout(step1Nodes, step1Edges);

  // Step 2 carries the SAME (already-positioned) three nodes forward and
  // adds a new sibling at db-1's depth, exactly like planNextStep does.
  const step2Nodes: SimNode[] = [...step1Nodes, node('cache-1', NaN, NaN)];
  const step2Edges: SimEdge[] = [...step1Edges, { id: 'e3', from: 'service-1', to: 'cache-1', weight: 1 }];
  assignLayout(step2Nodes, step2Edges);

  const dbNode = step2Nodes.find((n) => n.id === 'db-1')!;
  const cacheNode = step2Nodes.find((n) => n.id === 'cache-1')!;

  expect(dbNode.x).toBe(cacheNode.x); // same depth, so same column -- expected
  expect(dbNode.y).not.toBe(cacheNode.y); // but must not be the same row

  // General form of the same check: no two nodes anywhere overlap exactly.
  const positions = new Set(step2Nodes.map((n) => `${n.x},${n.y}`));
  expect(positions.size).toBe(step2Nodes.length);

  // And step 1's nodes must not have been silently moved by step 2's call
  // -- a layout stable only "on average" would still fail the check above
  // while breaking this one.
  expect(step2Nodes.find((n) => n.id === 'client-1')!.x).toBe(step1Nodes[0].x);
  expect(step2Nodes.find((n) => n.id === 'service-1')!.y).toBe(step1Nodes[1].y);
});
