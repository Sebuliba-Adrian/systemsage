import type { LessonStep, ProviderId } from '@systemsage/lesson-planner';
import type { Topology } from '@systemsage/engine';

/*
 * A session's durable state, held in memory across separate HTTP requests
 * -- this is what makes "continue this session" and "resume after a
 * dropped connection" the same operation instead of two different
 * features. Deliberately a plain module-level Map, not a database:
 * this app is one long-running Node process (`next dev` / `next start`,
 * `export const runtime = 'nodejs'` in route.ts), not a serverless
 * deployment where each request could land on a different instance with
 * its own empty memory. A real multi-instance deployment would need a
 * real store (Redis, etc.) instead of this Map -- noted here rather than
 * silently assumed away.
 *
 * Before this existed, a whole design session lived ONLY in local
 * variables inside one ReadableStream's start() closure: a disconnect
 * (tab closed, network drop) didn't crash anything (see route.ts's
 * clientGone handling), but there was no way back into that session --
 * a reconnect was always a brand-new session starting from nothing. This
 * store is what makes "start()" and "continue()" the same session.
 */

export interface SessionState {
  id: string;
  description: string;
  provider?: ProviderId;
  topology: Topology;
  priorSteps: LessonStep[];
  /**
   * 'running' only exists transiently while a request is actively driving
   * this session (auto-loop mid-flight); 'paused' is the durable resting
   * state a session sits in between steps -- whether that pause was
   * deliberate (step mode) or incidental (the client disconnected
   * mid-auto-run and the loop stopped rather than burn further real API
   * calls into the void). Both cases resume identically via /continue.
   */
  status: 'running' | 'paused' | 'done' | 'error';
  reason?: 'isFinalStep' | 'max_steps_reached' | 'step_exhausted';
  lastStepError?: string;
  updatedAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, SessionState>();

function sweepExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.updatedAt < cutoff) sessions.delete(id);
  }
}

export function createSession(params: { description: string; provider?: ProviderId }): SessionState {
  sweepExpired();
  const session: SessionState = {
    id: crypto.randomUUID(),
    description: params.description,
    provider: params.provider,
    topology: { nodes: [], edges: [] },
    priorSteps: [],
    status: 'running',
    updatedAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): SessionState | undefined {
  sweepExpired();
  return sessions.get(id);
}

export function touchSession(session: SessionState, patch: Partial<SessionState>): SessionState {
  Object.assign(session, patch, { updatedAt: Date.now() });
  return session;
}
