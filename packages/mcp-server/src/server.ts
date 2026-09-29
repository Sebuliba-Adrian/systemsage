import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { applyStep, buildDesignFormatGuide, simulate, type Topology } from '@systemsage/engine';
import { currentTopologySchema, newEdgeSchema, newNodeSchema, removeEdgeSchema } from './schemas';

/*
 * The MCP-driven path proposed in ARCHITECTURE.md: Claude Code, Codex, or
 * any other MCP-speaking agent drives the design process itself -- reading
 * this server's own instructions, deciding what to add, calling
 * propose_step -- with NO Gemini call and no cost on our side. It runs
 * through the exact same applyStep/isTopology/simulate core the hosted
 * Gemini planner (packages/lesson-planner) uses, so a design built this way
 * is held to the identical standard, not a looser one.
 */

const READ_DESIGN_FORMAT_INTRO = `SystemSage is a system design tutor: build ONE component (or a small
tightly related group) at a time, on a real simulated canvas, narrating why
each piece is being added before you add the next. You are the tutor --
decide what the learner needs next and call propose_step with it.

Rules:
- Never skip straight to the finished architecture. The first step is
  always the simplest thing that could possibly work: a client, one
  service, one database. Every later step adds exactly one real idea and
  explains the specific problem it fixes.
- Reference the PREVIOUS step's measured stats (returned by propose_step)
  to justify why the NEXT component is needed.
- Keep currentTopology from the previous propose_step's response and pass
  it back unchanged in your next call -- this server holds no session
  state between calls.

`;

export function createServer(): McpServer {
  const server = new McpServer({ name: 'SystemSage', version: '0.1.0' });

  server.registerTool(
    'read_design_format',
    {
      title: 'Read the design format',
      description:
        'Returns the design format propose_step takes: every component kind and its ' +
        'defaults, how a step is shaped, and the removeEdges rule for inserting a ' +
        'component into an existing path. Read this once per session before the first ' +
        'propose_step call.',
      annotations: { title: 'Read the design format', readOnlyHint: true },
    },
    async () => ({
      content: [{ type: 'text' as const, text: READ_DESIGN_FORMAT_INTRO + buildDesignFormatGuide() }],
    }),
  );

  server.registerTool(
    'propose_step',
    {
      title: 'Propose a lesson step',
      description:
        'Validates a step against the current topology, simulates it for real, and ' +
        'returns measured stats (p50/p95/goodput/error rate) plus the updated ' +
        'topology to pass into your next call. A step that fails validation is ' +
        'rejected with specific, actionable errors -- fix them and call again.',
      inputSchema: {
        currentTopology: currentTopologySchema,
        stepTitle: z.string().min(1),
        narration: z.string().min(1).describe('What you, the tutor, say while this step lands'),
        addNodes: z.array(newNodeSchema).default([]),
        addEdges: z.array(newEdgeSchema).default([]),
        removeEdges: z
          .array(removeEdgeSchema)
          .default([])
          .describe('Edges to delete from currentTopology first -- required when inserting into an existing path'),
        simulatedSeconds: z.number().positive().default(30),
        seed: z.number().int().default(1),
      },
      annotations: { title: 'Propose a lesson step', readOnlyHint: true },
    },
    async (args) => {
      // The Zod schema only gets this far enough to be worth checking with
      // isTopology (applyStep's own job) -- config values, for instance,
      // are still an untyped record here. The real structural guarantee is
      // isTopology, not this cast.
      const result = applyStep(args.currentTopology as unknown as Topology, {
        addNodes: args.addNodes,
        addEdges: args.addEdges,
        removeEdges: args.removeEdges,
      });

      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Step "${args.stepTitle}" was rejected:\n` + result.errors.map((e) => `- ${e}`).join('\n'),
            },
          ],
        };
      }

      const sim = simulate(result.topology, { seed: args.seed, simulatedSeconds: args.simulatedSeconds });
      const s = sim.stats;
      const summary =
        `Step "${args.stepTitle}" accepted. Measured over ${args.simulatedSeconds}s (seed ${args.seed}):\n` +
        `  p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms\n` +
        `  goodput=${s.goodputRps.toFixed(1)}rps errorRate=${(s.errorRate * 100).toFixed(2)}%\n` +
        `  totalRequests=${s.totalRequests} totalFailed=${s.totalFailed}\n\n` +
        `Pass this topology back as currentTopology in your next propose_step call:\n` +
        JSON.stringify(result.topology);

      return { content: [{ type: 'text' as const, text: summary }] };
    },
  );

  return server;
}
