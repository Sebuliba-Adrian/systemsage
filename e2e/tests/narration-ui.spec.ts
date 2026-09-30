import { expect, test } from '@playwright/test';

/*
 * The UI half: clicking "Play" on a real step's narration actually fetches
 * real audio and starts real playback in the browser's <audio> element --
 * not just that the button exists. Real browser, real Gemini TTS call, no
 * mocking.
 */

test('clicking play on a step narration loads and starts real audio playback', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('description-input').fill(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  await page.getByTestId('step-mode-checkbox').check();
  await page.getByTestId('design-button').click();

  const firstStep = page.getByTestId('step').first();
  await expect(firstStep).toBeVisible({ timeout: 45_000 });

  await firstStep.getByTestId('play-narration-button').click();

  const audio = page.getByTestId('narration-audio');
  await expect(audio).toHaveJSProperty('paused', false, { timeout: 20_000 });
  const src = await audio.evaluate((el: HTMLAudioElement) => el.src);
  expect(src.startsWith('blob:')).toBe(true);
});

test('the "narrate automatically" checkbox auto-plays a newly arrived step without a manual click', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('narrate-checkbox').check();
  await page.getByTestId('step-mode-checkbox').check();
  await page.getByTestId('description-input').fill(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  await page.getByTestId('design-button').click();

  await expect(page.getByTestId('step').first()).toBeVisible({ timeout: 45_000 });

  const audio = page.getByTestId('narration-audio');
  await expect(audio).toHaveJSProperty('paused', false, { timeout: 20_000 });
});
