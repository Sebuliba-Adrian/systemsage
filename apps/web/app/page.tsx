'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { NodeStats, RequestTrace, SimEdge, SimNode, SystemStats } from '@systemsage/engine';
import { Canvas } from './components/Canvas';
import { TraceView } from './components/TraceView';
import { NodeStatsTable } from './components/NodeStatsTable';
import { readSse } from './lib/readSse';

interface StepEvent {
  index: number;
  stepTitle: string;
  narration: string;
  topology: { nodes: SimNode[]; edges: SimEdge[] };
  stats: SystemStats;
  trace: RequestTrace | null;
  nodeStats: Record<string, NodeStats>;
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

interface SessionEvent {
  sessionId: string;
}

interface QaEntry {
  question: string;
  answer: string;
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
  const [stepMode, setStepMode] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [doneInfo, setDoneInfo] = useState<DoneEvent | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [qaLog, setQaLog] = useState<QaEntry[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [narrateEnabled, setNarrateEnabled] = useState(false);
  const [loadingAudioFor, setLoadingAudioFor] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioCache = useRef<Map<string, string>>(new Map());
  const narratedStepCount = useRef(0);
  const narratedQaCount = useRef(0);

  // Real audio (packages/narrator's Gemini TTS), fetched once per distinct
  // line of text and cached by an object URL -- asking the same question
  // twice, or an auto-narrated step someone also clicks "Play" on, never
  // re-synthesizes. A NotAllowedError specifically means the browser's
  // autoplay policy blocked it (nothing played yet because this call
  // happened outside a direct click), not a real failure -- surfaced as
  // its own message rather than a generic one.
  async function playText(text: string) {
    const audio = audioRef.current;
    if (!audio || !text) return;
    try {
      let url = audioCache.current.get(text);
      if (!url) {
        setLoadingAudioFor(text);
        const response = await fetch('/api/narrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { message?: string };
          throw new Error(data.message ?? 'Narration failed');
        }
        const blob = await response.blob();
        url = URL.createObjectURL(blob);
        audioCache.current.set(text, url);
      }
      audio.src = url;
      await audio.play();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setErrorMessage('Browser blocked autoplay -- click the ▶ button on a step to hear it.');
      } else {
        setErrorMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoadingAudioFor(null);
    }
  }

  // Auto-narrate the newest step or answer, regardless of which action
  // produced it (initial run, "Continue", "Finish automatically", or a new
  // question) -- all of them land in the same `steps`/`qaLog` state.
  useEffect(() => {
    if (narrateEnabled && steps.length > narratedStepCount.current) {
      playText(steps[steps.length - 1].narration);
    }
    narratedStepCount.current = steps.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, narrateEnabled]);

  useEffect(() => {
    if (narrateEnabled && qaLog.length > narratedQaCount.current) {
      playText(qaLog[qaLog.length - 1].answer);
    }
    narratedQaCount.current = qaLog.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qaLog, narrateEnabled]);

  // Shared by the initial POST and every /continue call: read the same SSE
  // event shapes, land in the same state. A step taken via "Continue" or
  // "Finish automatically" is otherwise indistinguishable from one taken
  // by the original auto-run -- same events, same rendering, same stats.
  async function consumeStream(response: Response) {
    await readSse(response, (event, data) => {
      if (event === 'session') {
        setSessionId((data as SessionEvent).sessionId);
      } else if (event === 'step') {
        setSteps((prev) => [...prev, data as StepEvent]);
      } else if (event === 'paused') {
        setStatus('paused');
      } else if (event === 'error') {
        setErrorMessage((data as { message: string }).message);
        setStatus('error');
      } else if (event === 'done') {
        setDoneInfo(data as DoneEvent);
        setStatus('done');
      }
    });
    // 'paused' is a terminal SSE state on its own (the response ends right
    // after it), so only fall back to 'done' when nothing else already
    // set a more specific status.
    setStatus((current) => (current === 'running' ? 'done' : current));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSteps([]);
    setDoneInfo(null);
    setErrorMessage(null);
    setSessionId(null);
    setQaLog([]);
    setStatus('running');

    try {
      const response = await fetch('/api/design-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, provider, stepMode }),
      });
      await consumeStream(response);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  async function handleContinue(mode: 'step' | 'auto') {
    if (!sessionId) return;
    setErrorMessage(null);
    setStatus('running');

    try {
      const response = await fetch('/api/design-session/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, mode }),
      });
      await consumeStream(response);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || !question.trim() || asking) return;
    setAsking(true);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/design-session/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, question }),
      });
      const data = (await response.json()) as { answer?: string; message?: string };
      if (!response.ok) {
        setErrorMessage(data.message ?? 'The question could not be answered.');
      } else {
        setQaLog((prev) => [...prev, { question, answer: data.answer ?? '' }]);
        setQuestion('');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
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

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
        <div style={{ display: 'flex', gap: 12 }}>
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
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#8b96b3' }}>
          <input
            type="checkbox"
            data-testid="step-mode-checkbox"
            checked={stepMode}
            disabled={status === 'running'}
            onChange={(e) => setStepMode(e.target.checked)}
          />
          Step through manually -- pause after every step
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#8b96b3' }}>
          <input
            type="checkbox"
            data-testid="narrate-checkbox"
            checked={narrateEnabled}
            onChange={(e) => setNarrateEnabled(e.target.checked)}
          />
          Narrate automatically (real audio, via Gemini TTS)
        </label>
      </form>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- narration, not video */}
      <audio ref={audioRef} data-testid="narration-audio" style={{ display: 'none' }} />

      {errorMessage && <p data-testid="error-message" style={{ color: '#ff6b6b' }}>{errorMessage}</p>}

      <div data-testid="step-list" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {steps.map((step) => (
          <section key={step.index} data-testid="step" style={{ border: '1px solid #2c3550', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3>
                Step {step.index + 1}: {step.stepTitle}
              </h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  data-testid="play-narration-button"
                  onClick={() => playText(step.narration)}
                  disabled={loadingAudioFor === step.narration}
                  style={{ fontSize: 12, padding: '2px 10px', borderRadius: 6, border: '1px solid #2c3550', background: 'transparent', color: '#e6e9f0', cursor: 'pointer' }}
                >
                  {loadingAudioFor === step.narration ? '…' : '▶'}
                </button>
                {step.isFinalStep && (
                  <span style={{ fontSize: 12, color: '#7ee787', border: '1px solid #2c5c3a', borderRadius: 6, padding: '2px 8px' }}>
                    final step
                  </span>
                )}
              </div>
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
            <Canvas nodes={step.topology.nodes} edges={step.topology.edges} nodeStats={step.nodeStats} />
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
            <TraceView trace={step.trace} nodes={step.topology.nodes} />
            <NodeStatsTable nodes={step.topology.nodes} nodeStats={step.nodeStats} />
          </section>
        ))}
      </div>

      {qaLog.length > 0 && (
        <div data-testid="qa-log" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          {qaLog.map((qa, i) => (
            <div key={i} data-testid="qa-entry" style={{ border: '1px solid #2c3550', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <p style={{ margin: 0, color: '#7ee787', fontSize: 13 }} data-testid="qa-question">
                  Q: {qa.question}
                </p>
                <button
                  type="button"
                  data-testid="play-answer-button"
                  onClick={() => playText(qa.answer)}
                  disabled={loadingAudioFor === qa.answer}
                  style={{ fontSize: 12, padding: '2px 10px', borderRadius: 6, border: '1px solid #2c3550', background: 'transparent', color: '#e6e9f0', cursor: 'pointer', flexShrink: 0 }}
                >
                  {loadingAudioFor === qa.answer ? '…' : '▶'}
                </button>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 14 }} data-testid="qa-answer">
                {qa.answer}
              </p>
            </div>
          ))}
        </div>
      )}

      {status === 'paused' && (
        <div data-testid="paused-controls" style={{ marginTop: 16 }}>
          <p style={{ fontSize: 13, color: '#8b96b3', marginBottom: 8 }}>Paused after step {steps.length}.</p>
          <form onSubmit={handleAsk} style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <input
              type="text"
              data-testid="ask-question-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a follow-up about this step, e.g. what about the celebrity case?"
              disabled={asking}
              style={{ flex: 1, background: '#1b2436', color: '#e6e9f0', border: '1px solid #2c3550', borderRadius: 8, padding: 10 }}
            />
            <button
              type="submit"
              data-testid="ask-button"
              disabled={asking || !question.trim()}
              style={{ padding: '0 20px', borderRadius: 8, border: '1px solid #2c3550', background: 'transparent', color: '#e6e9f0', cursor: 'pointer' }}
            >
              {asking ? 'Asking…' : 'Ask'}
            </button>
          </form>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button
              data-testid="continue-step-button"
              onClick={() => handleContinue('step')}
              disabled={asking}
              style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: '#5b8cff', color: 'white', cursor: 'pointer' }}
            >
              Continue &rarr;
            </button>
            <button
              data-testid="continue-auto-button"
              onClick={() => handleContinue('auto')}
              disabled={asking}
              style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid #2c3550', background: 'transparent', color: '#e6e9f0', cursor: 'pointer' }}
            >
              Finish automatically
            </button>
          </div>
        </div>
      )}

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
