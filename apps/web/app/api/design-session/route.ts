import { planNextStep, type LessonStep } from '@systemsage/lesson-planner';
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
 *   step   { index, stepTitle, narration, topology, stats, seed }
 *   done   { totalSteps }
 *   error  { message }
 */

export const runtime = 'nodejs';

const MAX_STEPS = 8;
const SIMULATED_SECONDS = 30;
const SEED = 1;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { description?: string };
  const description = (body.description ?? '').trim();

  if (!description) {
    return new Response(sseFrame('error', { message: 'description is required' }), {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseFrame(event, data)));

      let topology: Topology = { nodes: [], edges: [] };
      const priorSteps: LessonStep[] = [];

      try {
        for (let index = 0; index < MAX_STEPS; index++) {
          const planned = await planNextStep({ description, priorSteps, currentTopology: topology });
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
          });

          if (planned.step.isFinalStep) break;
        }
        send('done', { totalSteps: priorSteps.length });
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
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
