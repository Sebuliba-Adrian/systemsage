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

## Two crashes found by real concurrent stress testing, not by unit tests

Both of these were found the same way: firing several real, full-length
(8-step) sessions at DeepSeek concurrently (chosen because its JSON-schema
mode is a compatibility shim, not native, and is measurably more
failure-prone than Gemini's), the way a learner's browser tab could
plausibly overlap with someone else's session on a shared server, rather
than trusting that scripted/mocked tests had already covered every real
failure mode.

**A live process crash, `RangeError: Invalid array length`.** Two of four
concurrent real DeepSeek sessions crashed outright. The first hypothesis
(unbounded array growth in Breakscale's shard/replica sizing) was wrong --
`effectiveInstances()` and `clampInt` already guard every one of those call
sites. The real cause was only found after fixing a second, quieter bug:
`apps/web/app/api/design-session/route.ts` was logging only `err.message`
to the client and nothing at all server-side, so the actual stack trace
was never captured on the first crash. Once errors were logged in full
server-side (`console.error` with the whole error object, always, even
though only a sanitized message goes to the client), reproducing the crash
gave a real stack trace pointing at `assignLayout`'s depth-relaxation BFS
in `packages/engine/src/layout.ts`: it had no cycle detection, so a real
model output whose edges happened to form a loop (A -> B -> ... -> A) sent
every node's depth up by one on every pass around the cycle, forever,
until `Array.push` overflowed.

Fixed with a mathematical bound, not a heuristic: in a graph of N nodes, no
node in an actual DAG can need a depth greater than N-1 (the longest
possible simple path visits every node once), so a depth exceeding N is
proof of a cycle. `GraphCycleError` is thrown at that bound and caught in
`apply-step.ts`, turned into a normal `{ok:false, errors:[...]}` result --
the same recoverable-failure path every other validation error already
goes through, so a cyclic step gets retried with specific feedback instead
of crashing the process. Proven with `e2e/tests/graph-cycle.spec.ts`: a
3-node cycle and a self-loop are both caught with a "cycle" message, and,
just as importantly, a real non-cyclic fan-out/fan-in diamond shape is
proven NOT to trip the same check. Re-ran the exact concurrent scenario
that originally crashed (6 parallel real DeepSeek sessions on the same
brief) twice more afterward: the cycle recurred organically both times and
both times degraded gracefully instead of crashing anything.

That graceful degradation needed its own fix. A step that fails all 3
retry attempts (whether from a real cycle or any other recoverable-but-
persistent failure) used to end the whole SSE session in a raw `error`
event, throwing away every prior step that had already succeeded. Fixed by
giving that specific condition its own type, `StepExhaustedError`, thrown
by `planNextStep` in `packages/lesson-planner/src/plan.ts` instead of a
plain `Error`, and caught specifically in `route.ts` to emit a `done` event
with `reason: 'step_exhausted'` and the last step's failure message,
keeping every step that did succeed. Confirmed live, twice, on real
DeepSeek sessions that organically exhausted retries: the browser showed
several real completed steps followed by a clean "stopped after N steps"
state, never a raw error screen.

**`TypeError: Invalid state: Controller is already closed`.** Found via
the same new server-side logging on a later full-suite run. A client that
disconnects mid-stream (tab closed, a test ending early) closes the
`ReadableStream` on its end; a subsequent `controller.enqueue()` or
`controller.close()` on the server then throws, because the stream is
already gone -- not an application error, just a reader that left. Fixed
using the Streams API's own hook for this: a `cancel()` method on the
stream, called automatically on disconnect, which sets a `clientGone` flag
shared with `start()`. `send()` checks that flag before every `enqueue`
and swallows the (now expected) throw if the client left in the gap
between the check and the call; the `finally` block's `controller.close()`
is wrapped the same way. Confirmed fixed by re-running the full e2e suite
after the fix landed: zero recurrences.

## A fourth driver: a human, dragging components by hand

`apps/web/app/build` (`InteractiveCanvas.tsx`) is a real interactive
palette-and-canvas editor, not a mock-up: drag a component from the
palette onto the canvas, drag from its connector handle to another
component to wire them, then run the simulation. It is a fourth caller of
the same shared core the hosted Gemini/DeepSeek planner and the MCP server
already use -- `applyStep` and `simulate`, unmodified -- so a design built
by hand is held to the identical standard as one an LLM proposed. No API
route needed: the engine package has no Node-only dependencies, so it runs
directly in the browser.

One real extension was needed to make this work: `StepNode` gained
optional `x`/`y` fields. The LLM-driven path never sets them (so its
behavior is unchanged -- `toSimNode` still defaults to `NaN`, letting
`assignLayout`'s BFS auto-place every node), but a human dropping a
component at a specific point on the canvas has a real position to give
it, and `assignLayout` already skipped positioning any node with finite
x/y (that's the same mechanism the Step 2 "cache hides the db" fix relies
on) -- so this was a two-line change, not a fork of the layout logic.

A genuinely nice consequence of reusing `applyStep` unmodified: wiring a
real cycle by hand (A -> B -> C -> A) hits the exact same `GraphCycleError`
path the concurrent-stress-test fix built (see above) -- a human's mistake
is caught by the identical check as a model's, not a separate one that
could drift out of sync with it. Proven in
`e2e/tests/build-canvas.spec.ts`, which drives real pointer events in a
real browser (Playwright's mouse API, not a mocked drag) to add nodes,
move them, wire them, hit that exact cycle case, delete an edge, and run a
real simulation -- five tests, none of them scripting around the UI.

Node deletion IS supported, via a `removeNodes` field added to `StepDiff`
-- but deliberately NOT exposed to either LLM-driven path (neither the
Gemini/DeepSeek system prompt nor the MCP schema mentions it). That's not
an oversight: this project's tutor teaches by adding one real idea at a
time and never un-teaches a component, and letting a model delete
something it already taught would undermine that premise. A human
free-building on the canvas has the opposite problem -- everyone
misclicks -- so it's the one caller that sets this field.

Deleting a node cascades: any edge touching it is removed too
(independent of `removeEdges`), computed in the same pass inside
`applyStep`, since a dangling edge would fail `isTopology` outright if it
weren't. Proven in `e2e/tests/build-canvas.spec.ts`: deleting the middle
node of a real client -> service -> db chain removes both edges touching
it, leaves the client and db nodes (and nothing else) standing, and the
two survivors remain a valid, simulatable topology afterward -- not just
"the deleted node disappeared," which would miss a dangling-edge bug.

## A real staff-level interview audit, and what it actually found

Asked directly: does a real session hold up against how a genuine FAANG
staff-level system design interview is run, back-of-envelope math
included? The honest way to answer that is to run one for real (Gemini,
live, no mocking) with a real hard prompt -- "design Twitter's home
timeline, 300M DAU, ~15 checks/day, p99 < 200ms, some accounts have tens
of millions of followers" -- and read the actual transcript, not assume.

**What the first real run found, all genuine gaps:**
- Zero back-of-envelope arithmetic anywhere in 3 real steps, despite the
  brief giving exact numbers to work from.
- The classic crux of this exact question -- celebrity fan-out write
  amplification -- was half-solved: a queue decoupled the WRITE from
  blocking, but the actual write-amplification (one event, millions of
  fan-out writes) was never named or addressed.
- It self-terminated (`isFinalStep=true`) after only 3 steps for a
  300M-DAU global system, with no wrap-up naming what was left out.
- The interviewer's literal SLA metric, p99, was computed by the engine
  and sent over the wire (`route.ts` sends the whole `SystemStats`
  object) but never rendered by `page.tsx` -- there was no way to see
  from the UI whether the one number that mattered was even met.

**Fixes, each verified by re-running the identical prompt afterward:**
- `page.tsx` now renders `p99`, `offeredRps`, `totalRequests`, and
  `totalFailed` alongside p50/p95/goodput/error-rate -- data that was
  always computed and transmitted, just dropped on the floor by the UI.
- `plan.ts`'s `SYSTEM_PROMPT` now asks for a one-sentence real capacity
  estimate in step 1's narration when the brief gives scale numbers, and
  explicitly forbids inventing numbers when it doesn't.
- `buildDesignFormatGuide()` (shared -- both the LLM planner and the MCP
  server's `read_design_format` get this) now documents the hybrid
  fan-out pattern (push for the common case, pull/merge-at-read for the
  skewed/hot-key case) as a named worked example, the same way the
  removeEdges insertion pattern already was.
- `isFinalStep` guidance was tightened twice: a design may not call
  itself finished while its own just-measured error rate is still high
  ("the simulated numbers are the referee, not your narration"), and a
  brief implying real global scale needs a geographic story or a resolved
  hot-key problem before it's actually done.

**The re-run genuinely changed** -- step 1's real narration became "300M
users checking 15x/day is ~52K requests/sec on average, more like 150K at
peak," and a later step's real narration correctly named the fix: "celebrity
accounts use pull (fan-out-on-read), where their tweets are fetched
dynamically and merged at read time." Both proven live, not asserted.

**What it surfaced instead, reported the same way -- not smoothed over:**
once the model started setting a client's `rps` to match its own real
estimate (~50K-150K), it did NOT reliably raise `instances`/`capacity` on
the components in that load's path to survive it, producing error rates
in the high 90s%. The new isFinalStep rule correctly refused to call that
"finished" -- a real improvement, since the FIRST run had wrongly claimed
completion at 100% error -- but on a re-run it instead ran out its 3 retry
attempts trying to fix the sizing and degraded gracefully
(`StepExhaustedError`, `reason: step_exhausted`) rather than either
crashing or lying about success. That is the correct failure mode, but it
is still a failure mode: closing the loop from "here is my capacity
estimate" to "here is a topology actually sized to survive it" is not
solved by these prompt changes alone, and is the next real gap, not a
hypothetical one.

## The isFinalStep integrity check is now code, not a request

The prompt already asked a model not to set `isFinalStep=true` while its
own measured error rate was still high. A live re-run proved that asking
is not enough: a real Gemini session set `client.rps` to match its own
correct capacity estimate, never sized the components on that load's
path, and still declared *"Design complete"* at a **99.39% measured error
rate** -- the instruction was right there in the system prompt, and the
model ignored it anyway.

Every other integrity check in this codebase (`removeEdges` naming a real
edge, `GraphCycleError`, `isTopology`) is enforced in code and fed back
through the SAME retry mechanism, never left as prose in a prompt. This
was the one exception, and it no longer is: `attemptStep` in
`packages/lesson-planner/src/plan.ts` now runs the real `simulate()` call
itself (once, right after `applyStep` succeeds) and throws a
`StepAttemptError` -- the exact mechanism every other check already
uses -- if `isFinalStep=true` and the measured error rate exceeds
`FINAL_STEP_MAX_ERROR_RATE` (5%), handing back the real numbers (p50/p95/
p99/goodput/offered/error rate) so the retry has something specific to
react to, not a generic "try again." `PlannedStep` now carries that same
`stats` object back to the caller, so `route.ts` no longer runs a second,
separate `simulate()` call that could in principle drift from what was
actually checked -- there is exactly one simulate() per step now, and its
result is both the gate and the displayed stats.

Proven two ways. First, a scripted regression test
(`e2e/tests/retry.spec.ts`): an intentionally overloaded topology
(`client.rps=5000` against default-sized components) that claims
`isFinalStep=true` is rejected with the real measured numbers in the
feedback text, then accepted once a retry actually sizes `capacity`/
`queueLimit` generously enough to survive the load -- and, just as
importantly, a second test proves a NON-final step is never rejected for
having a high error rate, since watching a step look broken before the
next one fixes it is the entire pedagogical point of this tool; the gate
must only fire on the "done" claim.

Second, re-running the identical live Gemini brief that originally found
the bug: this time it correctly ran out its retries and degraded
gracefully (`step_exhausted`, no false "finished" claim) on one attempt,
and on another attempt actually converged to a genuinely finished design
-- 0% measured error, the hybrid fan-out pattern correctly built with a
`streambroker` and `worker` nodes, `isFinalStep=true` correctly accepted.
Both are the right outcome for the case that occurred; neither is a lie
about success.

**One nuance worth reporting honestly, not glossed over:** on the run that
converged, the model set `client.rps=1000`, not the ~52K-150K it had just
calculated out loud. Whether that is a legitimate technique (model one
representative shard rather than the full aggregate) or the model quietly
avoiding the harder sizing problem by testing an easier number is not
something one run can distinguish -- it would take many repeated runs to
see whether this is a pattern or ordinary sampling variance. Recorded
here as an open question, not asserted as either.

## Persisted, resumable sessions -- and step mode, on the same mechanism

Asked directly: how does a design session handle a mid-session
interruption (a dropped connection, a closed tab), and can it pick back up
the way a real conversational tool does? Read honestly before building
anything: it couldn't. The entire session -- `topology`, `priorSteps` --
lived only in local variables inside one `ReadableStream.start()`
closure, for the lifetime of one HTTP request. `clientGone` (added
earlier, see the SSE-disconnect section above) stopped the server from
*crashing* on a dropped connection, but the `for` loop never checked it,
so a disconnect meant the server kept spending real, billed Gemini/
DeepSeek calls into the void until the design finished -- and a
reconnect was always a brand-new session starting from nothing. There was
no session identity to reconnect TO.

Fixed with one mechanism that serves two purposes at once:

- **`store.ts`** -- a durable `SessionState` (`description`, `provider`,
  `topology`, `priorSteps`, `status`), keyed by a generated id, held in a
  module-level Map. Deliberately not a database: this app is one
  long-running Node process (`next dev`/`next start`), not a serverless
  deployment where each request could land on a different instance with
  its own empty memory -- a real multi-instance deployment would need a
  real store (Redis, etc.) instead, noted rather than silently assumed
  away.
- **`runner.ts`**'s `advanceSession` -- the one place a session is
  actually advanced, shared by the initial POST and `/continue`, so
  "start" and "resume" can never drift into two different ideas of what a
  step is (the same DRY discipline `applyStep` already holds both design
  drivers to). Its `auto` flag decides everything: `auto: true` keeps
  going until the design finishes, runs out of retries, or nobody's
  listening (`isClientGone()`) -- in which case it now PAUSES rather than
  either crashing or burning further real API calls with no one watching.
  `auto: false` takes exactly one step, then pauses on purpose.

The key move: a deliberate pause (step mode's "Continue" button) and an
incidental one (a real dropped connection) leave the session in the
*exact same* `'paused'` state, resumed by the *exact same* call --
`POST /api/design-session/continue` with `{ sessionId, mode }`. `mode:
'step'` takes one more step and pauses again; `mode: 'auto'` is the
"eventually continue with the original flow" escape hatch, switching a
step-mode session back to running straight through to completion. This is
also, at the protocol level, precisely what a genuine reconnect-after-
disconnect does: the same endpoint, the same session, no special case.

Proven two ways. A direct API-level suite
(`e2e/tests/session-resume.spec.ts`) drives the actual routes with real
Gemini calls and two independent HTTP requests -- proving a session
survives past the request that created it: continuing produces step index
1 (not a restart at 0), continuing an unknown id fails with a real 404 and
a specific message rather than a crash, continuing an already-`done`
session returns `done` immediately instead of erroring or quietly
restarting, and `mode: 'auto'` genuinely runs a paused session through to
a real completion. A browser-level suite (`e2e/tests/step-mode.spec.ts`)
proves the same through the actual UI: the "Step through manually"
checkbox, the "Paused after step N" banner, and both buttons.

Both suites hit a real, honest wrinkle worth keeping rather than hiding:
on some real runs, the SECOND step legitimately exhausts its retries (the
isFinalStep error-rate gate, or schema validation) and the session ends
in `step_exhausted` instead of producing a second step -- a live outcome,
not a bug, already covered by earlier work. The tests accept EITHER
legitimate outcome rather than assuming the happy path, and in the
exhausted case still assert `totalSteps === 1` (not `0`) specifically
because that number is the proof continuation actually knew about the
prior, already-banked step instead of quietly starting over.

## Scrutiny: asking the candidate a real follow-up mid-pause

Framed directly as an interview: at step 3, the interviewer often has
follow-up questions before deciding to move on -- "what about the
celebrity case?", "your error rate is 90%, what exactly is failing?" --
and only continues once satisfied. `POST /api/design-session/ask` (`{
sessionId, question }`) is that side channel, usable any time a session
is genuinely `paused` (the same state step mode and a dropped connection
both leave it in).

Deliberately NOT another lesson step: no schema, no topology change, no
retry budget, no `simulate()` call of its own -- `answerQuestion`
(`packages/lesson-planner/src/ask.ts`) just asks the candidate to answer,
grounded in the real topology and stats it already has, in the same voice
as its step narrations. Plain JSON in, plain JSON out (unlike
`route.ts`/`continue/route.ts`, this produces exactly one answer, not a
sequence of events, so there's no reason to make it SSE).

**The soft version, deliberately chosen over a hard gate.** Every
question and its real answer is appended to the session's `qaLog` and
handed to every LATER `planNextStep` call as context (see `plan.ts`'s
`buildUserPrompt`) -- a real question actually shapes what gets built
next. But nothing mechanically forces the next step to resolve a given
question, and `isFinalStep` is never gated on one being answered. A hard
"every question must be resolved" rule was considered and rejected: unlike
a measured error rate (an objective number `simulate()` already computes,
which is exactly why the `isFinalStep` gate above COULD be built in code),
"was this question adequately addressed" has no mechanical check --
forcing one risks brittle busywork instead of genuine scrutiny.

Confirmed live, not just asserted: asked "your error rate is over 90%,
what exactly is failing?" at a real paused step, the real answer cited the
EXACT real config values in play -- `service-1` at capacity 8, `db-1` at
capacity 6 with a 30ms service time and a queue limit of 32 -- and stated
a concrete next move (scale both, add a cache or read replicas), not a
generic non-answer. Proven six ways in
`e2e/tests/ask.spec.ts`: a scripted-generator test confirms a real
`qaLog` entry actually appears in the next step's prompt (and, just as
important, that NO question section appears at all when `qaLog` is empty
-- nothing invented); real-API tests confirm an unknown session 404s, a
non-`paused` session is refused with 409 rather than answered against
stale state, and a real question against a real paused session returns a
real, non-trivial answer; a browser test confirms the same through the
actual UI, and that asking does not consume the step or break
continuation afterward.

## Deliberately deferred, not forgotten

- The actual mobile app. Architecture is shaped for it now; building it is
  a later phase, once the web client and the API contract are proven.
- Multi-turn editing of an in-progress design (a learner asking to change a
  step after the fact). First pass is linear: describe once, get a full
  staged build-up.
