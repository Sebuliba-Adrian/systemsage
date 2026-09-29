import { expect, test, type Page } from '@playwright/test';

/*
 * The interactive canvas at /build is a fourth driver of the shared engine
 * core (see ARCHITECTURE.md): a human, dragging components by hand instead
 * of an LLM or an MCP agent proposing them. It runs the SAME
 * applyStep/simulate functions, entirely client-side (the engine package
 * has no Node-only dependencies), so a design built by hand is held to the
 * identical standard -- cycle detection included -- as one an LLM
 * proposed.
 *
 * These tests drive real pointer events in a real browser (no mocking of
 * drag behavior): Playwright's mouse API dispatches trusted mouse events,
 * which the browser derives real pointer events from, exercising the exact
 * onPointerDown/Move/Up handlers a real user would trigger.
 */

async function dragFromTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test('dragging two components onto the canvas and wiring them produces a real, simulated design', async ({ page }) => {
  await page.goto('/build');

  const canvas = page.getByTestId('build-canvas');
  const canvasBox = (await canvas.boundingBox())!;

  const clientPalette = page.getByTestId('palette-item-client');
  const clientBox = (await clientPalette.boundingBox())!;
  await dragFromTo(
    page,
    { x: clientBox.x + clientBox.width / 2, y: clientBox.y + clientBox.height / 2 },
    { x: canvasBox.x + 80, y: canvasBox.y + 80 },
  );

  const servicePalette = page.getByTestId('palette-item-service');
  const serviceBox = (await servicePalette.boundingBox())!;
  await dragFromTo(
    page,
    { x: serviceBox.x + serviceBox.width / 2, y: serviceBox.y + serviceBox.height / 2 },
    { x: canvasBox.x + 320, y: canvasBox.y + 80 },
  );

  await expect(page.getByTestId('node-client-1')).toBeVisible();
  await expect(page.getByTestId('node-service-1')).toBeVisible();

  // Wire client-1 -> service-1 by dragging from client-1's connector handle
  // onto service-1's body.
  const connector = page.getByTestId('connector-client-1');
  const connectorBox = (await connector.boundingBox())!;
  const serviceNode = page.getByTestId('node-service-1');
  const serviceNodeBox = (await serviceNode.boundingBox())!;
  await dragFromTo(
    page,
    { x: connectorBox.x + connectorBox.width / 2, y: connectorBox.y + connectorBox.height / 2 },
    { x: serviceNodeBox.x + serviceNodeBox.width / 2, y: serviceNodeBox.y + serviceNodeBox.height / 2 },
  );

  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  await expect(page.getByTestId('build-error')).toHaveCount(0);

  await page.getByTestId('run-simulation-button').click();

  for (const testId of ['stat-p50', 'stat-p95', 'stat-goodput', 'stat-error-rate']) {
    const text = await page.getByTestId(testId).innerText();
    const value = Number.parseFloat(text);
    expect(Number.isFinite(value), `${testId} was not a finite number: "${text}"`).toBe(true);
  }
});

test('dragging a node moves it -- position actually changes, not just visually', async ({ page }) => {
  await page.goto('/build');

  const canvas = page.getByTestId('build-canvas');
  const canvasBox = (await canvas.boundingBox())!;
  const palette = page.getByTestId('palette-item-cache');
  const paletteBox = (await palette.boundingBox())!;

  await dragFromTo(
    page,
    { x: paletteBox.x + paletteBox.width / 2, y: paletteBox.y + paletteBox.height / 2 },
    { x: canvasBox.x + 100, y: canvasBox.y + 100 },
  );

  const rect = page.getByTestId('node-cache-1').locator('rect');
  const xBefore = Number.parseFloat((await rect.getAttribute('x'))!);
  const yBefore = Number.parseFloat((await rect.getAttribute('y'))!);

  const nodeBox = (await page.getByTestId('node-cache-1').boundingBox())!;
  await dragFromTo(
    page,
    { x: nodeBox.x + 20, y: nodeBox.y + 20 },
    { x: nodeBox.x + 220, y: nodeBox.y + 180 },
  );

  const xAfter = Number.parseFloat((await rect.getAttribute('x'))!);
  const yAfter = Number.parseFloat((await rect.getAttribute('y'))!);

  expect(xAfter).not.toBeCloseTo(xBefore, 0);
  expect(yAfter).not.toBeCloseTo(yBefore, 0);
});

test('wiring a real cycle by hand is caught by the same GraphCycleError the LLM path uses, not silently accepted', async ({ page }) => {
  await page.goto('/build');

  const canvas = page.getByTestId('build-canvas');
  const canvasBox = (await canvas.boundingBox())!;

  const positions = [
    { x: canvasBox.x + 80, y: canvasBox.y + 60 },
    { x: canvasBox.x + 320, y: canvasBox.y + 60 },
    { x: canvasBox.x + 200, y: canvasBox.y + 220 },
  ];
  for (const pos of positions) {
    const palette = page.getByTestId('palette-item-service');
    const paletteBox = (await palette.boundingBox())!;
    await dragFromTo(page, { x: paletteBox.x + 10, y: paletteBox.y + 10 }, pos);
  }

  await expect(page.locator('[data-testid^="node-service-"]')).toHaveCount(3);

  async function wire(fromId: string, toId: string) {
    const connector = page.getByTestId(`connector-${fromId}`);
    const connectorBox = (await connector.boundingBox())!;
    const target = page.getByTestId(`node-${toId}`);
    const targetBox = (await target.boundingBox())!;
    await dragFromTo(
      page,
      { x: connectorBox.x + connectorBox.width / 2, y: connectorBox.y + connectorBox.height / 2 },
      { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 },
    );
  }

  await wire('service-1', 'service-2');
  await wire('service-2', 'service-3');
  await wire('service-3', 'service-1'); // closes the loop

  await expect(page.getByTestId('build-error')).toContainText('cycle');
  // The rejected edge must not have been silently added anyway.
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
});

