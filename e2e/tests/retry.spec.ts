import { test, expect } from '@playwright/test';
import { NoObjectGeneratedError } from 'ai';
import { planNextStep, StepExhaustedError, type StepGenerator, type LessonStep } from '@systemsage/lesson-planner';
import { defaultConfig, type Topology } from '@systemsage/engine';

/*
 * Regression test for the exact bug found live while testing the running
 * app: a step whose model output failed schema validation ended the whole
 * SSE session instead of being retried. This test never calls the real
 * Gemini API -- it scripts the generator seam (see plan.ts's StepGenerator)
 * to fail exactly the way the real model failed, then succeed, and proves
 * planNextStep recovers rather than propagating the first failure.
 */

const VALID_STEP: LessonStep = {
  stepTitle: 'The Simplest Setup',
  narration: 'Starting simple: one client, one service, one database.',
  addNodes: [
    { id: 'client-1', kind: 'client', label: 'Client' },
    { id: 'service-1', kind: 'service', label: 'API' },
    { id: 'db-1', kind: 'db', label: 'DB' },
  ],
  addEdges: [
    { from: 'client-1', to: 'service-1' },
    { from: 'service-1', to: 'db-1' },
  ],
  removeEdges: [],
  isFinalStep: false,
};

const EMPTY_TOPOLOGY: Topology = { nodes: [], edges: [] };

function fakeSchemaFailure(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'Response did not match schema',
    text: '{"stepTitle": "The Simplest Setup", "addNodes": [', // truncated, invalid JSON
    response: { id: 'fake', timestamp: new Date(), modelId: 'fake-model' },
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    finishReason: 'stop',
  });
}

test('a schema-validation failure is retried with specific feedback, not fatal', async () => {
  let calls = 0;
  let feedbackSeenOnRetry: string | undefined;

  const scripted: StepGenerator = async ({ prompt }) => {
    calls += 1;
    if (calls === 1) throw fakeSchemaFailure();
    // Prove the retry actually carries forward what went wrong, not just
    // "try again" -- this is the whole point of the fix.
    feedbackSeenOnRetry = prompt;
    return { object: VALID_STEP };
  };

  const result = await planNextStep(
    { description: 'A URL shortener', priorSteps: [], currentTopology: EMPTY_TOPOLOGY },
    { generate: scripted },
  );

  expect(calls).toBe(2);
  expect(result.step.stepTitle).toBe('The Simplest Setup');
  expect(result.topology.nodes).toHaveLength(3);
  expect(feedbackSeenOnRetry).toContain('did not match the required schema');
  expect(feedbackSeenOnRetry).toContain('stepTitle'); // the raw failed text, echoed back
});

test('a reused node id is retried with the specific id named, not fatal', async () => {
  const existingTopology: Topology = {
    nodes: [{ id: 'client-1', kind: 'client', label: 'Client', x: 0, y: 0, config: defaultConfig('client') }],
    edges: [],
  };

  let calls = 0;
  let feedbackSeenOnRetry: string | undefined;

  const scripted: StepGenerator = async ({ prompt }) => {
    calls += 1;
    if (calls === 1) {
      // Reuses "client-1", which already exists -- a real mistake a model
      // can make when it doesn't track ids carefully across steps.
      return { object: { ...VALID_STEP, addNodes: [{ id: 'client-1', kind: 'service', label: 'Oops' }], addEdges: [] } };
    }
    feedbackSeenOnRetry = prompt;
    return { object: { ...VALID_STEP, addNodes: [{ id: 'service-1', kind: 'service', label: 'API' }], addEdges: [{ from: 'client-1', to: 'service-1' }] } };
  };

  const result = await planNextStep(
    { description: 'A URL shortener', priorSteps: [], currentTopology: existingTopology },
    { generate: scripted },
  );

  expect(calls).toBe(2);
  expect(result.topology.nodes.map((n) => n.id)).toEqual(['client-1', 'service-1']);
  expect(feedbackSeenOnRetry).toContain('Reused an existing node id: "client-1"');
});

test('exhausting all retries fails loudly with the last real reason, not silently', async () => {
  const scripted: StepGenerator = async () => {
    throw fakeSchemaFailure();
  };

  await expect(
    planNextStep(
      { description: 'A URL shortener', priorSteps: [], currentTopology: EMPTY_TOPOLOGY },
      { generate: scripted },
    ),
  ).rejects.toThrow(/failed 3 attempts/);
});

