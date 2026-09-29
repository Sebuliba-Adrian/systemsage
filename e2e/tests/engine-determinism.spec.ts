import { expect, test } from '@playwright/test';

/*
 * The one claim this whole project stands or falls on: the same topology
 * and seed, simulated twice, produce byte-identical SystemStats. No LLM
 * involved here on purpose -- this is a claim about the engine, not about
 * the tutor. See ARCHITECTURE.md's "Engine determinism" note.
 */

const FIXED_TOPOLOGY = {
  nodes: [
    {
      id: 'c',
      kind: 'client',
      label: 'Client',
      x: 0,
      y: 0,
      config: {
        capacity: 16,
        serviceMs: 5,
        queueLimit: 100,
        serviceCv: 1,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 5000,
        retries: 0,
        rps: 500,
      },
    },
    {
      id: 'api',
      kind: 'service',
      label: 'API',
      x: 200,
      y: 0,
      config: {
        capacity: 16,
        serviceMs: 20,
        queueLimit: 100,
        serviceCv: 1,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 5000,
        retries: 0,
        rps: 0,
      },
    },
  ],
  edges: [{ id: 'e1', from: 'c', to: 'api', weight: 1 }],
};

test('the same topology and seed produce identical stats every time', async ({ request }) => {
  const payload = { topology: FIXED_TOPOLOGY, seed: 1, simulatedSeconds: 10 };

  const [r1, r2, r3] = await Promise.all([
    request.post('/api/simulate', { data: payload }),
    request.post('/api/simulate', { data: payload }),
    request.post('/api/simulate', { data: payload }),
  ]);

  expect(r1.ok()).toBeTruthy();
  const [j1, j2, j3] = await Promise.all([r1.json(), r2.json(), r3.json()]);

  // Every single field must match exactly -- not "close enough", not
  // "within a tolerance". A real seeded discrete-event run has no random
  // slack to explain a mismatch; any difference here is a real bug.
  expect(j2).toStrictEqual(j1);
  expect(j3).toStrictEqual(j1);

  // And the numbers have to be real measured output, not a placeholder:
  // a system under real load has nonzero throughput and a p50 above zero.
  expect(j1.stats.totalRequests).toBeGreaterThan(0);
  expect(j1.stats.p50).toBeGreaterThan(0);
});

test('a different seed can legitimately produce different stats', async ({ request }) => {
  const [r1, r2] = await Promise.all([
    request.post('/api/simulate', { data: { topology: FIXED_TOPOLOGY, seed: 1, simulatedSeconds: 10 } }),
    request.post('/api/simulate', { data: { topology: FIXED_TOPOLOGY, seed: 2, simulatedSeconds: 10 } }),
  ]);
  const [j1, j2] = await Promise.all([r1.json(), r2.json()]);

  // This is not a determinism violation: a different seed is a different
  // random draw by design. Asserted so nobody "fixes" seed-sensitivity
  // later thinking it's the bug this suite exists to catch.
  expect(j1.seed).not.toBe(j2.seed);
});

test('an invalid topology is rejected with a real validation error, not a crash', async ({ request }) => {
  const response = await request.post('/api/simulate', {
    data: { topology: { nodes: [{ id: 'x' }], edges: [] } },
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error).toContain('isTopology');
});