test('selecting an edge and deleting it removes exactly that edge', async ({ page }) => {
  await page.goto('/build');

  const canvas = page.getByTestId('build-canvas');
  const canvasBox = (await canvas.boundingBox())!;

  for (const [kind, pos] of [
    ['client', { x: canvasBox.x + 80, y: canvasBox.y + 80 }],
    ['service', { x: canvasBox.x + 320, y: canvasBox.y + 80 }],
  ] as const) {
    const palette = page.getByTestId(`palette-item-${kind}`);
    const paletteBox = (await palette.boundingBox())!;
    await dragFromTo(page, { x: paletteBox.x + 10, y: paletteBox.y + 10 }, pos);
  }

  const connector = page.getByTestId('connector-client-1');
  const connectorBox = (await connector.boundingBox())!;
  const serviceNode = page.getByTestId('node-service-1');
  const serviceNodeBox = (await serviceNode.boundingBox())!;
  await dragFromTo(
    page,
    { x: connectorBox.x + connectorBox.width / 2, y: connectorBox.y + connectorBox.height / 2 },
    { x: serviceNodeBox.x + serviceNodeBox.width / 2, y: serviceNodeBox.y + serviceNodeBox.height / 2 },
  );
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  const edge = page.locator('[data-testid^="edge-"]').first();
  const edgeBox = (await edge.boundingBox())!;
  await page.mouse.click(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);

  await page.getByTestId('delete-edge-button').click();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(0);
});

test('deleting a node also cascades its edges, but leaves unrelated nodes and edges intact', async ({ page }) => {
  await page.goto('/build');

  const canvas = page.getByTestId('build-canvas');
  const canvasBox = (await canvas.boundingBox())!;

  // client-1 -> service-1 -> db-1. Deleting service-1 should take BOTH
  // edges with it (cascade), but client-1 and db-1 must survive untouched.
  for (const [kind, pos] of [
    ['client', { x: canvasBox.x + 80, y: canvasBox.y + 60 }],
    ['service', { x: canvasBox.x + 320, y: canvasBox.y + 60 }],
    ['db', { x: canvasBox.x + 560, y: canvasBox.y + 60 }],
  ] as const) {
    const palette = page.getByTestId(`palette-item-${kind}`);
    const paletteBox = (await palette.boundingBox())!;
    await dragFromTo(page, { x: paletteBox.x + 10, y: paletteBox.y + 10 }, pos);
  }

  async function wire(fromId: string, toId: string) {
    const connector = page.getByTestId(`connector-${fromId}`);
    const connectorBox = (await connector.boundingBox())!;
    const target = page.getByTestId(`node-${toId}`);
    const targetBox = (await target.boundingBox())!;
    await dragFromTo(
      page,
      { x: connectorBox.x + connectorBox.width / 2, y: connectorBox.y + connectorBox.height / 2 },
      { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 },
    );
  }

  await wire('client-1', 'service-1');
  await wire('service-1', 'db-1');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);

  // Select service-1 (click its body, away from the connector handle) and
  // delete it via the inspector.
  const serviceBox = (await page.getByTestId('node-service-1').boundingBox())!;
  await page.mouse.click(serviceBox.x + 20, serviceBox.y + 20);
  await expect(page.getByTestId('node-inspector')).toBeVisible();
  await page.getByTestId('delete-node-button').click();

  await expect(canvas.locator('[data-testid^="node-"]')).toHaveCount(2);
  await expect(page.getByTestId('node-service-1')).toHaveCount(0);
  await expect(page.getByTestId('node-client-1')).toBeVisible();
  await expect(page.getByTestId('node-db-1')).toBeVisible();
  // Both edges touched service-1, so both must be gone -- not just the one
  // that happened to be selected.
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(0);
  await expect(page.getByTestId('build-error')).toHaveCount(0);

  // The two survivors must still be a valid, simulatable topology.
  await page.getByTestId('run-simulation-button').click();
  const p50 = Number.parseFloat(await page.getByTestId('stat-p50').innerText());
  expect(Number.isFinite(p50)).toBe(true);
});

test('clear canvas resets to the empty state', async ({ page }) => {
  await page.goto('/build');

  const canvas = page.getByTestId('build-canvas');
  const canvasBox = (await canvas.boundingBox())!;
  const palette = page.getByTestId('palette-item-db');
  const paletteBox = (await palette.boundingBox())!;
  await dragFromTo(
    page,
    { x: paletteBox.x + 10, y: paletteBox.y + 10 },
    { x: canvasBox.x + 100, y: canvasBox.y + 100 },
  );
  await expect(canvas.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('clear-canvas-button').click();
  await expect(canvas.locator('[data-testid^="node-"]')).toHaveCount(0);
  await expect(canvas).toContainText('Drag a component here to start');
});
