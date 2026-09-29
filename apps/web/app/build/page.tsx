import Link from 'next/link';
import { InteractiveCanvas } from '../components/InteractiveCanvas';

export default function BuildPage() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 32 }}>
      <Link href="/" data-testid="back-link" style={{ color: '#8b96b3', fontSize: 13 }}>
        &larr; Back to the tutor
      </Link>
      <h1>Build it yourself</h1>
      <p style={{ color: '#8b96b3' }}>
        Drag a component from the palette onto the canvas, drag from its green handle to another
        component to wire them together, then run the simulation. Same engine the AI tutor uses --
        driven by you instead.
      </p>
      <InteractiveCanvas />
    </main>
  );
}
