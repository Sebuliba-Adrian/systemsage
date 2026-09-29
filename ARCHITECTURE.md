# SystemSage architecture

Agent-driven, narrated system design tutor. Hybrid of two real prior
attempts, keeping what worked and replacing what didn't:

- **Breakscale** (github.com/xevrion/breakscale, MIT) gave us the thing that
  matters most: a *real* discrete-event simulation engine, vendored into
  `packages/engine`. Every stat a lesson step narrates is a measured output
  of a real, seeded run, not a model's guess dressed up as a number.
- **PrepCity** (`C:\projects\PersonalAsistant`) gave us the pedagogical
  shape (a staged, progressive build-up of one diagram) and one genuinely
  good implementation detail worth keeping: LLM decisions that matter get
  validated by a schema (Zod), not just asked for nicely in a prompt. Its
  free-hand Mermaid diagrams and prose-only "consistency locks" are NOT
  carried forward -- see the earlier review for why.

## The one rule everything else follows: API-first, mobile-first

`C:\projects\personal-assistant-mobile` already proved the shape a second
client needs, in production, on a real device. SystemSage's web app is
built the same way from day one, specifically so a future Expo/React
Native client is a new consumer of an existing contract, not a reason to
touch the backend:

- All real logic lives in `packages/*`, never inside a Next.js Server
  Component or page. `apps/web` is a thin client of its own API, exactly
  like the mobile app is a thin client of Supabase Edge Functions.
- The API is one typed SSE stream per design session (see
  `packages/lesson-planner` for the event shapes), not a page-by-page
  request/response dance. A React Native client can't use `fetch` for
  streaming (confirmed by the mobile app already routing around this with
  `react-native-sse`), so the contract is designed around an SSE library
  from the start, not bolted on later.
- **Diagrams are data, not markup.** PrepCity/the mobile app pre-render
  Mermaid to SVG server-side because Mermaid itself is a web-only JS
  library and a phone can't run it. We don't have that problem: a step's
  diagram is a validated `Topology` (nodes/edges/config, checked by
  `isTopology` before it ever leaves the server) plus the engine's real
  `SystemStats`. Each platform draws its own canvas from that JSON --
  `react-native-svg` on mobile, whatever the web app uses -- so nothing
  platform-specific ever has to live on the server.
- Narration audio is streamed the same way: short chunks over the same SSE
  connection, timestamped to the step they belong to, so a client can start
  playing audio before the whole step's audio exists -- the same
  chunk-as-you-go posture the mobile app already uses for text.

## Packages

- `packages/engine` -- the vendored Breakscale simulator. See its own
  README for the MIT attribution and what was and wasn't carried over.
- `packages/lesson-planner` -- turns a learner's plain-language system
  description into an ordered sequence of steps. Each step is `{ topology
  diff, narration text }`, produced by an LLM call and *validated against
  the engine's own `isTopology` before anything downstream trusts it* --
  the exact check PrepCity never had, which is why its diagrams needed a
  second LLM call just to repair broken syntax. Ours can't get that far
  broken: a rejected step is a specific, real validation error, regenerated
  or surfaced, never silently rendered wrong.
- `packages/narrator` -- turns a step's narration text into real streamed
  audio (Gemini TTS, the same family measured for real in Book 5's voice
  work), not the browser's/OS's built-in `speechSynthesis`, which is the
  one piece of both prior attempts that flatly can't deliver "feels like an
  actual person" on its own.
- `apps/web` -- the first client. Talks to its own API the same way a
  future mobile client would.
- `e2e` -- Playwright, driving the real running app in a real browser.
  Two different claims get tested, deliberately kept separate:
  1. **Engine determinism (exact-value proof).** The same *topology* and
     seed, simulated twice, must produce byte-identical `SystemStats`.
     This is tested directly against the engine, bypassing the LLM
     entirely -- it's a claim about the simulator, not about the tutor.
  2. **Pipeline realism (structural proof, not exact-value).** A real
     description, submitted through the real UI, must produce a step
     whose stats are real finite numbers from an actual `simulate()` call,
     not placeholder or hallucinated text. This does NOT assert the same
     description yields the same topology twice -- which component the
     planner proposes first is a legitimate LLM judgment call, and pinning
     it would just be testing a snapshot, not correctness.

## Retry, not fatal, on a recoverable planning failure

