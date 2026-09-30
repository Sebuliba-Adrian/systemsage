'use client';

import type { RequestTrace, SimNode } from '@systemsage/engine';

/*
 * The one real request a step's simulate() call actually traced, hop by
 * hop -- the thing an aggregate percentile can't tell you. `queuedMs`
 * (waiting for a free slot) and `serviceMs` (the work itself, once a slot
 * was held) are rendered as two differently-colored segments of the same
 * bar specifically so they're visually comparable: a bar that's mostly
 * amber is a capacity problem, one that's mostly blue is a genuinely slow
 * component -- two different fixes, and no p99 number alone can tell you
 * which one you have.
 */

const BAR_MAX_WIDTH = 240;

export function TraceView({ trace, nodes }: { trace: RequestTrace | null; nodes: SimNode[] }) {
  if (!trace) {
    return (
      <p data-testid="trace-empty" style={{ fontSize: 12, color: '#8b96b3', marginTop: 12 }}>
        No completed request to trace yet.
      </p>
    );
  }

  const labelFor = (nodeId: string) => nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const maxHopTotal = Math.max(1, ...trace.hops.map((h) => h.queuedMs + h.serviceMs));

  return (
    <div data-testid="trace-view" style={{ marginTop: 12 }}>
      <p style={{ fontSize: 12, color: '#8b96b3', margin: '0 0 8px' }}>
        Traced request: {trace.ok ? 'succeeded' : `failed (${trace.reason})`} in{' '}
        <span data-testid="trace-total-ms">{trace.totalMs.toFixed(1)}</span>ms real, end to end --{' '}
        <span style={{ color: '#f5a623' }}>queued</span> vs <span style={{ color: '#5b8cff' }}>served</span>, per hop:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {trace.hops.map((hop, i) => {
          const total = hop.queuedMs + hop.serviceMs;
          const barWidth = (total / maxHopTotal) * BAR_MAX_WIDTH;
          const queuedWidth = total > 0 ? (hop.queuedMs / total) * barWidth : 0;
          const serviceWidth = barWidth - queuedWidth;
          return (
            <div key={`${hop.nodeId}-${i}`} data-testid="trace-hop" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 140, color: '#e6e9f0', textAlign: 'right', flexShrink: 0 }}>{labelFor(hop.nodeId)}</span>
              <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', background: '#111726' }}>
                {queuedWidth > 0 && (
                  <div data-testid="trace-hop-queued" style={{ width: queuedWidth, background: '#f5a623' }} />
                )}
                {serviceWidth > 0 && (
                  <div data-testid="trace-hop-service" style={{ width: serviceWidth, background: '#5b8cff' }} />
                )}
              </div>
              <span style={{ color: '#8b96b3', flexShrink: 0 }}>
                queued {hop.queuedMs.toFixed(1)}ms / served {hop.serviceMs.toFixed(1)}ms
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
