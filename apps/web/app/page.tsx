'use client';

import { useState } from 'react';
import Link from 'next/link';
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
  isFinalStep: boolean;
  attempts: number;
  retryReasons: string[];
}

interface DoneEvent {
  totalSteps: number;
  reason: 'isFinalStep' | 'max_steps_reached' | 'step_exhausted';
  lastStepError?: string;
}

const PROVIDERS = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'deepseek', label: 'DeepSeek' },
] as const;

export default function Page() {
  const [description, setDescription] = useState(
    'A URL shortener that needs to handle 2000 requests per second',
  );
  const [provider, setProvider] = useState<'gemini' | 'deepseek'>('gemini');
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [doneInfo, setDoneInfo] = useState<DoneEvent | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSteps([]);
    setDoneInfo(null);
    setErrorMessage(null);
    setStatus('running');

    try {
      const response = await fetch('/api/design-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, provider }),
      });

      await readSse(response, (event, data) => {
        if (event === 'step') {
          setSteps((prev) => [...prev, data as StepEvent]);
        } else if (event === 'error') {
          setErrorMessage((data as { message: string }).message);
          setStatus('error');
        } else if (event === 'done') {
          setDoneInfo(data as DoneEvent);
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
      <p style={{ marginTop: -8, marginBottom: 24 }}>
        <Link href="/build" data-testid="build-link" style={{ color: '#7ee787', fontSize: 13 }}>
          Or build it yourself &rarr;
        </Link>
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 12, marginBottom: 32 }}>
        <textarea
          data-testid="description-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          style={{ flex: 1, background: '#1b2436', color: '#e6e9f0', border: '1px solid #2c3550', borderRadius: 8, padding: 10 }}
        />
        <select
          data-testid="provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value as 'gemini' | 'deepseek')}
          style={{ background: '#1b2436', color: '#e6e9f0', border: '1px solid #2c3550', borderRadius: 8, padding: '0 8px' }}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3>
                Step {step.index + 1}: {step.stepTitle}
              </h3>
              {step.isFinalStep && (
                <span style={{ fontSize: 12, color: '#7ee787', border: '1px solid #2c5c3a', borderRadius: 6, padding: '2px 8px' }}>
                  final step
                </span>
              )}
            </div>
            {step.attempts > 1 && (
              <div
                data-testid="retry-badge"
                style={{ fontSize: 12, color: '#f5a623', border: '1px solid #5c4a1f', borderRadius: 6, padding: '4px 8px', marginBottom: 8 }}
              >
                Retried {step.attempts - 1}x before this step was accepted.
                <ul style={{ margin: '4px 0 0 16px' }}>
                  {step.retryReasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            <p data-testid="narration">{step.narration}</p>
            <Canvas nodes={step.topology.nodes} edges={step.topology.edges} />
            <dl data-testid="stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '4px 16px', marginTop: 12 }}>
              <dt>p50</dt>
              <dd data-testid="stat-p50">{step.stats.p50.toFixed(1)} ms</dd>
              <dt>p95</dt>
              <dd data-testid="stat-p95">{step.stats.p95.toFixed(1)} ms</dd>
              <dt>p99</dt>
              <dd data-testid="stat-p99">{step.stats.p99.toFixed(1)} ms</dd>
              <dt>goodput</dt>
              <dd data-testid="stat-goodput">{step.stats.goodputRps.toFixed(1)} rps</dd>
              <dt>offered</dt>
              <dd data-testid="stat-offered-rps">{step.stats.offeredRps.toFixed(1)} rps</dd>
              <dt>error rate</dt>
              <dd data-testid="stat-error-rate">{(step.stats.errorRate * 100).toFixed(2)}%</dd>
              <dt>requests</dt>
              <dd data-testid="stat-total-requests">{step.stats.totalRequests.toLocaleString()}</dd>
              <dt>failed</dt>
              <dd data-testid="stat-total-failed">{step.stats.totalFailed.toLocaleString()}</dd>
            </dl>
          </section>
        ))}
      </div>

      {status === 'done' && doneInfo && doneInfo.reason !== 'step_exhausted' && (
        <p data-testid="session-done">
          Design complete -- {doneInfo.totalSteps} steps, ended because{' '}
          {doneInfo.reason === 'isFinalStep' ? 'the design was actually finished' : 'the step budget ran out'}.
        </p>
      )}

      {status === 'done' && doneInfo && doneInfo.reason === 'step_exhausted' && (
        <div
          data-testid="session-exhausted"
          style={{ border: '1px solid #5c4a1f', borderRadius: 8, padding: 12, color: '#f5a623' }}
        >
          Stopped after {doneInfo.totalSteps} step{doneInfo.totalSteps === 1 ? '' : 's'} -- the tutor
          couldn&apos;t produce a valid next step after 3 tries with {PROVIDERS.find((p) => p.id === provider)?.label}.
          Everything above is real and kept. Try again, or switch models above and continue.
        </div>
      )}
    </main>
  );
}
