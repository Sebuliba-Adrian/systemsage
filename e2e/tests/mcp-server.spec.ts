import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

/*
 * A real, automated MCP client driving the real MCP server as a real
 * subprocess, over the real stdio JSON-RPC protocol -- the same mechanism
 * Claude Code or Codex uses when connected to it, just scripted instead of
 * interactive. This is what actually proves "it perfectly works with an
 * external agent as the driver": not a unit test calling applyStep
 * directly, but a genuine two-process MCP round trip, start to finish.
 *
 * The agent logic here (which node to add, when to stop) is intentionally
 * simple and scripted rather than another LLM call -- this test is about
 * proving the SERVER's contract holds for any correctly-behaving client,
 * not about re-testing planning quality (that's lesson-planner's job, and
 * the comparison harness's).
 */

// __dirname is a real global under Playwright's CJS test transform -- no
// import.meta trick needed (and import.meta.url fails under that transform).
const CLI_PATH = path.join(__dirname, '..', '..', 'packages', 'mcp-server', 'src', 'cli.ts');
// tsx's bin lives under the mcp-server package's own node_modules -- pnpm's
// workspace linking does not hoist it to the repo root node_modules/.bin.
const TSX_PATH = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  'mcp-server',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({ command: TSX_PATH, args: [CLI_PATH] });
  const client = new Client({ name: 'systemsage-e2e-test-client', version: '0.1.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

test('a real MCP client can list both tools', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['propose_step', 'read_design_format']);
  } finally {
    await close();
  }
});

test('read_design_format returns the real palette, generated from the real engine', async () => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'read_design_format', arguments: {} });
    const text = textOf(result as never);
    // Spot-check real component kinds that only exist if this came from
    // the actual NODE_KINDS list, not a hand-written stub.
    expect(text).toContain('`client`:');
    expect(text).toContain('`cache`:');
    expect(text).toContain('`ratelimiter`:');
    expect(text).toContain('removeEdges');
  } finally {
    await close();
  }
});

test('propose_step rejects an invalid step with a real, specific error over the wire', async () => {
  const { client, close } = await connect();
  try {
    const result = await client.callTool({
      name: 'propose_step',
      arguments: {
        currentTopology: { nodes: [], edges: [] },
        stepTitle: 'Bad step',
        narration: 'x',
        addNodes: [],
        addEdges: [],
        removeEdges: [{ from: 'nope', to: 'also-nope' }],
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result as never)).toContain('Tried to remove a nonexistent edge');
  } finally {
    await close();
  }
});

test('a full two-step session over the real protocol: simplest design, then insert a cache correctly', async () => {
  const { client, close } = await connect();
  try {
    // Step 1: the simplest possible design.
    const step1 = await client.callTool({
      name: 'propose_step',
      arguments: {
        currentTopology: { nodes: [], edges: [] },
        stepTitle: 'The Simplest Setup',
        narration: 'One client, one service, one database.',
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
        seed: 1,
        simulatedSeconds: 10,
      },
    });
    expect((step1 as { isError?: boolean }).isError).toBeFalsy();
    const step1Text = textOf(step1 as never);
    expect(step1Text).toMatch(/p50=\d/);
    const topologyJson = step1Text.slice(step1Text.indexOf('{'));
    const topology = JSON.parse(topologyJson);
    expect(topology.nodes).toHaveLength(3);

    // Step 2: insert a cache correctly -- this is the exact pattern that
    // was buggy before removeEdges existed. A real external client driving
    // this server for real must be able to do this correctly using only
    // what read_design_format told it.
    const step2 = await client.callTool({
      name: 'propose_step',
      arguments: {
        currentTopology: topology,
        stepTitle: 'Add a Cache',
        narration: 'Routing reads through a cache before the database.',
        addNodes: [{ id: 'cache-1', kind: 'cache', label: 'Cache' }],
        addEdges: [
          { from: 'service-1', to: 'cache-1' },
          { from: 'cache-1', to: 'db-1' },
        ],
        removeEdges: [{ from: 'service-1', to: 'db-1' }],
        seed: 1,
        simulatedSeconds: 10,
      },
    });
    expect((step2 as { isError?: boolean }).isError).toBeFalsy();
    const step2Text = textOf(step2 as never);
    const step2Topology = JSON.parse(step2Text.slice(step2Text.indexOf('{')));
    const pairs = step2Topology.edges.map((e: { from: string; to: string }) => `${e.from}->${e.to}`);
    expect(pairs).not.toContain('service-1->db-1');
    expect(pairs).toContain('service-1->cache-1');
    expect(pairs).toContain('cache-1->db-1');
  } finally {
    await close();
  }
});
