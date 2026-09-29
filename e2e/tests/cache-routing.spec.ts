import { test, expect } from '@playwright/test';
import { planNextStep, type StepGenerator, type LessonStep } from '@systemsage/lesson-planner';
import { defaultConfig, simulate, type Topology } from '@systemsage/engine';

/*
 * Regression test for the real bug found by looking at a live screenshot:
 * "add a cache" only ever ADDED an edge (service -> cache), leaving the old
 * service -> db edge in place, so traffic fanned out to both instead of
 * routing through the cache. Fixed by adding `removeEdges` to the schema
 * and teaching the planner, explicitly, to remove the edge it's inserting
 * into. Two things are proven here, deliberately kept separate:
 *   1. The planner-level fix: a scripted step with removeEdges actually
 *      removes the old edge (no live LLM call).
 *   2. The engine-level claim the fix is FOR: the corrected (chained)
 *      topology has real, better measured stats than the buggy (fan-out)
 *      one -- not just "looks more correct on a diagram."
 */

function config(overrides: Record<string, number> = {}) {
  return { ...defaultConfig('service'), ...overrides };
}

test('removeEdges actually removes the old edge when a cache is inserted', async () => {
  const before: Topology = {
    nodes: [
      { id: 'client-1', kind: 'client', label: 'Client', x: 0, y: 0, config: defaultConfig('client') },
      { id: 'service-1', kind: 'service', label: 'API', x: 220, y: 0, config: defaultConfig('service') },
      { id: 'db-1', kind: 'db', label: 'DB', x: 440, y: 0, config: defaultConfig('db') },
    ],
    edges: [
      { id: 'e1', from: 'client-1', to: 'service-1', weight: 1 },
      { id: 'e2', from: 'service-1', to: 'db-1', weight: 1 },
    ],
  };

  const scripted: StepGenerator = async () => ({
    object: {
      stepTitle: 'Add a Cache',
      narration: 'Routing reads through a cache before they reach the database.',
      addNodes: [{ id: 'cache-1', kind: 'cache', label: 'Cache' }],
      addEdges: [
        { from: 'service-1', to: 'cache-1' },
        { from: 'cache-1', to: 'db-1' },
      ],
      removeEdges: [{ from: 'service-1', to: 'db-1' }],
      isFinalStep: false,
    } satisfies LessonStep,
  });

  const result = await planNextStep(
    { description: 'irrelevant for this test', priorSteps: [], currentTopology: before },
    { generate: scripted },
  );

  const pairs = result.topology.edges.map((e) => `${e.from}->${e.to}`);
  expect(pairs).not.toContain('service-1->db-1'); // the old direct edge is gone
  expect(pairs).toContain('service-1->cache-1');
  expect(pairs).toContain('cache-1->db-1');
});

test('a removeEdges entry naming a nonexistent edge is retried, not silently ignored', async () => {
  const topology: Topology = {
    nodes: [{ id: 'service-1', kind: 'service', label: 'API', x: 0, y: 0, config: defaultConfig('service') }],
    edges: [],
  };

  let calls = 0;
  let feedbackSeenOnRetry: string | undefined;

  const scripted: StepGenerator = async ({ prompt }) => {
    calls += 1;
    if (calls === 1) {
      return {
        object: {
          stepTitle: 'Bad removal',
          narration: 'x',
          addNodes: [],
          addEdges: [],
          removeEdges: [{ from: 'service-1', to: 'db-1' }], // never existed
          isFinalStep: false,
        } satisfies LessonStep,
      };
    }
    feedbackSeenOnRetry = prompt;
    return {
      object: {
        stepTitle: 'Fixed',
        narration: 'x',
        addNodes: [],
        addEdges: [],
        removeEdges: [],
        isFinalStep: true,
      } satisfies LessonStep,
    };
  };

  await planNextStep({ description: 'x', priorSteps: [], currentTopology: topology }, { generate: scripted });

  expect(calls).toBe(2);
  expect(feedbackSeenOnRetry).toContain('Tried to remove a nonexistent edge');
});

test('ENGINE PROOF: chaining through the cache measurably beats fanning out to it', async () => {
  const sharedNodes = [
    { id: 'client-1', kind: 'client' as const, label: 'Client', x: 0, y: 0, config: { ...defaultConfig('client'), rps: 500 } },
    { id: 'service-1', kind: 'service' as const, label: 'API', x: 220, y: 0, config: config({ capacity: 8, serviceMs: 10 }) },
    // A slow, easily-saturated database -- the exact condition that makes a
    // cache worth adding at all.
    { id: 'db-1', kind: 'db' as const, label: 'DB', x: 440, y: 0, config: config({ capacity: 4, serviceMs: 40 }) },
    { id: 'cache-1', kind: 'cache' as const, label: 'Cache', x: 440, y: 120, config: config({ capacity: 16, serviceMs: 2, hitRate: 0.9 }) },
  ];

  // BUGGY shape: the old direct edge survives, so the db sees full load
  // exactly as before, and the cache does nothing to protect it.
  const fanOut: Topology = {
    nodes: sharedNodes,
    edges: [
      { id: 'e1', from: 'client-1', to: 'service-1', weight: 1 },
      { id: 'e2', from: 'service-1', to: 'db-1', weight: 1 },
      { id: 'e3', from: 'service-1', to: 'cache-1', weight: 1 },
    ],
  };

  // FIXED shape: the old edge is gone; the db is only reached on a cache
  // miss.
  const chained: Topology = {
    nodes: sharedNodes,
    edges: [
      { id: 'e1', from: 'client-1', to: 'service-1', weight: 1 },
      { id: 'e2', from: 'service-1', to: 'cache-1', weight: 1 },
      { id: 'e3', from: 'cache-1', to: 'db-1', weight: 1 },
    ],
  };

  const fanOutResult = simulate(fanOut, { seed: 1, simulatedSeconds: 20 });
  const chainedResult = simulate(chained, { seed: 1, simulatedSeconds: 20 });

  // The whole point of the fix: with the cache actually in the path, the
  // database sees a fraction of the load instead of all of it, so goodput
  // is higher and p95 latency is lower -- a real, measured difference, not
  // an assumed one.
  expect(chainedResult.stats.goodputRps).toBeGreaterThan(fanOutResult.stats.goodputRps);
  expect(chainedResult.stats.p95).toBeLessThan(fanOutResult.stats.p95);
});
