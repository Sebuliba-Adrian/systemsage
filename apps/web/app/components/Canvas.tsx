'use client';

import type { SimEdge, SimNode } from '@systemsage/engine';

const NODE_WIDTH = 140;
const NODE_HEIGHT = 56;

export function Canvas({ nodes, edges }: { nodes: SimNode[]; edges: SimEdge[] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const maxX = Math.max(0, ...nodes.map((n) => n.x)) + NODE_WIDTH + 20;
  const maxY = Math.max(0, ...nodes.map((n) => n.y)) + NODE_HEIGHT + 20;

  return (
    <svg
      data-testid="canvas"
      width={maxX}
      height={maxY}
      viewBox={`0 0 ${maxX} ${maxY}`}
      style={{ background: '#111726', borderRadius: 8 }}
    >
      {edges.map((e) => {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (!from || !to) return null;
        const x1 = from.x + NODE_WIDTH / 2;
        const y1 = from.y + NODE_HEIGHT / 2;
        const x2 = to.x + NODE_WIDTH / 2;
        const y2 = to.y + NODE_HEIGHT / 2;
        return <line key={e.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4b5673" strokeWidth={2} />;
      })}
      {nodes.map((n) => (
        <g key={n.id} data-testid={`node-${n.id}`} data-kind={n.kind}>
          <rect
            x={n.x}
            y={n.y}
            width={NODE_WIDTH}
            height={NODE_HEIGHT}
            rx={8}
            fill="#1b2436"
            stroke="#5b8cff"
            strokeWidth={1.5}
          />
          <text x={n.x + NODE_WIDTH / 2} y={n.y + 24} textAnchor="middle" fontSize={13} fill="#e6e9f0">
            {n.label}
          </text>
          <text x={n.x + NODE_WIDTH / 2} y={n.y + 40} textAnchor="middle" fontSize={10} fill="#8b96b3">
            {n.kind}
          </text>
        </g>
      ))}
    </svg>
  );
}
