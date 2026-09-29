import { generateObject, NoObjectGeneratedError } from 'ai';
import { applyStep, buildDesignFormatGuide, type Topology } from '@systemsage/engine';
import { LessonStepSchema, type LessonStep } from './schema';
import { createModel, type ProviderId } from './providers';

const MAX_ATTEMPTS = 3;
const DEFAULT_PROVIDER: ProviderId = 'gemini';

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
- Reference the PREVIOUS step's measured stats when you have them
  (p50/p95 latency, error rate, goodput) to justify why the NEXT
  component is needed -- "latency is climbing because ..." beats "next,
  let's add a cache."
- Node ids must be unique across the whole design so far.
- Set isFinalStep=true only once the design actually answers the
  learner's brief; don't pad with unnecessary steps.

${buildDesignFormatGuide()}`;

export interface PlanContext {
  description: string;
  priorSteps: LessonStep[];
  currentTopology: Topology;
}

export interface PlannedStep {
  step: LessonStep;
  topology: Topology;
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
async function attemptStep(
  ctx: PlanContext,
  feedback: string | undefined,
  generate: StepGenerator,
): Promise<PlannedStep> {
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

  return { step, topology: result.topology };
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
  deps: { generate?: StepGenerator; provider?: ProviderId } = {},
): Promise<PlannedStep> {
  const generate = deps.generate ?? (deps.provider ? createProviderGenerator(deps.provider) : defaultGenerate);
  let feedback: string | undefined;
  let lastError: StepAttemptError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptStep(ctx, feedback, generate);
    } catch (err) {
      if (!(err instanceof StepAttemptError)) throw err;
      lastError = err;
      feedback = err.feedback;
    }
  }

  throw new Error(
    `Planner failed ${MAX_ATTEMPTS} attempts in a row. Last failure: ${lastError?.message}`,
  );
}
