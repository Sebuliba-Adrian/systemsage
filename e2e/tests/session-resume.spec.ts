import { expect, test, type APIResponse } from '@playwright/test';

/*
 * Proves the actual claim: a session survives past the request that
 * created it, and a SEPARATE request (referencing only the sessionId) can
 * continue it -- that is what "resuming after a dropped connection" means
 * at the protocol level, and it's exactly what step mode's "Continue"
 * button already exercises through the browser. No mocking: real Gemini
 * calls, real persisted session state (see ../../apps/web/app/api/
 * design-session/store.ts), two independent HTTP requests.
 */

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.trim())
    .map((frame) => {
      let event = 'message';
      let dataLine = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        else if (line.startsWith('data: ')) dataLine = line.slice('data: '.length);
      }
      return { event, data: dataLine ? JSON.parse(dataLine) : {} };
    });
}

async function events(response: APIResponse): Promise<SseEvent[]> {
  return parseSse(await response.text());
}

test('a stepMode session pauses after exactly one step and can be continued by a separate request', async ({ request }) => {
  const first = await request.post('/api/design-session', {
    data: {
      description: 'A URL shortener that needs to handle 2000 requests per second',
      provider: 'gemini',
      stepMode: true,
    },
  });
  expect(first.ok()).toBe(true);
  const firstEvents = await events(first);

  const sessionEvent = firstEvents.find((e) => e.event === 'session');
  expect(sessionEvent).toBeTruthy();
  const sessionId = sessionEvent!.data.sessionId as string;
  expect(typeof sessionId).toBe('string');
  expect(sessionId.length).toBeGreaterThan(0);

  const stepEvents = firstEvents.filter((e) => e.event === 'step');
  expect(stepEvents).toHaveLength(1);
  expect(stepEvents[0].data.index).toBe(0);

  const pausedEvent = firstEvents.find((e) => e.event === 'paused');
  expect(pausedEvent).toBeTruthy();
  expect(pausedEvent!.data.stepIndex).toBe(1);
  // The response must actually end here -- no second step in the same request.
  expect(firstEvents.find((e) => e.event === 'done')).toBeUndefined();

  // A SEPARATE request, days later in principle, referencing only the id.
  const second = await request.post('/api/design-session/continue', {
    data: { sessionId, mode: 'step' },
  });
  expect(second.ok()).toBe(true);
  const secondEvents = await events(second);

  const secondStepEvents = secondEvents.filter((e) => e.event === 'step');
  const secondDoneEvent = secondEvents.find((e) => e.event === 'done');

  if (secondStepEvents.length > 0) {
    // The common case: continuation produced a real next step, building on
    // the first one. Continuing the SAME session must produce step index
    // 1, not restart at 0 -- proof this is a real continuation, not a
    // fresh session in disguise.
    expect(secondStepEvents[0].data.index).toBe(1);
    const secondTopology = secondStepEvents[0].data.topology as { nodes: unknown[] };
    // The second step's topology must build on the first step's, not
    // replace it -- more nodes than a from-scratch first step would ever
    // have alone.
    expect(secondTopology.nodes.length).toBeGreaterThanOrEqual(3);
  } else {
    // A real, legitimate alternative outcome, not a bug: the model
    // couldn't produce a valid step 2 within 3 tries (schema validation,
    // or the isFinalStep error-rate gate) and StepExhaustedError degraded
    // gracefully instead of crashing -- observed live while writing this
    // test. totalSteps must be 1 (the ONE step already banked from the
    // FIRST request), not 0 -- proof continue knew about prior progress
    // instead of quietly starting a fresh session.
    expect(secondDoneEvent).toBeTruthy();
    expect(secondDoneEvent!.data.reason).toBe('step_exhausted');
    expect(secondDoneEvent!.data.totalSteps).toBe(1);
  }
});

test('continuing with mode "auto" finishes the rest of a step-mode session without pausing again', async ({ request }) => {
  test.setTimeout(150_000);
  const first = await request.post('/api/design-session', {
    data: { description: 'A URL shortener that needs to handle 2000 requests per second', provider: 'gemini', stepMode: true },
  });
  const sessionId = (await events(first)).find((e) => e.event === 'session')!.data.sessionId as string;

  const finish = await request.post('/api/design-session/continue', {
    data: { sessionId, mode: 'auto' },
  });
  expect(finish.ok()).toBe(true);
  const finishEvents = await events(finish);

  // No 'paused' event anywhere in an auto continuation -- it must run
  // straight through to a real completion (done or gracefully exhausted).
  expect(finishEvents.find((e) => e.event === 'paused')).toBeUndefined();
  const doneEvent = finishEvents.find((e) => e.event === 'done');
  expect(doneEvent).toBeTruthy();
  expect(['isFinalStep', 'max_steps_reached', 'step_exhausted']).toContain(doneEvent!.data.reason);
});

test('continuing an unknown sessionId fails with a real, specific error, not a crash', async ({ request }) => {
  const response = await request.post('/api/design-session/continue', {
    data: { sessionId: 'not-a-real-session-id', mode: 'step' },
  });
  expect(response.status()).toBe(404);
  const [errorEvent] = await events(response);
  expect(errorEvent.event).toBe('error');
  expect(errorEvent.data.message).toContain('not found');
});

test('continuing an already-finished session returns done immediately instead of erroring or restarting', async ({ request }) => {
  test.setTimeout(150_000);
  const first = await request.post('/api/design-session', {
    data: { description: 'A URL shortener that needs to handle 2000 requests per second', provider: 'gemini', stepMode: false },
  });
  const firstEvents = await events(first);
  const sessionId = firstEvents.find((e) => e.event === 'session')!.data.sessionId as string;
  expect(firstEvents.find((e) => e.event === 'done')).toBeTruthy();

  const again = await request.post('/api/design-session/continue', { data: { sessionId, mode: 'step' } });
  expect(again.ok()).toBe(true);
  const [onlyEvent] = await events(again);
  expect(onlyEvent.event).toBe('done');
});
