import { expect, test, type APIResponse } from '@playwright/test';
import { planNextStep, type StepGenerator, type LessonStep } from '@systemsage/lesson-planner';
import type { Topology } from '@systemsage/engine';

/*
 * The scrutiny side channel: a paused session can be asked a real,
 * free-text follow-up (answerQuestion, ../../packages/lesson-planner/src/
 * ask.ts), and the answer is handed to every LATER step as context -- the
 * "soft" version of scrutiny described in ask.ts's own doc comment.
 */

const VALID_STEP: LessonStep = {
  stepTitle: 'The Simplest Setup',
  narration: 'Starting simple.',
  addNodes: [{ id: 'client-1', kind: 'client', label: 'Client' }],
  addEdges: [],
  removeEdges: [],
  isFinalStep: false,
};

const EMPTY_TOPOLOGY: Topology = { nodes: [], edges: [] };

test('a question asked at a pause is handed to the NEXT step as real context, not silently dropped', async () => {
  let capturedPrompt = '';
  const scripted: StepGenerator = async ({ prompt }) => {
    capturedPrompt = prompt;
    return { object: VALID_STEP };
  };

  await planNextStep(
    {
      description: 'A URL shortener',
      priorSteps: [],
      currentTopology: EMPTY_TOPOLOGY,
      qaLog: [{ question: 'What about celebrity accounts?', answer: 'We would need a hybrid fan-out.' }],
    },
    { generate: scripted },
  );

  expect(capturedPrompt).toContain('What about celebrity accounts?');
  expect(capturedPrompt).toContain('We would need a hybrid fan-out.');
});

test('no qaLog means no question section in the prompt at all -- nothing invented', async () => {
  let capturedPrompt = '';
  const scripted: StepGenerator = async ({ prompt }) => {
    capturedPrompt = prompt;
    return { object: VALID_STEP };
  };

  await planNextStep(
    { description: 'A URL shortener', priorSteps: [], currentTopology: EMPTY_TOPOLOGY },
    { generate: scripted },
  );

  expect(capturedPrompt).not.toContain('interviewer paused');
});

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

test('asking a real question against a real paused session returns a real, grounded answer', async ({ request }) => {
  const first = await request.post('/api/design-session', {
    data: { description: 'A URL shortener that needs to handle 2000 requests per second', provider: 'gemini', stepMode: true },
  });
  const sessionId = (await events(first)).find((e) => e.event === 'session')!.data.sessionId as string;

  const ask = await request.post('/api/design-session/ask', {
    data: { sessionId, question: 'What is the current p99 latency, and why is it high?' },
  });
  expect(ask.ok()).toBe(true);
  const { answer } = (await ask.json()) as { answer: string };
  expect(typeof answer).toBe('string');
  expect(answer.length).toBeGreaterThan(20);
});

test('asking against an unknown session fails with a real 404, not a crash', async ({ request }) => {
  const ask = await request.post('/api/design-session/ask', {
    data: { sessionId: 'not-a-real-session', question: 'Anything?' },
  });
  expect(ask.status()).toBe(404);
  const body = (await ask.json()) as { message: string };
  expect(body.message).toContain('not found');
});

test('asking a session that is not paused (already done) is refused, not silently answered against stale state', async ({ request }) => {
  const first = await request.post('/api/design-session', {
    data: { description: 'A URL shortener that needs to handle 2000 requests per second', provider: 'gemini', stepMode: false },
  });
  const sessionId = (await events(first)).find((e) => e.event === 'session')!.data.sessionId as string;

  const ask = await request.post('/api/design-session/ask', {
    data: { sessionId, question: 'Anything?' },
  });
  expect(ask.status()).toBe(409);
});

test('asking a question through the real browser UI renders the real answer, and Continue still works afterward', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');

  await page.getByTestId('step-mode-checkbox').check();
  await page.getByTestId('description-input').fill(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  await page.getByTestId('design-button').click();

  await expect(page.getByTestId('paused-controls')).toBeVisible({ timeout: 45_000 });

  await page.getByTestId('ask-question-input').fill('What happens if the database goes down?');
  await page.getByTestId('ask-button').click();

  const entry = page.getByTestId('qa-entry').first();
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry.getByTestId('qa-question')).toContainText('What happens if the database goes down?');
  const answerText = await entry.getByTestId('qa-answer').innerText();
  expect(answerText.length).toBeGreaterThan(20);

  // The pause controls (and the session) must still be usable afterward --
  // asking a question must not consume the step or break continuation.
  await expect(page.getByTestId('paused-controls')).toBeVisible();
  await expect(page.getByTestId('step')).toHaveCount(1);
});
