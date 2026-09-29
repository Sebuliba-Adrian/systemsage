/*
 * Vendored from Breakscale (https://github.com/xevrion/breakscale), MIT
 * licensed. Extracted from src/clipboard.ts (NODE_KINDS + isTopology only;
 * clipboard/paste-specific code was left out since this package has no DOM
 * surface). See BREAKSCALE_LICENSE in this package for the original notice.
 *
 * This is the structural ground truth for a design: the same NODE_KINDS
 * list the real engine simulates, and a validator that rejects a malformed
 * design with a real check instead of a model discovering it via a broken
 * render. Anything the lesson planner proposes is checked with isTopology
 * before it is ever run through the engine or shown on a canvas.
 */
import type { NodeKind, Topology } from './sim/types';

/** Every component kind the engine knows how to simulate. */
export const NODE_KINDS: readonly NodeKind[] = [
  'client',
  'lb',
  'service',
  'cache',
  'db',
  'queue',
  'worker',
  'replica',
  'shard',
  'autoscaler',
  'region',
  'cdn',
  'ratelimiter',
  'breaker',
  'objectstore',
  'searchindex',
  'timeseriesdb',
  'graphdb',
  'coldstorage',
  'vectordb',
  'streambroker',
  'pubsub',
  'websocket',
  'apigateway',
  'sidecar',
  'lambda',
  'cron',
  'bulkhead',
  'retryqueue',
  'transcoder',
  'edgecompute',
  'writebehind',
  'loadshedder',
];

/**
 * Structural validation of anything from outside the type system: an LLM's
 * proposed step, a stored session, a pasted payload. Every field the engine
 * will dereference is checked before it is trusted, and a dangling edge
 * (which would make the engine route into nothing) is rejected outright.
 */
export function isTopology(value: unknown): value is Topology {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(t.nodes) || !Array.isArray(t.edges)) return false;

  const ids = new Set<string>();
  for (const raw of t.nodes) {
    if (typeof raw !== 'object' || raw === null) return false;
    const n = raw as Partial<{
      id: unknown;
      kind: unknown;
      label: unknown;
      x: unknown;
      y: unknown;
      config: unknown;
    }>;
    if (typeof n.id !== 'string' || n.id === '') return false;
    if (typeof n.label !== 'string') return false;
    if (!NODE_KINDS.includes(n.kind as NodeKind)) return false;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
    if (typeof n.config !== 'object' || n.config === null) return false;
    const cfg = n.config as Record<string, unknown>;
    for (const key of [
      'capacity',
      'serviceMs',
      'serviceCv',
      'queueLimit',
      'hitRate',
      'errorRate',
      'timeoutMs',
      'retries',
      'rps',
    ]) {
      if (!Number.isFinite(cfg[key])) return false;
    }
    if (ids.has(n.id)) return false;
    ids.add(n.id);
  }

  for (const raw of t.edges) {
    if (typeof raw !== 'object' || raw === null) return false;
    const e = raw as Partial<{
      id: unknown;
      from: unknown;
      to: unknown;
      weight: unknown;
    }>;
    if (typeof e.id !== 'string' || e.id === '') return false;
    if (typeof e.from !== 'string' || typeof e.to !== 'string') return false;
    if (!ids.has(e.from) || !ids.has(e.to)) return false;
    if (!Number.isFinite(e.weight)) return false;
  }

  return true;
}
