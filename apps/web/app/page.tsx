'use client';

import { useState } from 'react';
import type { SimEdge, SimNode, SystemStats } from '@systemsage/engine';
import { Canvas } from './components/Canvas';
import { readSse } from './lib/readSse';

interface StepEvent {
  index: number;
  stepTitle: string;
  narration: string;
  topology: { nodes: SimNode[]; edges: SimEdge[] };
  stats: SystemStats;
  seed: number;
}

export default function Page() {
  const [description, setDescription] = useState(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSteps([]);
    setErrorMessage(null);
    setStatus('running');

    try {
      const response = await fetch('/api/design-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });

      await readSse(response, (event, data) => {
        if (event === 'step') {
          setSteps((prev) => [...prev, data as StepEvent]);
        } else if (event === 'error') {
          setErrorMessage((data as { message: string }).message);
          setStatus('error');
        } else if (event === 'done') {
          setStatus('done');
        }
      });

      setStatus((current) => (current === 'error' ? current : 'done'));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 32 }}>
      <h1>SystemSage</h1>
      <p style={{ color: '#8b96b3' }}>
        Describe a system. Watch it get built, one real measured step at a time.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 12, marginBottom: 32 }}>
        <textarea
          data-testid="description-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          style={{ flex: 1, background: '#1b2436', color: '#e6e9f0', border: '1px solid #2c3550', borderRadius: 8, padding: 10 }}
        />
        <button
          data-testid="design-button"
          type="submit"
          disabled={status === 'running'}
          style={{ padding: '0 20px', borderRadius: 8, border: 'none', background: '#5b8cff', color: 'white', cursor: 'pointer' }}
        >
          {status === 'running' ? 'Designing…' : 'Design it'}
        </button>
      </form>

      {errorMessage && <p data-testid="error-message" style={{ color: '#ff6b6b' }}>{errorMessage}</p>}

      <div data-testid="step-list" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {steps.map((step) => (
          <section key={step.index} data-testid="step" style={{ border: '1px solid #2c3550', borderRadius: 12, padding: 16 }}>
            <h3>
              Step {step.index + 1}: {step.stepTitle}
            </h3>
            <p data-testid="narration">{step.narration}</p>
            <Canvas nodes={step.topology.nodes} edges={step.topology.edges} />
            <dl data-testid="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '4px 16px', marginTop: 12 }}>
              <dt>p50</dt>
              <dd data-testid="stat-p50">{step.stats.p50.toFixed(1)} ms</dd>
              <dt>p95</dt>
              <dd data-testid="stat-p95">{step.stats.p95.toFixed(1)} ms</dd>
              <dt>goodput</dt>
              <dd data-testid="stat-goodput">{step.stats.goodputRps.toFixed(1)} rps</dd>
              <dt>error rate</dt>
              <dd data-testid="stat-error-rate">{(step.stats.errorRate * 100).toFixed(2)}%</dd>
            </dl>
          </section>
        ))}
      </div>

      {status === 'done' && steps.length > 0 && <p data-testid="session-done">Design complete.</p>}
    </main>
  );
}
