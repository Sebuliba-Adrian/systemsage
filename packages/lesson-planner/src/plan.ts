import { generateObject, NoObjectGeneratedError } from 'ai';
import { applyStep, buildDesignFormatGuide, simulate, type SystemStats, type Topology } from '@systemsage/engine';
import { LessonStepSchema, type LessonStep } from './schema';
import { createModel, type ProviderId } from './providers';

const MAX_ATTEMPTS = 3;
const DEFAULT_PROVIDER: ProviderId = 'gemini';
const DEFAULT_SEED = 1;
const DEFAULT_SIMULATED_SECONDS = 30;

/**
 * The ceiling a step's own MEASURED error rate must clear before
 * isFinalStep=true is accepted. This exists because asking nicely in the
 * prompt was proven, live, not to be enough: a real Gemini session set a
 * client's rps to match its own correct capacity estimate, never sized
 * the components on that load's path, and still declared "Design
 * complete" at a 99.39% measured error rate -- the prompt said not to,
 * and it did anyway. Every other integrity check in this codebase
 * (removeEdges, GraphCycleError, isTopology) is enforced in code, not
 * requested in prose; this one was the odd one out until now.
 */
const FINAL_STEP_MAX_ERROR_RATE = 0.05;

const SYSTEM_PROMPT = `You are a system design tutor. A learner describes a system they want
to build, and you teach it by building ONE component (or a small tightly
related group) at a time, on a real simulated canvas, narrating why each
piece is being added before you add the next.

Rules:
- Never skip straight to the finished architecture. The first step is
  always the simplest thing that could possibly work: a client, one
  service, one database. Every later step adds exactly one real idea
  (a cache, a load balancer, a queue, a read replica) and explains the
  specific problem it fixes, not just what it is.
- If the learner's brief gives concrete scale numbers (users, requests
  per day, data volume, a latency target), open your FIRST step's
  narration with a quick, real capacity estimate before any design
  decision -- the way an engineer talks out loud before touching a
  whiteboard: "300M users checking 15x/day is ~52K requests/sec on
  average, more like 150K at peak" is one sentence, not an essay. Skip
  this entirely if the brief gave no numbers to work from -- never
  invent scale that wasn't stated.
- An estimate you don't act on is decoration, not engineering. If you set
  a client's rps to match the load you just estimated, the components on
  its path need capacity/instances raised to plausibly carry that load --
  don't leave a bottleneck at its tiny default (capacity=6, instances=1,
  etc.) while claiming the design targets tens of thousands of rps. A
  design that fails almost all of its own simulated traffic is not a
  scaling milestone, it's an unsized one.
- Reference the PREVIOUS step's measured stats when you have them
  (p50/p95/p99 latency, error rate, goodput) to justify why the NEXT
  component is needed -- "latency is climbing because ..." beats "next,
  let's add a cache."
- Node ids must be unique across the whole design so far.
- Set isFinalStep=true only once the design actually answers the
  learner's brief; don't pad with unnecessary steps. But never set it
  while the step's own just-measured error rate would still be above 5%
  -- this is checked for real after you respond, not just requested here,
  so a design that fails most of the load it claims to handle will be
  rejected and handed back to you with the real numbers, no matter what
  the narration says about itself. Likewise, a brief implying real global
  scale (hundreds of millions of users, or explicit multi-region
  language) that still has no geographic distribution story, or that
  never resolved a skewed fan-out / hot-key problem it created, is not
  actually finished either.
- Your FINAL step's narration (isFinalStep=true) should end with one
  honest sentence naming the most significant thing you deliberately left
  out of scope, if anything real remains -- name the gap instead of
  implying the design is airtight.

${buildDesignFormatGuide()}`;

export interface PlanContext {
  description: string;
  priorSteps: LessonStep[];
  currentTopology: Topology;
}

export interface PlannedStep {
  step: LessonStep;
  topology: Topology;
  /**
   * The real simulate() result for this step's topology -- computed once,
   * here, both to enforce FINAL_STEP_MAX_ERROR_RATE and to hand back to
   * the caller, so a route displaying these stats never has to re-run the
   * simulation (and can never silently drift from what was actually
   * checked).
   */
  stats: SystemStats;
  /** How many tries this step took. 1 means it succeeded first try -- no retry needed. */
  attempts: number;
  /** One entry per FAILED attempt (so length is attempts-1), the real reason each one was rejected. */
  retryReasons: string[];
}

