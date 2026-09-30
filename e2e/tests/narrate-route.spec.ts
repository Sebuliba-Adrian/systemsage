import { expect, test } from '@playwright/test';

/*
 * packages/narrator's Gemini TTS was proven for real in narrator.spec.ts
 * but never wired into the UI until now. This proves the actual HTTP
 * contract the UI depends on: POST /api/narrate returns real, valid,
 * playable WAV bytes, not a mock and not just a 200 status.
 */

test('POST /api/narrate returns real, valid WAV audio bytes', async ({ request }) => {
  const response = await request.post('/api/narrate', {
    data: { text: 'This is a real test of the narration endpoint.' },
  });
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toBe('audio/wav');

  const bytes = await response.body();
  expect(bytes.length).toBeGreaterThan(1000);

  // Real WAV header: "RIFF" .... "WAVE" -- proves this is actually decodable
  // audio, not an empty or malformed response that happens to 200.
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  const declaredPcmSize = bytes.readUInt32LE(40);
  expect(declaredPcmSize).toBe(bytes.length - 44);
});

test('POST /api/narrate with no text is refused with a real 400, not a crash', async ({ request }) => {
  const response = await request.post('/api/narrate', { data: {} });
  expect(response.status()).toBe(400);
  const body = (await response.json()) as { message: string };
  expect(body.message).toContain('text is required');
});
