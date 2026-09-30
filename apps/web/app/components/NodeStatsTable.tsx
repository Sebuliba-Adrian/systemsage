'use client';

import type { NodeStats, SimNode } from '@systemsage/engine';

/*
 * The whole-system `stats` a step narrates is one number for the entire
 * topology; this is per component. Answers "which specific node is the
 * bottleneck, and is it shedding, timing out, or erroring" instead of one
 * flat error rate for everything -- the same SimSnapshot.nodes the engine
 * already computed on every run, previously discarded exactly like the
 * trace was.
 */

function utilizationColor(u: number): string {
  if (u >= 0.9) return '#ff6b6b';
  if (u >= 0.6) return '#f5a623';
  return '#5b8cff';
}

export function NodeStatsTable({ nodes, nodeStats }: { nodes: SimNode[]; nodeStats: Record<string, NodeStats> }) {
  const rows = nodes.filter((n) => nodeStats[n.id]);
  if (rows.length === 0) return null;

  return (
    <div data-testid="per-node-stats-table" style={{ marginTop: 12, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
        <thead>
          <tr style={{ color: '#8b96b3', textAlign: 'left' }}>
            <th style={{ padding: '4px 10px 4px 0' }}>Component</th>
            <th style={{ padding: '4px 10px' }}>Utilization</th>
            <th style={{ padding: '4px 10px' }}>p95</th>
            <th style={{ padding: '4px 10px' }}>Error%</th>
            <th style={{ padding: '4px 10px' }}>Shed/s</th>
            <th style={{ padding: '4px 10px' }}>Timeout/s</th>
            <th style={{ padding: '4px 10px' }}>Throughput</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const s = nodeStats[n.id];
            return (
              <tr key={n.id} data-testid="per-node-stats-row" style={{ borderTop: '1px solid #2c3550' }}>
                <td style={{ padding: '4px 10px 4px 0', color: '#e6e9f0' }}>
                  {n.label} <span style={{ color: '#8b96b3' }}>({n.kind})</span>
                </td>
                <td style={{ padding: '4px 10px', color: utilizationColor(s.utilization) }} data-testid="per-node-stat-utilization">
                  {(s.utilization * 100).toFixed(0)}%
                </td>
                <td style={{ padding: '4px 10px', color: '#e6e9f0' }}>{s.p95.toFixed(1)}ms</td>
                <td style={{ padding: '4px 10px', color: '#e6e9f0' }}>{(s.errorRate * 100).toFixed(1)}%</td>
                <td style={{ padding: '4px 10px', color: '#e6e9f0' }}>{s.shedRate.toFixed(1)}</td>
                <td style={{ padding: '4px 10px', color: '#e6e9f0' }}>{s.timeoutRate.toFixed(1)}</td>
                <td style={{ padding: '4px 10px', color: '#e6e9f0' }}>{s.throughput.toFixed(1)}/s</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
