/*
 * The shared instructional content BOTH drivers of this project read: the
 * hosted Gemini planner (packages/lesson-planner) embeds this in its
 * system prompt, and the MCP server (packages/mcp-server) returns it
 * verbatim from a `read_design_format` tool for Claude Code, Codex, or
 * any other MCP-speaking agent to read once per session. One shared text,
 * generated from the engine's own NODE_KINDS + defaultConfig the same way
 * Breakscale's own mcp/src/readme.ts is generated rather than
 * hand-maintained, so a component the engine gains shows up here
 * automatically -- and so neither driver can silently end up reading
 * different rules than the other.
 */
import { NODE_KINDS } from './topology-schema';
import { defaultConfig } from './sim/presets';

const COMMON_FIELDS = [
  'capacity',
  'serviceMs',
  'queueLimit',
  'instances',
  'serviceCv',
  'timeoutMs',
  'retries',
  'errorRate',
  'hitRate',
  'rps',
] as const;

export function buildPaletteReference(): string {
  const lines: string[] = [
    'Each component kind below is followed by its default config. When you',
    'add a node, only include config fields you want to CHANGE from the',
    'default; everything else is filled in automatically.',
    '',
  ];
  for (const kind of NODE_KINDS) {
    const cfg = defaultConfig(kind) as unknown as Record<string, unknown>;
    const shown = COMMON_FIELDS.filter((f) => cfg[f] !== undefined)
      .map((f) => `${f}=${JSON.stringify(cfg[f])}`)
      .join(' ');
    lines.push(`- \`${kind}\`: ${shown}`);
  }
  return lines.join('\n');
}

/**
 * The full shared guide: how a step is shaped, the insertion/removeEdges
 * rule (with the cache-in-front-of-a-database worked example -- see
 * ARCHITECTURE.md for the real bug this rule exists to prevent), and the
 * component palette. Agent-framing-agnostic on purpose: it says what the
 * rules ARE, not "you are a tutor" or "call this tool" -- each driver adds
 * that part itself, since it differs between a Gemini system prompt and an
 * MCP tool description.
 */
export function buildDesignFormatGuide(): string {
  return `## Step shape

A step is: { stepTitle, narration, addNodes, addEdges, removeEdges, isFinalStep }.

- addNodes: new components. Each needs a unique id (lowercase, kebab-case),
  a kind from the palette below, a label, and optional config overrides.
- addEdges: new connections, { from, to }, referencing existing ids or ids
  you're adding in this same step.
- removeEdges: connections to delete from the topology as it exists right
  now, before addEdges is applied. Only { from, to } pairs that currently
  exist are valid.

## Inserting a component into an existing path (IMPORTANT)

When you add a component that should sit BETWEEN two nodes that are
already directly connected -- a cache in front of a database, a load
balancer in front of a service, a rate limiter in front of an API -- you
MUST remove the old direct edge and re-wire through the new node.
Forgetting this is a real, common mistake: the new component gets added
but traffic keeps flowing around it on the old edge, so nothing about the
measured stats actually changes, and the step's own narration becomes
false.

Example -- inserting a cache between "service-1" and "db-1", which are
currently connected directly by an edge:
- removeEdges: [{ "from": "service-1", "to": "db-1" }]
- addNodes: [{ "id": "cache-1", "kind": "cache", ... }]
- addEdges: [{ "from": "service-1", "to": "cache-1" }, { "from": "cache-1", "to": "db-1" }]

A cache node answers a hit immediately and only forwards a MISS to
whatever it is wired to next -- so cache-1 must be the thing standing
between service-1 and db-1, not a side branch both of them still reach
directly.

## Component palette
${buildPaletteReference()}`;
}
