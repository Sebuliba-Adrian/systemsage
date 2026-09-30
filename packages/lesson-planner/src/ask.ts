import { generateText } from 'ai';
import type { Topology } from '@systemsage/engine';
import type { LessonStep } from './schema';
import { createModel, type ProviderId } from './providers';

/*
 * The scrutiny side channel: at a paused session, the interviewer can ask
 * a free-text follow-up about the CURRENT design before deciding whether
 * to continue -- "what about the celebrity case?", "why a queue here and
 * not a stream?". This is deliberately NOT another lesson step: no
 * topology change, no schema, no retry budget, no simulate() call of its
 * own -- just the candidate answering, grounded in the real topology and
 * stats it already has.
 *
 * The soft version (deliberately chosen over a hard gate): an answer is
 * appended to the session's qaLog and handed back as context on every
 * later planNextStep call (see plan.ts's buildUserPrompt), so a real
 * question actually shapes what gets built next -- but nothing forces the
 * NEXT step to resolve it, and isFinalStep is never blocked on an
 * unanswered or unresolved question. A hard "every question must be
 * resolved before finishing" rule was considered and deliberately not
 * built: unlike a measured error rate (an objective number `simulate()`
 * already computes), "was this question adequately addressed" has no
 * mechanical check, and forcing one risks becoming brittle busywork
 * instead of genuine scrutiny.
 */

const DEFAULT_PROVIDER: ProviderId = 'gemini';

const ASK_SYSTEM_PROMPT = `You are being interviewed about the system design you have been building, one
step at a time. The interviewer is now asking a follow-up question about
the CURRENT state of the design -- answer as the candidate, in the same
voice as your step narrations.

Rules:
- This is NOT a new design step. Do not propose new components or edges;
  you are answering a question, not changing the topology.
- Ground your answer in the real topology and the real measured stats you
  already have -- reference them specifically, don't invent new numbers.
- If the honest answer is "I have not addressed that yet," say so
  directly and explain how you WOULD address it, rather than implying a
  gap is already solved. A real candidate names their gaps.
- Keep it a focused paragraph or two, the way a candidate actually
  answers a follow-up out loud -- not an essay.`;

export interface QaEntry {
  question: string;
  answer: string;
}

export interface AskContext {
  description: string;
  priorSteps: LessonStep[];
  currentTopology: Topology;
  qaLog: QaEntry[];
}

/**
 * The seam answerQuestion calls instead of talking to `generateText`
 * directly -- same swappable-seam pattern as plan.ts's StepGenerator, so
 * this is testable without a real API call.
 */
export type AskGenerator = (args: { system: string; prompt: string }) => Promise<{ text: string }>;

export function createProviderAskGenerator(providerId: ProviderId): AskGenerator {
  return (args) => generateText({ model: createModel(providerId), system: args.system, prompt: args.prompt });
}

function buildAskPrompt(ctx: AskContext, question: string): string {
  const lines = [
    `Learner's brief: ${ctx.description}`,
    `Steps so far (${ctx.priorSteps.length}): ${ctx.priorSteps.map((s) => s.stepTitle).join(' -> ') || '(none yet)'}`,
    `Current topology: ${JSON.stringify(ctx.currentTopology)}`,
  ];
  if (ctx.qaLog.length > 0) {
    lines.push(
      'Questions already asked and answered during this pause:\n' +
        ctx.qaLog.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n'),
    );
  }
  lines.push(`New question from the interviewer: ${question}`);
  return lines.join('\n\n');
}

export async function answerQuestion(
  ctx: AskContext,
  question: string,
  deps: { generate?: AskGenerator; provider?: ProviderId } = {},
): Promise<string> {
  const generate = deps.generate ?? createProviderAskGenerator(deps.provider ?? DEFAULT_PROVIDER);
  const result = await generate({ system: ASK_SYSTEM_PROMPT, prompt: buildAskPrompt(ctx, question) });
  return result.text;
}
