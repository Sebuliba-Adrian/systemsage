import { getSession } from '../store';
import { advanceSession } from '../runner';

/*
 * Advances an EXISTING, persisted session (see ../store.ts) -- this is
 * the resumption half of the feature ../route.ts's doc comment describes.
 * A session paused for either reason (step mode's "Continue" button, or a
 * connection that dropped mid-auto-run) is resumed by exactly the same
 * call: { sessionId, mode }. mode 'step' takes one more step then pauses
 * again; mode 'auto' switches to running straight through to completion
 * -- the "eventually continue with the original flow" escape hatch from
 * a step-mode session, and the SAME path a real reconnect after a real
 * disconnect uses to pick back up.
 *
 * Same event contract as ../route.ts, minus the initial `session` event
 * (the client already has the id -- that's how it got here).
 */

export const runtime = 'nodejs';

const MAX_STEPS = 8;
const SIMULATED_SECONDS = 30;
const SEED = 1;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { sessionId?: string; mode?: 'step' | 'auto' };
  const sessionId = (body.sessionId ?? '').trim();
  const mode = body.mode ?? 'step';

  if (!sessionId) {
    return new Response(sseFrame('error', { message: 'sessionId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const session = getSession(sessionId);
  if (!session) {
    return new Response(sseFrame('error', { message: 'Session not found or expired. Start a new design.' }), {
      status: 404,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  if (session.status === 'done') {
    return new Response(
      sseFrame('done', { totalSteps: session.priorSteps.length, reason: session.reason ?? 'isFinalStep' }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  let clientGone = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        } catch {
          clientGone = true;
        }
      };

      try {
        await advanceSession(session, {
          auto: mode === 'auto',
          send,
          isClientGone: () => clientGone,
          maxSteps: MAX_STEPS,
          seed: SEED,
          simulatedSeconds: SIMULATED_SECONDS,
        });
      } catch (err) {
        console.error('[design-session/continue] real error, full detail:', err);
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed because the client disconnected -- expected.
        }
      }
    },
    cancel() {
      clientGone = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