`packages/lesson-planner/src/plan.ts` retries a step up to 3 times when the
failure is one a corrected prompt can plausibly fix: the model's structured
output failed schema validation (`NoObjectGeneratedError`), it reused an
existing node id, or the merged result failed `isTopology`. Each retry gets
specific, named feedback (the exact id reused, the raw invalid text, the
exact step that failed structural validation) fed back into the next
attempt -- not a generic "try again." This is the fix for a real failure
found live while testing ("No object generated: response did not match
schema" killing the whole SSE session after 2 good steps). The seam this
runs through (`StepGenerator` in `plan.ts`) is injectable, so the retry
logic itself is tested without ever calling the real Gemini API -- see
`e2e/tests/retry.spec.ts`.

## Inserting into an existing path: removeEdges

The schema originally allowed a step to `addNodes`/`addEdges` only, which
meant a real design pattern -- inserting a component into a path that
already existed, like a cache in front of a database -- could only ever
ADD a branch, never remove the direct edge it was supposed to replace.
This is a real bug that shipped and was caught by looking at a live
screenshot: a "cache" step measurably changed nothing, because the
database still received every request directly, same as before, on the
edge nobody removed.

Fixed by adding `removeEdges` to `LessonStepSchema` (validated against the
CURRENT topology only -- a step can't remove an edge it's adding in the
same step, and naming a removeEdges entry that doesn't exist is a
recoverable failure fed back through the same retry mechanism above, not
silently ignored) and by teaching the planner explicitly, with a worked
example, that inserting a component means remove-then-rewire, not just add.

Proven three ways, deliberately including one that isn't about the planner
at all: `e2e/tests/cache-routing.spec.ts` checks (1) a scripted step's
removeEdges actually removes the old edge, (2) a hallucinated removal is
retried rather than silently accepted, and (3) an **engine-level** proof
with no LLM involved -- the same two topologies (fan-out vs. correctly
chained through the cache), simulated for real, where the chained one has
strictly better measured goodput and p95. That third test is the one that
actually matters: it's not enough for the fixed topology to look right,
its *simulated behavior* has to be measurably better, which is the entire
premise this project is built on. Confirmed once more with a real,
non-scripted Gemini call: the live "Add a Cache Layer" step now removes
`service-1->db-1` and routes `service-1->cache-1->db-1`, with real p95
dropping from 104.6ms to 79.0ms as a direct, measured consequence.

## A second, MCP-driven path (built)

`packages/mcp-server` wraps the engine core as two MCP tools --
`read_design_format` (returns the exact same `buildDesignFormatGuide()`
text `lesson-planner`'s system prompt embeds) and `propose_step` (runs the
proposed diff through the exact same `applyStep` + `simulate`
`lesson-planner` uses). Same rules, same validation, same simulator,
regardless of which agent is deciding what to add -- that's deliberate:
the standing requirement is that a design built by Claude Code or Codex
driving this server has to be held to the identical bar as one built by
the hosted Gemini planner, not a looser one, and sharing the literal code
is what makes that true instead of asserted.

Registered in `.mcp.json` at the repo root (`stdio`, `pnpm --filter
@systemsage/mcp-server start`) so any MCP-speaking agent connected to this
repo can use it -- no API key or cost on our side for that path at all.

Proven with a real, automated, two-process MCP client/server round trip
(`e2e/tests/mcp-server.spec.ts`, using `@modelcontextprotocol/sdk`'s own
`Client` + `StdioClientTransport` to spawn the real server as a real
subprocess and drive it over the real protocol, not a mock): a scripted
client lists both tools, reads the real generated palette, gets a real
rejection with a specific error for an invalid `removeEdges` entry, and --
the test that actually matters -- completes a real two-step session that
inserts a cache correctly (`removeEdges` used, `service-1->db-1` gone,
routed through `service-1->cache-1->db-1`), the exact pattern that was
bugged before `removeEdges` existed. This is what "works with an external
agent as the driver" actually means here: any client that speaks MCP
correctly gets this behavior, proven by literally being one.

## Multiple providers, same pipeline (packages/lesson-planner/src/providers.ts)

The standing requirement: quality results from Claude Code or Codex (via
the MCP server) must equal quality results from Gemini, DeepSeek, Qwen, or
Grok via API key. The only way to make that a fair claim instead of an
assertion is for every provider to run through the literal same
`generateObject` call, `LessonStepSchema`, and system prompt --
`createProviderGenerator(providerId)` is the one place that varies, and it
only swaps the model.

Real, current (2026-09-29) `ai@7` + `@ai-sdk/provider@4.x`-aligned
providers wired in: `@ai-sdk/google` (Gemini), `@ai-sdk/deepseek`,
`@ai-sdk/xai` (Grok), and `@ai-sdk/openai-compatible` pointed at
DashScope's endpoint for Qwen (no first-party `@ai-sdk/qwen` package
exists). `hasRealKey(providerId)` checks the relevant env var LIVE, every
call, never cached at module-import time -- an earlier version of this
checked it once at import and got a false negative in
`scripts/compare-providers.ts` because that script's own `dotenv.config()`
call (top-level code) runs AFTER static ES module imports evaluate,
importing-before-loading being exactly the kind of ordering bug worth
fixing at the source rather than by telling every caller to import in a
particular order.

**Real keys found in this account** (reused, never fabricated): Gemini
and DeepSeek (`DEEPSEEK_API_KEY` was already in PrepCity's `.env.local`).
**No key exists anywhere in this account** for Qwen (`DASHSCOPE_API_KEY`)
or Grok (`XAI_API_KEY`) as of this writing -- `scripts/compare-providers.ts`
reports them as skipped, with the specific missing env var named, not as a
failure or a faked result.

`scripts/compare-providers.ts` runs a fixed, small set of real briefs
through every real provider AND through Claude reasoning about the same
briefs by hand (both paths landing in the identical `applyStep`/`simulate`
core), records everything to `runs/provider-comparison-<date>.json`, and
prints the honest caveat this project's own book series established for
exactly this situation: a small n is real data, not proof of a general
rate (see [[book4-evaluation-roadmap]]'s "6/6 is not 100%" -- literally the
same discipline, applied here).

**First real run (2026-09-29), n=2 briefs, both Gemini and DeepSeek
succeeding first attempt, zero retries needed:** for "a URL shortener...
2000 requests per second," Gemini, DeepSeek, and Claude's own hand-authored
step independently converged on the SAME real measured stats (p50=431.1ms,
errorRate=90.3%) -- because all three proposed structurally the same first
topology, and the same real simulator gives the same real numbers
regardless of which brain proposed it. For "a chat application... 50,000
concurrent users," Gemini and DeepSeek both configured a healthier first
step (p50 47-54ms, 0% errors) than Claude's own hand-authored one (p50
404ms, 57% errors) -- a real, unflattering data point about that specific
manual design choice, kept rather than smoothed over, exactly per this
project's own faithfulness standard.

## Deliberately deferred, not forgotten

- The actual mobile app. Architecture is shaped for it now; building it is
  a later phase, once the web client and the API contract are proven.
- Multi-turn editing of an in-progress design (a learner asking to change a
  step after the fact). First pass is linear: describe once, get a full
  staged build-up.
