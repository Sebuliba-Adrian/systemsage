import { answerQuestion } from '@systemsage/lesson-planner';
import { getSession, touchSession } from '../store';

/*
 * The scrutiny side channel: POST { sessionId, question } while a session
 * is paused, get a real answer back, grounded in the actual topology and
 * stats the candidate already has -- not another lesson step (no schema,
 * no topology change, no retry budget, no simulate() call). Plain JSON in,
 * plain JSON out: unlike ../route.ts and ../continue/route.ts, this
 * produces exactly one answer, not a sequence of events, so there is no
 * reason to make it an SSE stream.
 *
 * Only allowed while `status === 'paused'` -- asking mid-auto-run makes no
 * sense (there is no stable "current step" to ask about while the loop is
 * actively advancing), and asking a `done` session is likewise refused
 * rather than silently answered against stale state.
 *
 * The answer is appended to the session's qaLog and handed to every later
 * planNextStep call as context (see plan.ts's buildUserPrompt) -- the
 * "soft" version of scrutiny: a real question actually shapes what gets
 * built next, but nothing mechanically forces the next step to resolve
 * it, and isFinalStep is never gated on it. See
 * packages/lesson-planner/src/ask.ts for why a hard gate was deliberately
 * not built.
 */

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { sessionId?: string; question?: string };
  const sessionId = (body.sessionId ?? '').trim();
  const question = (body.question ?? '').trim();

  if (!sessionId) {
    return Response.json({ message: 'sessionId is required' }, { status: 400 });
  }
  if (!question) {
    return Response.json({ message: 'question is required' }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ message: 'Session not found or expired. Start a new design.' }, { status: 404 });
  }
  if (session.status !== 'paused') {
    return Response.json(
      { message: `Can only ask a question while the session is paused (current status: ${session.status}).` },
      { status: 409 },
    );
  }

  try {
    const answer = await answerQuestion(
      {
        description: session.description,
        priorSteps: session.priorSteps,
        currentTopology: session.topology,
        qaLog: session.qaLog,
      },
      question,
      session.provider ? { provider: session.provider } : {},
    );

    touchSession(session, { qaLog: [...session.qaLog, { question, answer }] });
    return Response.json({ answer });
  } catch (err) {
    console.error('[design-session/ask] real error, full detail:', err);
    return Response.json(
      { message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
