'use client';

import { useRef, useState } from 'react';
import {
  applyStep,
  simulate,
  NODE_KINDS,
  type NodeKind,
  type SimNode,
  type SystemStats,
  type Topology,
} from '@systemsage/engine';

/*
 * A fourth driver of the same shared core the LLM-hosted planner and the
 * MCP server already use (see ARCHITECTURE.md): a human, dragging
 * components onto a canvas by hand. Every mutation here goes through the
 * exact same applyStep/simulate functions those two paths call -- so a
 * design built by hand is held to the identical standard (cycle detection,
 * isTopology, the same simulator) as one an LLM proposed. No server round
 * trip: the engine package is pure computation with no Node-only imports,
 * so it runs directly in the browser.
 *
 * Node deletion is deliberately NOT supported: applyStep's StepDiff has no
 * removeNodes, only removeEdges, matching this whole project's
 * add-one-thing-at-a-time philosophy. "Clear canvas" is the escape hatch
 * for starting over, rather than half-building node removal (which would
 * also need to decide what happens to that node's edges) for a first pass.
 */

const NODE_WIDTH = 140;
const NODE_HEIGHT = 56;
const MIN_CANVAS_WIDTH = 760;
const MIN_CANVAS_HEIGHT = 420;

const ACRONYMS: Record<string, string> = { db: 'DB', lb: 'LB', cdn: 'CDN' };

