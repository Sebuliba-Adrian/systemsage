import { NextResponse } from 'next/server';
import { isTopology, simulate, type Topology } from '@systemsage/engine';

/*
 * Direct access to the real engine, no LLM in the loop. Exists so the
 * "engine determinism" claim in ARCHITECTURE.md is testable on its own:
 * the same topology + seed, simulated twice through this endpoint, must
 * return byte-identical stats. See e2e/tests/engine-determinism.spec.ts.
 */
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as { topology?: unknown; seed?: number; simulatedSeconds?: number };

  if (!isTopology(body.topology)) {
    return NextResponse.json({ error: 'Invalid topology: failed isTopology validation' }, { status: 400 });
  }

  const result = simulate(body.topology as Topology, {
    seed: body.seed,
    simulatedSeconds: body.simulatedSeconds,
  });

  return NextResponse.json(result);
}
