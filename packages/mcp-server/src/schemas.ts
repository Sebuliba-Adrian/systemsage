import { z } from 'zod';
import { NODE_KINDS, type NodeKind } from '@systemsage/engine';

if (NODE_KINDS.length === 0) throw new Error('NODE_KINDS is empty');
const KIND_ENUM = z.enum(NODE_KINDS as [NodeKind, ...NodeKind[]]);

/*
 * Loose on purpose for the CURRENT topology the caller hands back each
 * call: a design already produced by a previous propose_step call has
 * already been through isTopology once, so this schema's only job is to
 * get the request through to applyStep, which gives better, more specific
 * errors than a strict schema could -- same reasoning Breakscale's own
 * server.ts gives for its loose `node`/`edge` schemas.
 */
const existingNode = z
  .object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    x: z.number(),
    y: z.number(),
    config: z.record(z.string(), z.union([z.number(), z.string()])),
  })
  .passthrough();

const existingEdge = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    weight: z.number(),
  })
  .passthrough();

export const currentTopologySchema = z
  .object({
    nodes: z.array(existingNode).default([]),
    edges: z.array(existingEdge).default([]),
  })
  .describe('The topology returned by the previous propose_step call, or {nodes:[],edges:[]} for the first step.');

/** A node this step adds -- validated tightly, since this is new input, not a round-trip. */
export const newNodeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'lowercase kebab-case, must not collide with an existing node id'),
  kind: KIND_ENUM,
  label: z.string().min(1),
  config: z.record(z.string(), z.number()).optional(),
});

export const newEdgeSchema = z.object({ from: z.string(), to: z.string() });
export const removeEdgeSchema = z.object({ from: z.string(), to: z.string() });
