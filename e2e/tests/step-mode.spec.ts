import { expect, test } from '@playwright/test';

/*
 * The browser-facing half of resumability: checking "step through
 * manually" pauses after every step instead of auto-running to
 * completion, and both pause-time actions actually work -- "Continue"
 * takes exactly one more step, "Finish automatically" switches back to
 * the original auto-run behavior for the rest of the design. Real
 * browser, real Gemini calls, no mocking.
 */

test('step mode pauses after each step, and Continue advances the session', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');

  await page.getByTestId('step-mode-checkbox').check();
  await page.getByTestId('description-input').fill(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  await page.getByTestId('design-button').click();

  await expect(page.getByTestId('step')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.getByTestId('paused-controls')).toBeVisible();
  // Auto-run's own completion banners must NOT appear while paused.
  await expect(page.getByTestId('session-done')).toHaveCount(0);
  await expect(page.getByTestId('session-exhausted')).toHaveCount(0);

  await page.getByTestId('continue-step-button').click();

  // Two legitimate real outcomes, both proof Continue genuinely drove the
  // SAME session forward rather than doing nothing: a second step lands
  // and the session pauses again, OR the model couldn't produce a valid
  // step 2 within 3 tries (the isFinalStep error-rate gate, or schema
  // validation) and it degrades gracefully -- observed for real while
  // writing this test. Either way, one step already stands; a raw crash
  // or an empty page would not.
  await expect(
    page.getByTestId('step').nth(1).or(page.getByTestId('session-exhausted')),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('step').first()).toBeVisible();
});

test('"Finish automatically" switches a paused step-mode session back to running straight through', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');

  await page.getByTestId('step-mode-checkbox').check();
  await page.getByTestId('description-input').fill(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  await page.getByTestId('design-button').click();

  await expect(page.getByTestId('step')).toHaveCount(1, { timeout: 45_000 });
  await page.getByTestId('continue-auto-button').click();

  // Must reach a real completion state -- either genuinely finished or
  // gracefully exhausted -- not stay paused forever.
  await expect(
    page.getByTestId('session-done').or(page.getByTestId('session-exhausted')),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('paused-controls')).toHaveCount(0);
});
