import { planNextStep, StepExhaustedError } from '@systemsage/lesson-planner';
import type { SessionState } from './store';
import { touchSession } from './store';

/*
 * The one place a session is actually advanced, shared by the initial
 * POST (a brand-new session) and /continue (an existing, persisted one)
 * -- so "start a session" and "resume one" can never quietly drift into
 * two different ideas of what a step is, the same DRY discipline
 * packages/engine's applyStep already holds both design drivers to.
 *
 * `auto: false` takes exactly one step then pauses -- this is both step
 * mode's "Continue" button AND, at the protocol level, indistinguishable
 * from "the client disconnected mid-auto-run and the loop stopped to
 * avoid spending further real API calls with nobody listening." Both
 * leave the session in the exact same 'paused' state, resumable the
 * exact same way. `auto: true` keeps going until the design finishes,
 * runs out of retries, or nobody's listening anymore.
 */
export interface AdvanceOpts {
  auto: boolean;
  send: (event: string, data: unknown) => void;
  isClientGone: () => boolean;
  maxSteps: number;
  seed: number;
  simulatedSeconds: number;
}

export async function advanceSession(session: SessionState, opts: AdvanceOpts): Promise<void> {
  touchSession(session, { status: 'running' });

  while (session.priorSteps.length < opts.maxSteps) {
    if (opts.isClientGone()) {
      // Nobody is listening. Stop spending real API calls into the void
      // -- leave the session paused exactly here for a later /continue
      // (a deliberate one, or a genuine reconnect) to pick up from.
      touchSession(session, { status: 'paused' });
      return;
    }

    let planned;
    try {
      planned = await planNextStep(
        {
          description: session.description,
          priorSteps: session.priorSteps,
          currentTopology: session.topology,
          qaLog: session.qaLog,
        },
        {
          seed: opts.seed,
          simulatedSeconds: opts.simulatedSeconds,
          ...(session.provider ? { provider: session.provider } : {}),
        },
      );
    } catch (err) {
      if (err instanceof StepExhaustedError) {
        touchSession(session, { status: 'done', reason: 'step_exhausted', lastStepError: err.message });
        opts.send('done', { totalSteps: session.priorSteps.length, reason: 'step_exhausted', lastStepError: err.message });
        return;
      }
      touchSession(session, { status: 'error' });
      throw err;
    }

    session.topology = planned.topology;
    session.priorSteps.push(planned.step);
    touchSession(session, {});

    opts.send('step', {
      index: session.priorSteps.length - 1,
      stepTitle: planned.step.stepTitle,
      narration: planned.step.narration,
      topology: session.topology,
      stats: planned.stats,
      seed: opts.seed,
      isFinalStep: planned.step.isFinalStep,
      attempts: planned.attempts,
      retryReasons: planned.retryReasons,
    });

    if (planned.step.isFinalStep) {
      touchSession(session, { status: 'done', reason: 'isFinalStep' });
      opts.send('done', { totalSteps: session.priorSteps.length, reason: 'isFinalStep' });
      return;
    }

    if (!opts.auto) {
      touchSession(session, { status: 'paused' });
      opts.send('paused', { sessionId: session.id, stepIndex: session.priorSteps.length });
      return;
    }
  }

  touchSession(session, { status: 'done', reason: 'max_steps_reached' });
  opts.send('done', { totalSteps: session.priorSteps.length, reason: 'max_steps_reached' });
}