/**
 * The seam attemptStep calls instead of talking to `generateObject`
 * directly. Default implementation is the real Gemini call; tests inject a
 * scripted one, the same "swappable seam" pattern used throughout the
 * book series this project comes out of (ModelClient, FakeJobQueue, a
 * scripted model double) rather than mocking the SDK's internals.
 */
export type StepGenerator = (args: { system: string; prompt: string }) => Promise<{ object: LessonStep }>;

/**
 * Builds a real StepGenerator for a given provider. Every provider runs
 * through this identical generateObject + LessonStepSchema call -- the
 * model is the only variable -- which is what makes a quality comparison
 * across providers (or against the MCP path) a fair one instead of an
 * apples-to-oranges one. See providers.ts for what's real vs. stubbed.
 */
export function createProviderGenerator(providerId: ProviderId): StepGenerator {
  return async (args) =>
    generateObject({
      model: createModel(providerId),
      schema: LessonStepSchema,
      system: args.system,
      prompt: args.prompt,
    });
}

const defaultGenerate = createProviderGenerator(DEFAULT_PROVIDER);

/**
 * A step attempt that failed in a way worth retrying: the model's schema
 * validation failed, or applyStep rejected the merged result. `feedback`
 * is written to go straight into the retry prompt, so it has to say
 * specifically what was wrong, not just that something was.
 */
class StepAttemptError extends Error {
  constructor(
    message: string,
    readonly feedback: string,
  ) {
    super(message);
    this.name = 'StepAttemptError';
  }
}

/**
 * Thrown when every attempt failed. Exported (not just an internal Error)
 * specifically so a caller like the SSE route can tell "this step
 * genuinely exhausted MAX_ATTEMPTS" apart from an unexpected failure
 * (network error, missing key) and degrade gracefully instead of
 * surfacing a raw exception -- a real, live failure mode a stress test
 * against a real, more failure-prone provider actually produced (see
 * ARCHITECTURE.md), not a hypothetical worth guarding against blindly.
 */
export class StepExhaustedError extends Error {
  constructor(
    message: string,
    readonly retryReasons: string[],
  ) {
    super(message);
    this.name = 'StepExhaustedError';
  }
}

function buildUserPrompt(ctx: PlanContext, feedback?: string): string {
  const lines = [`Learner's brief: ${ctx.description}`];
  if (ctx.priorSteps.length === 0) {
    lines.push('This is the first step. Start with the simplest possible design.');
  } else {
    lines.push(
      `Steps so far (${ctx.priorSteps.length}): ` +
        ctx.priorSteps.map((s) => s.stepTitle).join(' -> '),
    );
    lines.push(`Current topology: ${JSON.stringify(ctx.currentTopology)}`);
  }
  if (feedback) {
    lines.push(
      `Your previous attempt at this step failed and was thrown away -- the ` +
        `learner never saw it. Read why, then produce a corrected step:\n${feedback}`,
    );
  }
  return lines.join('\n\n');
}

/**
 * One attempt: ask the model for a step, then hand the diff to the
 * engine's own applyStep -- the SAME function the MCP server uses -- to
 * merge, lay out, and validate it. Throws StepAttemptError (with
 * model-facing feedback) for anything a retry could plausibly fix, and
 * lets any other error (network failure, missing API key) propagate
 * immediately -- retrying THOSE would just burn attempts on something no
 * amount of corrective prompting fixes.
 */
interface StepAttemptResult {
  step: LessonStep;
  topology: Topology;
  stats: SystemStats;
}

