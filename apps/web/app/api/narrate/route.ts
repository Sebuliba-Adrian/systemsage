import { narrate } from '@systemsage/narrator';

/*
 * Turns a step's narration (or a scrutiny answer) into real audio --
 * packages/narrator's Gemini TTS call, proven live and tested
 * (e2e/tests/narrator.spec.ts) but never wired into the UI until now.
 * Plain bytes in, plain bytes out: the client fetches this, gets a real
 * WAV blob, and plays it -- no need for JSON/base64 round-tripping the
 * audio when the browser's <audio> element can consume the bytes
 * directly via an object URL.
 *
 * Non-streaming for this first pass, matching narrator's own documented
 * next step (chunk-as-you-go playback) being deliberately deferred, not
 * silently skipped -- see ARCHITECTURE.md.
 */

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { text?: string };
  const text = (body.text ?? '').trim();

  if (!text) {
    return Response.json({ message: 'text is required' }, { status: 400 });
  }

  try {
    const result = await narrate(text);
    return new Response(new Uint8Array(result.audio), {
      headers: {
        'Content-Type': result.mimeType,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[narrate] real error, full detail:', err);
    return Response.json({ message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