test('exhaustion throws StepExhaustedError specifically, not a plain Error -- this is what lets the SSE route tell "ran out of tries" apart from an unexpected crash and degrade gracefully instead of surfacing a raw exception', async () => {
  // Real failure mode, not hypothetical: a stress test against DeepSeek
  // (see ARCHITECTURE.md) produced this exact class of failure live, mid
  // real session, on a real step.
  const scripted: StepGenerator = async () => {
    throw fakeSchemaFailure();
  };

  let caught: unknown;
  try {
    await planNextStep(
      { description: 'A URL shortener', priorSteps: [], currentTopology: EMPTY_TOPOLOGY },
      { generate: scripted },
    );
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(StepExhaustedError);
  const exhausted = caught as StepExhaustedError;
  expect(exhausted.retryReasons).toHaveLength(3);
  expect(exhausted.retryReasons[0]).toContain('schema validation');
});

/*
 * Regression test for a real live failure: asking nicely in the system
 * prompt was proven NOT enough to stop a model from declaring
 * isFinalStep=true at a 99%+ measured error rate (see ARCHITECTURE.md).
 * This is the code-level backstop -- attemptStep now actually runs the
 * real simulate() and rejects the claim with the real numbers, the same
 * StepAttemptError/retry shape every other check in plan.ts already uses.
 */

function overloadedFinalStep(sized = false): LessonStep {
  const bigConfig = sized ? { capacity: 100000, queueLimit: 100000, serviceCv: 0 } : undefined;
  return {
    stepTitle: 'Everything At Once',
    narration: 'This is definitely finished.',
    addNodes: [
      // capacity=5000 and a generous timeout on the client itself so
      // admission/timeout at the SOURCE is never the bottleneck being
      // tested -- only service/db sizing varies between the overloaded
      // and sized variants below.
      { id: 'client-1', kind: 'client', label: 'Client', config: { rps: 5000, capacity: 5000, timeoutMs: 60000 } },
      { id: 'service-1', kind: 'service', label: 'API', config: bigConfig },
      { id: 'db-1', kind: 'db', label: 'DB', config: bigConfig },
    ],
    addEdges: [
      { from: 'client-1', to: 'service-1' },
      { from: 'service-1', to: 'db-1' },
    ],
    removeEdges: [],
    isFinalStep: true,
  };
}

test('isFinalStep=true at a catastrophic measured error rate is rejected with the real numbers, not accepted', async () => {
  let calls = 0;
  let feedbackSeenOnRetry: string | undefined;

  const scripted: StepGenerator = async ({ prompt }) => {
    calls += 1;
    // Attempt 1: default (tiny) capacity against a 5000rps client -- the
    // exact real shape that fooled the prompt-only version of this check.
    if (calls === 1) return { object: overloadedFinalStep() };
    feedbackSeenOnRetry = prompt;
    // Attempt 2: sized generously enough to actually survive 5000rps.
    return { object: overloadedFinalStep(true) };
  };

  const result = await planNextStep(
    { description: 'A huge system', priorSteps: [], currentTopology: EMPTY_TOPOLOGY },
    { generate: scripted },
  );

  expect(calls).toBe(2);
  expect(result.step.isFinalStep).toBe(true);
  expect(result.stats.errorRate).toBeLessThan(0.05);
  expect(feedbackSeenOnRetry).toContain('but the real simulated error rate came back at');
  expect(feedbackSeenOnRetry).toContain('Measured this attempt: p50=');
});

test('a NON-final step with a high measured error rate is NOT rejected -- an intermediate step is allowed to look broken', async () => {
  // The whole pedagogical point of this tool is watching p95/error rate
  // get WORSE before the next step fixes it. The isFinalStep gate must
  // only fire on the "done" claim, never on an honestly-still-broken
  // intermediate step.
  const scripted: StepGenerator = async () => ({
    object: { ...overloadedFinalStep(), isFinalStep: false },
  });

  const result = await planNextStep(
    { description: 'A huge system', priorSteps: [], currentTopology: EMPTY_TOPOLOGY },
    { generate: scripted },
  );

  expect(result.attempts).toBe(1);
  expect(result.stats.errorRate).toBeGreaterThan(0.5);
});
