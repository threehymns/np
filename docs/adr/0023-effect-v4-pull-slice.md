# Effect v4 owns the pull slice's time: schedules, timeouts, and deterministic tests

Core `effect` at v4 (never 3.x, never `@effect/platform`) is a dependency of
`@np/core`, scoped to the workspace-pull slice: the repull cadence, the
backoff policy, the three hand-rolled `Promise.race` timeouts in the Language
Server client, and the `TestClock` tests that pin them. This records why v4,
what changed from the #301 measurements taken against 3.19.11, and what the
dependency costs — because a library in core is hard to reverse, and the
reversal cost is the thing being accepted here.

## Why a dependency at all, and why this one

The alternative is four hand-rolled engines we would otherwise keep race-free
by hand: spaced repull, exponential backoff with jitter and a clamp, three
timeout races (`withTimeout`, `settleWithin`, `waitForExit` in `client.ts`,
the last of which is also the completion `fetch` bound via `request()`), and
scoped teardown of the loop fiber. Each is small; the races between them are
not — the lifecycle's `dropPending`, the stop-in-flight re-read, and the
handshake-loser check are all manual bookkeeping for exactly the interleavings
`Scope` finalizers exist to own. Effect contributes one tested implementation
of each, plus the one thing no hand-rolled version gives: `TestClock`, which
turns today's real-sleep timer tests into deterministic `adjust`-driven ones.
That last point is the cheapest reliability win in the ticket and the reason
the adoption is scoped to time, not to all of Effect.

**v4, not 3.x.** The #301 research measured `3.19.11`. By implementation time
v4 (`4.0.1`) is latest, and the v3 line is where the old API lives. Pinning
forward deliberately avoids adopting an API the ecosystem has already left:
v4 removed `Effect.timeoutFail` (the migration path the ticket names), renamed
`Effect.fork` to `Effect.forkChild`, re-shaped `Schedule.upTo` from a bare
duration to `{ duration?, times? }`, and re-shaped `Result` so success carries
`.success` rather than `.value`. Every one of these surfaced during this slice
and each is pinned in the tests, so the surprise is recorded rather than
paved over. The bundle delta, re-measured below, favours v4 by a wide margin.

**Core `effect` only, never `@effect/platform`.** Workers live in the separate
platform package, and there is still no measured main-thread jank case —
completion payloads and `publishDiagnostics` are small, and the workspace-pull
payload is only a future candidate. Platform bindings belong in
`apps/desktop` if they ever come; the review line holds: no
`@effect/platform*` import in `packages/core`, and the existing `LspPlatform`
seam stays the only one rather than letting Effect's `Command`/`FileSystem`
become a second.

## What v4 changed from the #301 sketch

The #301 loop sketch (`repeat` + `retry` + `timeout` + `Scope`, `spaced` +
`exponential` + `upTo`) survives in shape but not in spelling:

- `timeoutFail` is gone. The domain error (`LspTimeoutError`) is carried by
  `Effect.timeoutOrElse` with an `orElse` that runs the pending-map cleanup and
  fails — one combinator rather than two, same contract. `timeoutOption` is
  unchanged and still spells `settleWithin` exactly.
- `upTo` no longer clamps delays: it bounds elapsed time or recurrence count.
  The 30–1000 ms backoff clamp is a `Schedule.modifyDelay` cap on each
  selected, jittered delay instead, which is what `pull-schedules.ts`
  carries — retries continue indefinitely at no more than the ceiling rather
  than stopping once a delay outgrows it.
- `Schedule.intersect` / `union` from the sketch are `min` / `max` in v4
  vocabulary; neither is needed for the two schedules here, so neither is
  imported.
- `Effect.fork` is `Effect.forkChild`. The loop itself still dies with the
  entry's scope via `forkScoped` — the structured answer to the manual
  bookkeeping named above — but the per-server scope wiring lands with the
  #299 pull slice that owns the loop, not here.

The honest limits from #301 stand unchanged: Effect interrupts the *wait*,
not the wire (JSON-RPC has no cancel for an arbitrary in-flight request, so a
timed-out completion is still answered and dropped, as before), and fibers are
cooperative — a synchronous `JSON.parse` of a huge pull report still blocks,
and chunked parsing comes before Workers if that ever measures real.

## What ships, and what it costs

Two modules, both in the plugin that owns the protocol (ADR 0020), neither
touching completion trigger/context (#306) nor diff-viewer/multibuffer
(#300):

- `effect-timeouts.ts`: `timeoutFailEffect` / `timeoutOptionEffect` programs
  (what `TestClock` drives) plus `withTimeout` / `settleWithin` / `settleExit`
  promise wrappers (what `LspClient` calls, same signatures and same
  `LspTimeoutError` as before). `client.ts` loses every direct `setTimeout`
  and `Promise.race`; the fetch bound in `lifecycle.ts` flows through
  `request()` unchanged, so coordinator behaviour and request shapes are
  identical for #306 to merge against.
- `pull-schedules.ts`: the repull (`spaced`, 2 s) and backoff (`exponential`
  50 ms, `jittered`, capped at 1 s) policies plus a `pullWithBackoff` (`retry`)
  combinator for #299 to drive with `repeat` + `forkScoped`. Policy only — no
  loop starts here, no document opens, no completion path is touched.

Re-measured against v4 at build time (`bun build --minify --target=browser`,
same method as #301 §6):

| Probe | Minified | Gzip |
| --- | --- | --- |
| `Effect`+`Schedule`+`Duration`, retry+backoff only | 28 KB | ~10 KB |
| Loop shape: `repeat`+`retry`+`timeout`+`Scope` | 40 KB | ~13 KB |
| This slice (`effect-timeouts` + `pull-schedules`) | 38 KB | ~13 KB |
| + `Stream.debounce` (edit-debounce path) | 42 KB | ~14 KB |

Every row is smaller than its v3 counterpart (48 / 126 / 173 KB minified,
16 / 40 / 54 KB gzip) — v4 treeshakes harder, same per-module ESM and
`"sideEffects": []` story. Context from #301 still holds: the shipped web
build totals ~4.2 MB with a 354 KB largest chunk, so the slice lands at roughly
one small chunk, ~1% of either bundle. `TestClock` is test-only and never
ships (it does not even bundle for browser — it pulls node builtins through
`TestSchema` — which is correct, since tests run under bun).

`@np/core` stays free of Node globals (CONTEXT.md Architecture): zero
statement-level `node:` imports across `effect` v4's `dist/*.js` (the only
`node:` hits are graph-node field names in `Graph.js`), time goes through the
injectable `Clock`, and core's own timeout paths no longer name `setTimeout`
at all.

## What is asserted, and where

Timer behaviour is asserted without sleeping: `effect-timeouts.test.ts` forks
each program, moves `TestClock` past (or short of) the bound, and joins —
domain-error failure with cleanup on expiry, value passthrough before it,
`None`/`Some` for the option shape, a `Deferred` waiter unblocked by the
clock, repull repetition count on the 2 s cadence, and a flaky pull retried to
success under backoff. The existing client and lifecycle suites are unchanged
in what they assert (same request shapes, same coordinator states) and all
pass, which is the point: the migration is invisible from the wire.

Open for #299, not here: the per-server scope that owns the loop fiber, the
coalescing queue draining refresh signals, `Effect.gen` vs plain combinators
as a style choice, and a real Vite-bundle number to replace the bun-built ones
above.