async function attemptStep(
  ctx: PlanContext,
  feedback: string | undefined,
  generate: StepGenerator,
  simOpts: { seed: number; simulatedSeconds: number },
): Promise<StepAttemptResult> {
  let step: LessonStep;
  try {
    const result = await generate({ system: SYSTEM_PROMPT, prompt: buildUserPrompt(ctx, feedback) });
    step = result.object;
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      // This is the failure mode that used to end the whole session (see
      // the "No object generated: response did not match schema" error
      // found live while testing). err.text is the model's raw, invalid
      // output -- handing it back is what lets the retry actually correct
      // the SPECIFIC mistake instead of guessing what went wrong.
      throw new StepAttemptError(
        `Model output failed schema validation: ${err.message}`,
        `Your output did not match the required schema (${err.message}). ` +
          `What you produced: ${(err.text ?? '').slice(0, 2000)}\n` +
          'Fix the specific field(s) that violated the schema and return valid JSON.',
      );
    }
    throw err;
  }

  const result = applyStep(ctx.currentTopology, step);
  if (!result.ok) {
    throw new StepAttemptError(
      `Planner produced an invalid step "${step.stepTitle}": ${result.errors.join(' ')}`,
      `Your step "${step.stepTitle}" was rejected:\n` +
        result.errors.map((e) => `- ${e}`).join('\n') +
        `\nThe step you produced: ${JSON.stringify(step)}\n` +
        'Fix these specific problems and return a corrected step.',
    );
  }

  const stats = simulate(result.topology, simOpts).stats;

  // The check a system prompt can only ask for, never enforce: a real
  // live session proved a model will set isFinalStep=true at a 99%+
  // measured error rate anyway, despite the prompt saying not to. This is
  // the code-level backstop, in the same shape as every other check
  // above -- reject with the SPECIFIC real numbers, let the retry fix it.
  if (step.isFinalStep && stats.errorRate > FINAL_STEP_MAX_ERROR_RATE) {
    throw new StepAttemptError(
      `Step "${step.stepTitle}" claimed isFinalStep=true at a ${(stats.errorRate * 100).toFixed(1)}% measured error rate`,
      `Your step "${step.stepTitle}" set isFinalStep=true, but the real simulated error rate came back at ` +
        `${(stats.errorRate * 100).toFixed(1)}% -- far above the ${(FINAL_STEP_MAX_ERROR_RATE * 100).toFixed(0)}% ceiling for a ` +
        `"finished" design. A design that fails that much of its own traffic is not finished.\n` +
        `Measured this attempt: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms p99=${stats.p99.toFixed(1)}ms ` +
        `goodput=${stats.goodputRps.toFixed(1)}rps offered=${stats.offeredRps.toFixed(1)}rps errorRate=${(stats.errorRate * 100).toFixed(1)}%.\n` +
        'Either raise capacity/instances on the bottleneck component(s) in THIS SAME step so the measured error ' +
        'rate actually drops below the ceiling, or set isFinalStep=false and address the bottleneck as its own step.',
    );
  }

  return { step, topology: result.topology, stats };
}

/**
 * Ask the model for exactly one next step, retrying with specific
 * corrective feedback when the attempt fails in a recoverable way. A step
 * that still fails validation after MAX_ATTEMPTS is a hard error here, not
 * something that reaches a canvas half-broken -- the exact failure mode
 * PrepCity's free-hand Mermaid had no way to catch before it shipped a
 * `/api/diagram-fix` call to paper over it. The difference from PrepCity's
 * approach: the retry here is the SAME planner correcting a SPECIFIC,
 * named failure, not a second model guessing a fix for unparseable text.
 */
export async function planNextStep(
  ctx: PlanContext,
  deps: { generate?: StepGenerator; provider?: ProviderId; seed?: number; simulatedSeconds?: number } = {},
): Promise<PlannedStep> {
  const generate = deps.generate ?? (deps.provider ? createProviderGenerator(deps.provider) : defaultGenerate);
  const simOpts = {
    seed: deps.seed ?? DEFAULT_SEED,
    simulatedSeconds: deps.simulatedSeconds ?? DEFAULT_SIMULATED_SECONDS,
  };
  let feedback: string | undefined;
  let lastError: StepAttemptError | undefined;
  const retryReasons: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await attemptStep(ctx, feedback, generate, simOpts);
      return { ...result, attempts: attempt, retryReasons };
    } catch (err) {
      if (!(err instanceof StepAttemptError)) throw err;
      lastError = err;
      feedback = err.feedback;
      retryReasons.push(err.message);
    }
  }

  throw new StepExhaustedError(
    `Planner failed ${MAX_ATTEMPTS} attempts in a row. Last failure: ${lastError?.message}`,
    retryReasons,
  );
}
