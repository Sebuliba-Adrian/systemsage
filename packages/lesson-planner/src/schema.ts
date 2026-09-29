import { z } from 'zod';
import { NODE_KINDS, type NodeKind } from '@systemsage/engine';

// z.enum needs a non-empty tuple, not a readonly array; NODE_KINDS.length is
// asserted at module load so a future empty palette fails loudly, not with
// a confusing zod type error three files away.
if (NODE_KINDS.length === 0) throw new Error('NODE_KINDS is empty');
const KIND_ENUM = z.enum(NODE_KINDS as [NodeKind, ...NodeKind[]]);

/** Numeric config overrides a step may set; everything else stays default. */
const ConfigOverrides = z
  .object({
    capacity: z.number().positive().optional(),
    serviceMs: z.number().positive().optional(),
    queueLimit: z.number().positive().optional(),
    instances: z.number().positive().optional(),
    serviceCv: z.number().min(0).optional(),
    timeoutMs: z.number().positive().optional(),
    retries: z.number().min(0).optional(),
    errorRate: z.number().min(0).max(1).optional(),
    hitRate: z.number().min(0).max(1).optional(),
    rps: z.number().positive().optional(),
  })
  .strict();

const NewNode = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'id must be lowercase kebab-case so it is stable across steps')
    .describe('A short, stable id, e.g. "api" or "cache-1". Must not collide with an existing node id.'),
  kind: KIND_ENUM,
  label: z.string().min(1).describe('What the canvas shows, e.g. "Orders API"'),
  config: ConfigOverrides.optional(),
});

const NewEdge = z.object({
  from: z.string().describe('An existing node id or one of this step\'s new node ids'),
  to: z.string().describe('An existing node id or one of this step\'s new node ids'),
});

const RemoveEdge = z.object({
  from: z.string().describe('The "from" of an edge that exists in the CURRENT topology'),
  to: z.string().describe('The "to" of an edge that exists in the CURRENT topology'),
});

/** What the planner LLM must return for exactly one lesson step. */
export const LessonStepSchema = z
  .object({
    stepTitle: z.string().min(1).describe('Short label for this step, e.g. "Add a cache"'),
    narration: z
      .string()
      .min(1)
      .describe(
        'What the tutor says while this step lands, in the second person, ' +
          'explaining WHY this component is being added now, not just what it is.',
      ),
    addNodes: z.array(NewNode),
    addEdges: z.array(NewEdge),
    removeEdges: z
      .array(RemoveEdge)
      .describe(
        'Edges to delete from the CURRENT topology before addEdges is applied. ' +
          'Required whenever you insert a new node between two nodes that were ' +
          'already directly connected (a cache, load balancer, or rate limiter ' +
          'going in front of something) -- otherwise traffic still flows around ' +
          'the new component instead of through it. Empty array if nothing needs removing.',
      ),
    isFinalStep: z
      .boolean()
      .describe('True only when the design is complete and no further step is needed.'),
  })
  .strict();

export type LessonStep = z.infer<typeof LessonStepSchema>;
