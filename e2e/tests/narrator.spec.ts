import { test, expect } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { narrate } from '@systemsage/narrator';

/*
 * The narrator package was built and typechecked but NEVER actually
 * called before this test existed -- a real gap, found by asking "has
 * this actually been tested end to end" rather than assuming a clean
 * typecheck means it works. This calls the real Gemini TTS API and
 * verifies the result is real, playable audio, not just that the promise
 * resolves.
 */

loadEnv({ path: path.join(__dirname, '..', '..', 'apps', 'web', '.env.local') });

test('narrate() returns real, valid, non-trivial WAV audio from the real Gemini TTS API', async () => {
  const result = await narrate('Let us start with the simplest thing that could possibly work.');

  expect(result.mimeType).toBe('audio/wav');

  // A real WAV file, not an empty or malformed one: correct RIFF/WAVE
  // header, and a real, non-trivial audio payload (a few seconds of
  // 16-bit 24kHz mono speech should be tens of KB, not a few bytes).
  const header = result.audio.subarray(0, 4).toString('ascii');
  const waveMarker = result.audio.subarray(8, 12).toString('ascii');
  expect(header).toBe('RIFF');
  expect(waveMarker).toBe('WAVE');
  expect(result.audio.length).toBeGreaterThan(20_000);

  // The RIFF chunk size field (bytes 4-8) must actually match the real
  // file size, not a placeholder -- this is the check that would catch a
  // header written before the real audio length was known.
  const declaredSize = result.audio.readUInt32LE(4);
  expect(declaredSize).toBe(result.audio.length - 8);
});
