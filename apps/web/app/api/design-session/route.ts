import type { ProviderId } from '@systemsage/lesson-planner';
import { createSession } from './store';
import { advanceSession } from './runner';

/*
 * One design session's ENTRY POINT: creates a new, persisted session (see
 * store.ts) and starts advancing it over an SSE stream. See ARCHITECTURE.md:
 * this contract is written the way it is so a future mobile client is a
 * new consumer of it, not a reason to change it -- typed named events over
 * one connection, data (topology + stats JSON) rather than markup, exactly
 * the shape personal-assistant-mobile already proved works against a real
 * backend on a real device.
 *
 * Events emitted, in order:
 *   session { sessionId }                          -- always first
 *   step    { index, stepTitle, narration, topology, stats, seed, isFinalStep, attempts, retryReasons }
 *   paused  { sessionId, stepIndex }                -- stepMode only; POST /continue to advance
 *   done    { totalSteps, reason: 'isFinalStep' | 'max_steps_reached' | 'step_exhausted' }
 *   error   { message }
 *
 * `stepMode: true` in the request body takes exactly ONE step then emits
 * `paused` and ends the response -- the client calls POST
 * .../continue with { sessionId, mode: 'step' | 'auto' } to keep going,
 * either one more step at a time or through to completion. This is the
 * SAME mechanism a real dropped connection uses to recover: advanceSession
 * (runner.ts) stops and marks the session 'paused' the instant nobody is
 * listening, rather than either crashing or burning further real API
 * calls into the void -- a deliberate pause (step mode) and an incidental
 * one (a closed tab) are, at the protocol level, the same state.
 *
 * `session`/`paused` exist specifically so a client can reconnect to a
 * session that outlived its original connection -- without a durable,
 * addressable session (see store.ts), a dropped connection meant losing
 * all progress and starting over, the same real gap `isFinalStep`/`reason`
 * were added to make externally verifiable in an earlier round: without
 * them, there was no way to tell "genuinely finished" from "ran out of
 * budget" either.
 */

export const runtime = 'nodejs';

const MAX_STEPS = 8;
const SIMULATED_SECONDS = 30;
const SEED = 1;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { description?: string; provider?: ProviderId; stepMode?: boolean };
  const description = (body.description ?? '').trim();
  const provider = body.provider;
  const stepMode = body.stepMode ?? false;

  if (!description) {
    return new Response(sseFrame('error', { message: 'description is required' }), {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const session = createSession({ description, provider });

  // Set by cancel() when the client disconnects mid-stream (tab closed, a
  // test finishing early, a network drop) -- a REAL condition found live
  // via server-side logging (route.ts used to let `controller.enqueue`
  // throw ERR_INVALID_STATE straight into the catch block every time this
  // happened, which is not an application error, just a reader that left).
  // Shared between start() and cancel() by living outside both.
  let clientGone = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        } catch {
          // The client went away in the gap between our check and this
          // call -- not an application error, nothing left to do here.
          clientGone = true;
        }
      };

      send('session', { sessionId: session.id });

      try {
        await advanceSession(session, {
          auto: !stepMode,
          send,
          isClientGone: () => clientGone,
          maxSteps: MAX_STEPS,
          seed: SEED,
          simulatedSeconds: SIMULATED_SECONDS,
        });
      } catch (err) {
        // Log the real stack trace server-side -- sending only err.message
        // to the client (necessary; a stack trace is not something to hand
        // to a browser) had been silently swallowing the one thing needed
        // to diagnose a real crash found under concurrent load ("Invalid
        // array length"). Never repeat that: caught errors get logged in
        // full here, always.
        console.error('[design-session] real error, full detail:', err);
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed because the client disconnected -- expected,
          // not an error.
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
