import { expect, test } from '@playwright/test';
import { applyStep, simulate } from '@systemsage/engine';

/*
 * Per-node stats: the aggregate `stats` a step narrates is one number for
 * the whole topology; SimSnapshot.nodes is per component. This proves the
 * numbers are real and meaningful, not just plumbed through: an
 * undersized component reports high utilization and real shed/timeout
 * counts, the same component sized to survive the load reports low
 * utilization and none -- on the identical topology shape used to prove
 * the trace feature, for the same reason (a negative case that isn't
 * always red is what proves this isn't decoration).
 */

function buildTopology(sized: boolean) {
  const bigConfig = sized ? { capacity: 5000, queueLimit: 5000, serviceCv: 0 } : undefined;
  const result = applyStep(
    { nodes: [], edges: [] },
    {
      addNodes: [
        { id: 'client-1', kind: 'client', label: 'Client', config: { rps: 500, capacity: 5000, timeoutMs: 60000 } },
        { id: 'service-1', kind: 'service', label: 'API', config: bigConfig },
        { id: 'db-1', kind: 'db', label: 'DB', config: bigConfig },
      ],
      addEdges: [
        { from: 'client-1', to: 'service-1' },
        { from: 'service-1', to: 'db-1' },
      ],
      removeEdges: [],
    },
  );
  if (!result.ok) throw new Error(`test setup failed: ${result.errors.join(' ')}`);
  return result.topology;
}

test('an undersized component reports real high utilization and real shed traffic', () => {
  const overloaded = buildTopology(false);
  const result = simulate(overloaded, { seed: 1, simulatedSeconds: 10 });

  expect(Object.keys(result.nodeStats)).toEqual(
    expect.arrayContaining(['client-1', 'service-1', 'db-1']),
  );

  // service-1 is the real bottleneck for this exact shape (confirmed in
  // trace.spec.ts) -- it should show real saturation and real drops, not
  // just a nonzero-but-meaningless number.
  const serviceStats = result.nodeStats['service-1'];
  expect(serviceStats.utilization).toBeGreaterThan(0.9);
  expect(serviceStats.shedRate + serviceStats.timeoutRate).toBeGreaterThan(0);
});

test('the same component actually sized to survive the load reports low utilization and no drops', () => {
  const sized = buildTopology(true);
  const result = simulate(sized, { seed: 1, simulatedSeconds: 10 });

  for (const stats of Object.values(result.nodeStats)) {
    expect(stats.utilization).toBeLessThan(0.5);
    expect(stats.shedRate).toBe(0);
    expect(stats.timeoutRate).toBe(0);
  }
});

test('a real step in the browser renders the per-node stats table with a row per component', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('description-input').fill(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  await page.getByTestId('step-mode-checkbox').check();
  await page.getByTestId('design-button').click();

  const firstStep = page.getByTestId('step').first();
  await expect(firstStep).toBeVisible({ timeout: 45_000 });

  const table = firstStep.getByTestId('per-node-stats-table');
  await expect(table).toBeVisible();
  const rowCount = await table.getByTestId('per-node-stats-row').count();
  expect(rowCount).toBeGreaterThan(0);
});

test('a saturated component gets a real red/amber utilization border on the diagram, not always the default color', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('description-input').fill(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  await page.getByTestId('step-mode-checkbox').check();
  await page.getByTestId('design-button').click();

  const firstStep = page.getByTestId('step').first();
  await expect(firstStep).toBeVisible({ timeout: 45_000 });

  // The real brief overloads the first step's service/db badly (see
  // retry.spec.ts's own real runs against this exact brief) -- at least
  // one node's border must reflect that, not stay the default blue.
  const borders = firstStep.locator('[data-testid^="utilization-border-"]');
  const strokes = await borders.evaluateAll((els) => els.map((el) => el.getAttribute('stroke')));
  expect(strokes.length).toBeGreaterThan(0);
  expect(strokes.some((s) => s === '#ff6b6b' || s === '#f5a623')).toBe(true);
});

test('running the interactive canvas simulation shows the per-node stats table too', async ({ page }) => {
  await page.goto('/build');

  const canvas = page.getByTestId('build-canvas');
  const canvasBox = (await canvas.boundingBox())!;

  for (const [kind, pos] of [
    ['client', { x: canvasBox.x + 80, y: canvasBox.y + 80 }],
    ['service', { x: canvasBox.x + 320, y: canvasBox.y + 80 }],
  ] as const) {
    const palette = page.getByTestId(`palette-item-${kind}`);
    const paletteBox = (await palette.boundingBox())!;
    await page.mouse.move(paletteBox.x + 10, paletteBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(pos.x, pos.y, { steps: 8 });
    await page.mouse.up();
  }

  await page.getByTestId('run-simulation-button').click();
  await expect(page.getByTestId('per-node-stats-table')).toBeVisible();
});