function kindLabel(kind: string): string {
  return ACRONYMS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

type DragState =
  | { type: 'new-node'; kind: NodeKind }
  | { type: 'move-node'; id: string; offsetX: number; offsetY: number }
  | { type: 'connect'; fromId: string; x2: number; y2: number };

const EMPTY_TOPOLOGY: Topology = { nodes: [], edges: [] };

export function InteractiveCanvas() {
  const [topology, setTopology] = useState<Topology>(EMPTY_TOPOLOGY);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const counters = useRef<Record<string, number>>({});

  const byId = new Map(topology.nodes.map((n) => [n.id, n]));

  function nextId(kind: NodeKind): string {
    const n = (counters.current[kind] ?? 0) + 1;
    counters.current[kind] = n;
    return `${kind}-${n}`;
  }

  function toSvgPoint(clientX: number, clientY: number) {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function commitAddNode(kind: NodeKind, x: number, y: number) {
    const id = nextId(kind);
    const result = applyStep(topology, {
      addNodes: [
        {
          id,
          kind,
          label: `${kindLabel(kind)} ${counters.current[kind]}`,
          x: Math.max(0, x),
          y: Math.max(0, y),
        },
      ],
      addEdges: [],
      removeEdges: [],
    });
    if (!result.ok) {
      setError(result.errors.join(' '));
      return;
    }
    setError(null);
    setStats(null);
    setTopology(result.topology);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  }

  function commitAddEdge(from: string, to: string) {
    if (from === to) return;
    if (topology.edges.some((e) => e.from === from && e.to === to)) return;
    const result = applyStep(topology, { addNodes: [], addEdges: [{ from, to }], removeEdges: [] });
    if (!result.ok) {
      // A real cycle wired by hand hits the exact GraphCycleError path the
      // concurrent stress test found live (see ARCHITECTURE.md) -- a human
      // drawing A -> B -> C -> A is caught the same way an LLM's cyclic
      // output is, not a separate check.
      setError(result.errors.join(' '));
      return;
    }
    setError(null);
    setStats(null);
    setTopology(result.topology);
  }

  function commitRemoveEdge(id: string) {
    const edge = topology.edges.find((e) => e.id === id);
    if (!edge) return;
    const result = applyStep(topology, {
      addNodes: [],
      addEdges: [],
      removeEdges: [{ from: edge.from, to: edge.to }],
    });
    if (!result.ok) {
      setError(result.errors.join(' '));
      return;
    }
    setError(null);
    setStats(null);
    setTopology(result.topology);
    setSelectedEdgeId(null);
  }

  function commitMoveNode(id: string, x: number, y: number) {
    setTopology((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, x: Math.max(0, x), y: Math.max(0, y) } : n)),
    }));
  }

  function renameNode(id: string, label: string) {
    setTopology((prev) => ({ ...prev, nodes: prev.nodes.map((n) => (n.id === id ? { ...n, label } : n)) }));
  }

  function runSimulation() {
    if (topology.nodes.length === 0) return;
    setStats(simulate(topology, { seed: 1, simulatedSeconds: 30 }).stats);
  }

  function clearCanvas() {
    setTopology(EMPTY_TOPOLOGY);
    setStats(null);
    setError(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    counters.current = {};
  }

  function onPalettePointerDown(e: React.PointerEvent, kind: NodeKind) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ type: 'new-node', kind });
  }

  function onNodePointerDown(e: React.PointerEvent, node: SimNode) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = toSvgPoint(e.clientX, e.clientY);
    setDrag({ type: 'move-node', id: node.id, offsetX: start.x - node.x, offsetY: start.y - node.y });
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  }

  function onConnectorPointerDown(e: React.PointerEvent, node: SimNode) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toSvgPoint(e.clientX, e.clientY);
    setDrag({ type: 'connect', fromId: node.id, x2: p.x, y2: p.y });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    if (drag.type === 'move-node') {
      const p = toSvgPoint(e.clientX, e.clientY);
      commitMoveNode(drag.id, p.x - drag.offsetX, p.y - drag.offsetY);
    } else if (drag.type === 'connect') {
      const p = toSvgPoint(e.clientX, e.clientY);
      setDrag({ ...drag, x2: p.x, y2: p.y });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!drag) return;
    if (drag.type === 'new-node') {
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const p = toSvgPoint(e.clientX, e.clientY);
        commitAddNode(drag.kind, p.x - NODE_WIDTH / 2, p.y - NODE_HEIGHT / 2);
      }
    } else if (drag.type === 'connect') {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]') as HTMLElement | null;
      const targetId = target?.dataset.nodeId;
      if (targetId && targetId !== drag.fromId) commitAddEdge(drag.fromId, targetId);
    }
    setDrag(null);
  }

  const maxX = Math.max(MIN_CANVAS_WIDTH - 20, ...topology.nodes.map((n) => n.x + NODE_WIDTH)) + 20;
  const maxY = Math.max(MIN_CANVAS_HEIGHT - 20, ...topology.nodes.map((n) => n.y + NODE_HEIGHT)) + 20;
  const selectedNode = selectedNodeId ? byId.get(selectedNodeId) : undefined;

  return (
    <div onPointerMove={onPointerMove} onPointerUp={onPointerUp} style={{ display: 'flex', gap: 16 }}>
      <div data-testid="palette" style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 150, flexShrink: 0 }}>
        <h3 style={{ fontSize: 13, color: '#8b96b3', margin: '0 0 4px' }}>Components</h3>
        <div style={{ maxHeight: MIN_CANVAS_HEIGHT, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {NODE_KINDS.map((kind) => (
            <div
              key={kind}
              data-testid={`palette-item-${kind}`}
              onPointerDown={(e) => onPalettePointerDown(e, kind)}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid #2c3550',
                background: '#1b2436',
                color: '#e6e9f0',
                fontSize: 12,
                cursor: 'grab',
                userSelect: 'none',
                touchAction: 'none',
              }}
            >
              {kindLabel(kind)}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button
            data-testid="run-simulation-button"
            onClick={runSimulation}
            disabled={topology.nodes.length === 0}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#5b8cff', color: 'white', cursor: 'pointer' }}
          >
            Run simulation
          </button>
          <button
            data-testid="clear-canvas-button"
            onClick={clearCanvas}
            disabled={topology.nodes.length === 0}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #2c3550', background: 'transparent', color: '#e6e9f0', cursor: 'pointer' }}
          >
            Clear canvas
          </button>
          {selectedEdgeId && (
            <button
              data-testid="delete-edge-button"
              onClick={() => commitRemoveEdge(selectedEdgeId)}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #5c2c2c', background: 'transparent', color: '#ff6b6b', cursor: 'pointer' }}
            >
              Delete selected edge
            </button>
          )}
        </div>

        {error && (
          <p data-testid="build-error" style={{ color: '#ff6b6b', fontSize: 13 }}>
            {error}
          </p>
        )}

        <svg
          ref={svgRef}
          data-testid="build-canvas"
          width={maxX}
          height={maxY}
          viewBox={`0 0 ${maxX} ${maxY}`}
          onPointerDown={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
          style={{ background: '#111726', borderRadius: 8, touchAction: 'none' }}
        >
          {topology.nodes.length === 0 && (
            <text x={maxX / 2} y={maxY / 2} textAnchor="middle" fontSize={13} fill="#4b5673">
              Drag a component here to start
            </text>
          )}

          {topology.edges.map((e) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const selected = e.id === selectedEdgeId;
            return (
              <line
                key={e.id}
                data-testid={`edge-${e.id}`}
                x1={from.x + NODE_WIDTH / 2}
                y1={from.y + NODE_HEIGHT / 2}
                x2={to.x + NODE_WIDTH / 2}
                y2={to.y + NODE_HEIGHT / 2}
                stroke={selected ? '#ff6b6b' : '#4b5673'}
                strokeWidth={selected ? 3 : 2}
                onPointerDown={(evt) => {
                  evt.stopPropagation();
                  setSelectedEdgeId(e.id);
                  setSelectedNodeId(null);
                }}
                style={{ cursor: 'pointer' }}
              />
            );
          })}

          {drag?.type === 'connect' &&
            byId.get(drag.fromId) &&
            (() => {
              const from = byId.get(drag.fromId)!;
              return (
                <line
                  data-testid="connect-preview"
                  x1={from.x + NODE_WIDTH}
                  y1={from.y + NODE_HEIGHT / 2}
                  x2={drag.x2}
                  y2={drag.y2}
                  stroke="#7ee787"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              );
            })()}

          {topology.nodes.map((n) => (
            <g
              key={n.id}
              data-testid={`node-${n.id}`}
              data-kind={n.kind}
              data-node-id={n.id}
              onPointerDown={(e) => onNodePointerDown(e, n)}
              style={{ cursor: 'grab' }}
            >
              <rect
                x={n.x}
                y={n.y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={8}
                fill="#1b2436"
                stroke={n.id === selectedNodeId ? '#7ee787' : '#5b8cff'}
                strokeWidth={n.id === selectedNodeId ? 2.5 : 1.5}
              />
              <text x={n.x + NODE_WIDTH / 2} y={n.y + 24} textAnchor="middle" fontSize={13} fill="#e6e9f0">
                {n.label}
              </text>
              <text x={n.x + NODE_WIDTH / 2} y={n.y + 40} textAnchor="middle" fontSize={10} fill="#8b96b3">
                {n.kind}
              </text>
              <circle
                data-testid={`connector-${n.id}`}
                cx={n.x + NODE_WIDTH}
                cy={n.y + NODE_HEIGHT / 2}
                r={6}
                fill="#7ee787"
                onPointerDown={(e) => onConnectorPointerDown(e, n)}
                style={{ cursor: 'crosshair' }}
              />
            </g>
          ))}
        </svg>

        {selectedNode && (
          <div data-testid="node-inspector" style={{ marginTop: 12, fontSize: 13 }}>
            <label>
              Label:{' '}
              <input
                data-testid="node-label-input"
                value={selectedNode.label}
                onChange={(e) => renameNode(selectedNode.id, e.target.value)}
                style={{ background: '#1b2436', color: '#e6e9f0', border: '1px solid #2c3550', borderRadius: 6, padding: '4px 8px' }}
              />
            </label>
          </div>
        )}

        {stats && (
          <dl data-testid="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '4px 16px', marginTop: 12 }}>
            <dt>p50</dt>
            <dd data-testid="stat-p50">{stats.p50.toFixed(1)} ms</dd>
            <dt>p95</dt>
            <dd data-testid="stat-p95">{stats.p95.toFixed(1)} ms</dd>
            <dt>goodput</dt>
            <dd data-testid="stat-goodput">{stats.goodputRps.toFixed(1)} rps</dd>
            <dt>error rate</dt>
            <dd data-testid="stat-error-rate">{(stats.errorRate * 100).toFixed(2)}%</dd>
          </dl>
        )}
      </div>
    </div>
  );
}
