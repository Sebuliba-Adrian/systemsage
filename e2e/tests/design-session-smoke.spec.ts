import { expect, test } from '@playwright/test';

/*
 * Real pipeline, real browser, real LLM call -- no mocking. This does NOT
 * assert the same description produces the same design twice (see
 * ARCHITECTURE.md: which component the planner proposes first is a
 * legitimate judgment call). What it proves is narrower and just as
 * important: the full path from a learner's plain-language description to
 * a rendered, validated, really-simulated step actually works, end to end,
 * with real numbers on screen -- not a mock, not a placeholder.
 */

test('describing a system produces a real, validated, rendered first step', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('description-input').fill(
    'A photo-sharing app that needs to handle sudden viral traffic spikes',
  );
  await page.getByTestId('design-button').click();

  const firstStep = page.getByTestId('step').first();
  await expect(firstStep).toBeVisible({ timeout: 45_000 });

  // No error banner should appear alongside a rendered step.
  await expect(page.getByTestId('error-message')).toHaveCount(0);

  // Narration must be real generated text, not empty and not a stub.
  const narration = await firstStep.getByTestId('narration').innerText();
  expect(narration.length).toBeGreaterThan(20);

  // At least one component must actually be drawn on the canvas.
  const nodeCount = await firstStep.locator('[data-testid^="node-"]').count();
  expect(nodeCount).toBeGreaterThan(0);

  // Every stat shown must be a real finite number, not NaN or a placeholder
  // string -- this is the check that would have caught an engine call that
  // silently failed and left the UI rendering "NaN ms".
  for (const testId of ['stat-p50', 'stat-p95', 'stat-goodput', 'stat-error-rate']) {
    const text = await firstStep.getByTestId(testId).innerText();
    const value = Number.parseFloat(text);
    expect(Number.isFinite(value), `${testId} was not a finite number: "${text}"`).toBe(true);
  }
});

test('a first step always starts simple: at most a client, one service, one store', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('description-input').fill(
    'A ride-sharing platform matching drivers to riders in real time',
  );
  await page.getByTestId('design-button').click();

  const firstStep = page.getByTestId('step').first();
  await expect(firstStep).toBeVisible({ timeout: 45_000 });

  // This is a real pedagogical claim from the system prompt (plan.ts:
  // "the first step is always the simplest thing that could possibly
  // work"), worth its own check independent of the general smoke test
  // above -- if the planner ever front-loads a fully scaled architecture
  // in step one, the whole "step by step" premise of the product is broken,
  // and that's a regression this suite should catch on its own.
  const nodeCount = await firstStep.locator('[data-testid^="node-"]').count();
  expect(nodeCount).toBeLessThanOrEqual(3);
});
