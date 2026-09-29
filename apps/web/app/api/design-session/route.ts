import { planNextStep, StepExhaustedError, type LessonStep, type ProviderId } from '@systemsage/lesson-planner';
import { simulate, type Topology } from '@systemsage/engine';

/*
 * One design session, one SSE stream. See ARCHITECTURE.md: this contract
 * is written the way it is so a future mobile client is a new consumer of
 * it, not a reason to change it -- typed named events over one connection,
 * data (topology + stats JSON) rather than markup, exactly the shape
 * personal-assistant-mobile already proved works against a real backend
 * on a real device.
 *
 * Events emitted, in order:
 *   step   { index, stepTitle, narration, topology, stats, seed, isFinalStep, attempts, retryReasons }
 *   done   { totalSteps, reason: 'isFinalStep' | 'max_steps_reached' | 'step_exhausted' }
 *   error  { message }
 *
 * `isFinalStep` and `reason` exist specifically so a real session's ending
 * is verifiable from the outside: without them, a session that always runs
 * out the step budget looks identical, from any client-visible data, to
 * one that genuinely finished the design -- a real gap found by trying to
 * confirm this externally and discovering there was no way to.
 *
 * `attempts`/`retryReasons` exist for the same reason: without them, a
 * step that needed a real retry looks IDENTICAL to one that succeeded on
 * the first try. This is what makes a retry actually visible in the
 * browser, not just internally handled.
 *
 * `reason: 'step_exhausted'` is a real, observed failure mode, not a
 * hypothetical: a stress test against DeepSeek (whose JSON-schema output
 * mode is a compatibility shim, not native, and is measurably more
 * failure-prone) produced a real step that failed all 3 attempts in a
 * row. Ending the whole session in a raw `error` after several good steps
 * already shown would throw away real progress over one step's failure,
 * so that case degrades to `done` instead, keeping every step that
 * actually succeeded.
 */

export const runtime = 'nodejs';

const MAX_STEPS = 8;
const SIMULATED_SECONDS = 30;
const SEED = 1;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { description?: string; provider?: ProviderId };
  const description = (body.description ?? '').trim();
  const provider = body.provider;

  if (!description) {
    return new Response(sseFrame('error', { message: 'description is required' }), {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

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

      let topology: Topology = { nodes: [], edges: [] };
      const priorSteps: LessonStep[] = [];

      let reason: 'isFinalStep' | 'max_steps_reached' | 'step_exhausted' = 'max_steps_reached';
      try {
        for (let index = 0; index < MAX_STEPS; index++) {
          let planned;
          try {
            planned = await planNextStep(
              { description, priorSteps, currentTopology: topology },
              provider ? { provider } : {},
            );
          } catch (err) {
            if (err instanceof StepExhaustedError) {
              // A real, live failure mode (see the doc comment above): the
              // model failed every attempt on this step. Keep every step
              // that DID succeed and stop cleanly here, rather than
              // throwing the whole session's real progress away. The
              // outer finally still closes the controller exactly once.
              reason = 'step_exhausted';
              send('done', { totalSteps: priorSteps.length, reason, lastStepError: err.message });
              return;
            }
            throw err;
          }

          topology = planned.topology;
          priorSteps.push(planned.step);

          const result = simulate(topology, { seed: SEED, simulatedSeconds: SIMULATED_SECONDS });

          send('step', {
            index,
            stepTitle: planned.step.stepTitle,
            narration: planned.step.narration,
            topology,
            stats: result.stats,
            seed: result.seed,
            isFinalStep: planned.step.isFinalStep,
            attempts: planned.attempts,
            retryReasons: planned.retryReasons,
          });

          if (planned.step.isFinalStep) {
            reason = 'isFinalStep';
            break;
          }
        }
        send('done', { totalSteps: priorSteps.length, reason });
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
