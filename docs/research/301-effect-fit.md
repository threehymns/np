# Research: how Effect TS helps across the LSP follow-ups (#301, part of #291)

**Question:** How could Effect TS help with everything on this map — the
workspace-pull polling/backoff/cancellation loop, the existing hand-rolled
timeout races, debounce, orphaned-process and main-thread-blocking hazards for
future agents? Weigh the huge-library concern (treeshaking) against not
maintaining our own engines. Feeds the Effect adoption decision.

**Primary sources:** `effect@3.19.11` published code (installed into
`/tmp/opencode/effect-probe`, i.e. the artifact under evaluation, not a
write-up of it), the Effect GitHub source via Context7 excerpts
(`packages/effect/src/internal/effect.ts`, `packages/effect/src/Effect.ts`),
npm-registry metadata (`effect`, `@effect/platform`), bundlephobia size API,
`bun build` measurements taken for this ticket, Zed timings from
`docs/research/298-pull-diagnostics.md`, and this repo's
`packages/core/src/plugins/lsp/client.ts`,
`packages/core/src/plugins/lsp/lifecycle.ts`,
`packages/core/src/plugins/services.ts`,
`packages/core/src/workspace.svelte.ts`,
`apps/desktop/src/main.ts`, `CONTEXT.md`. Line numbers prefixed `repo:` are
this repo; `eff:` is `node_modules/effect` 3.19.11 in the probe dir.

**One-line answer:** Core `effect` (not `@effect/platform`) replaces four
hand-rolled engines with one tested one — `Schedule` (exponential backoff +
spaced repull) for the workspace-pull loop, `Effect.timeout*` for the three
`Promise.race` sites, `Stream.debounce` for edit debounce, `Scope`/finalizers
for orphan-free teardown — with `TestClock` making the timer tests
deterministic; it costs ~48–173 KB minified (~16–54 KB gzip) treeshaken, adds
zero Node globals to `@np/core`, and does *not* move work off the main thread
(Workers live in the separate `@effect/platform` package and should wait for a
measured jank case).

---

## 1. Workspace-pull loop: `repeat` + `Schedule` + `Scope`

Zed's loop, per the #298 research: a perpetual per-server refresh task that
coalesces queued refreshes, idles on a 2 s repull timer
(`WORKSPACE_DIAGNOSTICS_REPULL_DELAY`), backs off `50 * 2^attempts` ms clamped
to 30–1000 ms, and dies with the server (`docs/research/298-pull-diagnostics.md`
§3, §6). Each half has a direct Effect primitive, verified in the 3.19.11
artifact:

- Repull cadence: `Schedule.spaced(duration)` — "recurs at a fixed interval"
  with no pile-up ("If the action ... takes longer than the interval, the
  next execution will happen immediately ... without overlapping executions",
  `eff:dist/dts/Schedule.d.ts`, `spaced` JSDoc). Driven by
  `Effect.repeat({ schedule })` (`eff:dist/dts/Effect.d.ts`, `repeat`), the
  same shape as the `waitForCount` helper in Effect's own test suite
  (`Effect.repeat({ until, schedule: Schedule.spaced(...) })`,
  `packages/effect/test/unstable/persistence/SqlCleanupTest.ts` via Context7).
- Backoff: `Schedule.exponential(base, factor?)` with default factor 2
  (`eff:dist/dts/Schedule.d.ts`: `(base: Duration.DurationInput, factor?: number)
  => Schedule<Duration.Duration>`) — `exponential("50 millis")` *is* Zed's
  `50 * 2^attempts`; clamp with `Schedule.upTo`/`whileOutput`, add
  `Schedule.jittered` against thundering-herd restarts, compose repull spacing
  with retry policy via `Schedule.intersect`/`union` (all present in
  `eff:dist/dts/Schedule.d.ts` export list). Retry driver is
  `Effect.retry(policy)` / `retryOrElse` (`eff:dist/dts/Effect.d.ts`; loop
  mechanics in `packages/effect/src/internal/schedule.ts` via Context7).
- Coalescing: refresh signals go through a `Queue`/`Deferred`/`Mailbox`
  drained by the loop instead of today's nothing (there is no pull loop yet —
  this repo is push-only, `repo:diagnostics.ts:91-104`). One attempt then serves
  all waiters, matching Zed's `refresh_rx` coalescing (#298 §3).
- Teardown: `Scope` owns the loop fiber. `Effect.forkIn(child, scope)` forks "a
  fiber in a specific scope" (`eff:dist/esm/Effect.js:4839-4875` JSDoc); the
  implementation registers a scope finalizer that interrupts the fiber when the
  scope closes (`packages/effect/src/internal/effect.ts`, `forkIn`, via
  Context7). `Scope` offers `addFinalizer`, `close`, `extend`, `fork`, `use`
  (`eff:dist/dts/Scope.d.ts`). This is the structured answer to today's manual
  bookkeeping in `repo:lifecycle.ts` — `dropPending` (`469-474`), the
  "replacement while the stop was in flight" re-read (`558-563`), and the
  handshake-loser check `entry.client !== client` (`614-620`): with the loop
  and the handshake both scoped, the loser is interrupted and its finalizer
  stops the extra client, instead of each caller re-checking a table.

Sketch against `repo:lifecycle.ts` (per-server entry gains a scope; new code
for the #299 pull slice, not a rewrite of `ensureRunning`):

```ts
import { Effect, Schedule, Scope } from "effect"

const repull = Schedule.spaced("2 seconds")
const backoff = Schedule.exponential("50 millis").pipe(
  Schedule.upTo("1 second") // Zed clamps 30–1000 ms (#298 §3)
)

const workspacePullLoop = (server: string, pull: Effect.Effect<void, unknown>) =>
  pull.pipe(
    Effect.repeat(repull),
    Effect.retry(backoff),
    Effect.forkScoped // dies with the entry's scope: stop/dispose interrupts it
  )
// dispose()/stopEntry() today: repo:lifecycle.ts:522-540, 661-678.
// Becomes: Scope.close(entry.scope, Effect.void) — finalizers run
// client.stop() (the kill path at repo:client.ts:320-342) even on failure.
```

## 2. Hand-rolled timeout races → `Effect.timeout*`

Three `Promise.race` sites, all in `repo:client.ts` unless noted:

- `withTimeout` (`427-445`): races `request()` against a timer, deletes the
  pending entry on expiry, rejects with `LspTimeoutError`. Used by
  `request()` (`204-215`) and therefore by `initialize` (`228-284`) and via
  `repo:lifecycle.ts:362-369` (`timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS`,
  `154`) by completion `fetch` (`326-384`).
- `settleWithin` (`453-464`): same race but resolves `null` instead of
  failing — used by `resolveProcessId` (`304-310`) to degrade to `null`.
- `waitForExit` (`344-359`): races `process.exit` against a timer for the
  shutdown→exit→kill chain in `stop()` (`320-342`).

Effect replacements, all in `eff:dist/dts/Effect.d.ts`:

- `Effect.timeout(duration)` interrupts the waiter and fails with
  `TimeoutException` — the `withTimeout` shape, except interruption
  *propagates*: `Promise.race` leaves the loser running (today the pending map
  entry is deleted but the underlying promise and its closures stay alive until
  the server answers). With `Effect.async` + cleanup, cancellation reaches the
  transport boundary instead of leaking it.
- `Effect.timeoutOption` resolves `Option.None` on expiry — exactly
  `settleWithin`'s "late answer to a default-none question is the same answer
  as no answer" (`repo:client.ts:447-452`), typed instead of nullable.
- `Effect.timeoutFail(error)` / `timeoutTo` / `timeoutOrElse` carry the
  domain error (`LspTimeoutError`) and the fetch fallback (`unavailable`, words
  answer instead — `repo:lifecycle.ts:371-383`).

Two honest limits. First, Effect cancels the *wait*, not the wire: JSON-RPC has
no cancel for an arbitrary in-flight request except `$/cancelRequest`, which we
do not send — a timed-out completion still gets answered and dropped, as
today. The win is deterministic cleanup of the waiter, not protocol
cancellation. Second, `TestClock` (below) makes these races testable without
real sleeps; today's tests sleep real milliseconds (`repo:lifecycle.test.ts:272`
`setTimeout(..., 60)`, `repo:lsp-ui.test.ts:166`, `repo:client.test.ts:130,266`).

```ts
// repo:client.ts request() today: withTimeout(settled, ms, del, err)
// Becomes: Effect.timeoutFail(entry.client.request(...), { duration: ms, error: () => new LspTimeoutError(...) })
// repo:client.ts resolveProcessId(): settleWithin(ready, ms) ?? null
// Becomes: Effect.timeoutOption(ready, ms) — None means "transport never named its parent".
```

## 3. Debounce: `Stream.debounce` (and nothing else is needed)

Zed debounces 50 ms at the editor plus a 100 ms cross-buffer background queue
(#298 §6); this repo's nearest equivalents are `debouncedSaveOpenFiles`'s
500 ms clearTimeout/setTimeout (`repo:workspace.svelte.ts:171-178`) and a
slight search debounce (`repo:project/tree.svelte.ts:271`). Verified:
**no `Effect.debounce` and no `Schedule.debounce` exist** (0 matches in
`eff:dist/dts/Effect.d.ts` and `Schedule.d.ts`). The canonical primitive is
`Stream.debounce`: "holding new values for a set duration ... if a new value
is received during the holding period the previous value is discarded"
(`eff:dist/dts/Stream.d.ts:1856+`). The pull-on-edit path (#299) is therefore
`Stream.fromQueue(edits).pipe(Stream.debounce("50 millis"))` feeding
per-buffer pulls — trailing-edge, last-writer-wins, matching Zed's editor
debounce. Adopting Effect *only* for debounce would not justify itself; it
rides along with the loop adoption.

## 4. Orphaned processes: finalizers, not discipline

Today orphan-freedom is manual at every layer: `LspClient.stop()` bounds
shutdown *and* exit waits then kills (`repo:client.ts:312-342`), start failure
kills the half-spawned process (`repo:lifecycle.ts:592-636`,
`spawnedProcess?.kill()`), `stopEntry` is best-effort by comment
(`671-678`), and Electron main keeps its own `killLspProcess` /
`killAllLspProcesses` so quit cannot strand a server
(`repo:apps/desktop/src/main.ts:61-71`).

Effect's contribution is making the release *unconditional* rather than
remembered:

- `Effect.acquireRelease(acquire, release)` returns
  `Effect<MyResource, Error, Scope>` (`eff:dist/dts/Effect.d.ts:9738-9752`
  JSDoc) — the release runs on success, failure, *and interruption*, which is
  precisely the start-failure and handshake-race paths that today need
  hand-placed `kill()` calls. `acquireUseRelease` scopes it automatically;
  `acquireReleaseInterruptible` marks the release safe to interrupt.
- `Scope.addFinalizer` / `Effect.ensuring` attach `client.stop()` (kill chain)
  to the entry's scope, so `dispose()`, `stopServer()`, `stopWhenUnserved()`,
  and the settings-gate detach (`repo:lifecycle.ts:768-812, 829-843`) all funnel
  through one teardown instead of each remembering to stop-then-drop-pending.
- `Effect.uninterruptible` / `uninterruptibleMask` (`eff:dist/dts/Effect.d.ts`)
  wrap the kill itself: a `SIGKILL` issued inside an uninterruptible region
  cannot be lost to an incoming interruption — the "server that ignores
  `shutdown` must still die" (`repo:client.ts:106-115`) becomes a guarantee
  rather than a carefully ordered `await` chain.
- What Effect does *not* cover stays where it is: Electron-main
  `killAllLspProcesses` on quit, the token-gated `lsp:spawn` plan
  (`repo:main.ts:46-54, 392-451`), and the `processId` parent-watch contract
  (`repo:client.ts:286-310`, `repo:services.ts:145-166`) are main-process and
  protocol facts, unaffected by renderer-side structure.

## 5. Main-thread blocking: what Effect does and does not do

Effect fibers are **cooperative green threads on one OS thread** — they give
*interruption and async boundaries*, not parallelism. Concretely for the
"future agents" hazards named in the ticket:

- Responsiveness wins are real but limited: long Effect programs can
  `Effect.yieldNow()` at chunk boundaries so the Svelte UI thread breathes,
  and a wedged pull is interruptible (see §2). But a synchronous
  `JSON.parse` of a huge `workspace/diagnostic` report still blocks; Effect
  cannot preempt synchronous JS. If that ever shows up in measurement, the
  fixes are chunked parsing / `setTimeout(0)`-style yields first.
- True off-thread work means Web Workers, and those live in the **separate**
  `@effect/platform` package (`Worker`, `WorkerRunner`, `Transferable`
  modules — confirmed present in `@effect/platform@0.97.2` registry metadata,
  absent from core `effect`, where `ls eff:dist/dts | grep -i worker` finds
  nothing). That package peer-depends on `effect@^3.22` (registry metadata)
  and pulls platform bindings — it belongs in a desktop-app wrapper if ever
  adopted, never in `@np/core`. No Worker adoption is recommended now: there
  is no measured jank case (completion payloads and `publishDiagnostics` are
  small; the workspace-pull payload is the only future candidate).

## 6. The huge-library concern: measured, not feared

Ceiling first, honestly labelled: bundlephobia reports the **whole**
`effect@3.19.11` package at **948 KB / 291 KB gzip** (`bundlephobia.com/api`,
`hasJSModule: dist/esm/index.js`, `hasSideEffects: []`) — that is the
no-treeshaking number and the source of the "huge library" reputation. What
ships is a different question, measured with `bun build --minify
--target=browser` in `/tmp/opencode/effect-probe`:

| Probe (what an LSP slice would import) | Minified | Gzip |
| --- | --- | --- |
| `Effect`+`Schedule`+`Duration`, retry+backoff only (deep `effect/*` imports) | 48 KB | ~16 KB |
| Loop sketch §1: root `effect` import, `repeat`+`retry`+`timeout`+`Scope` | 126 KB | ~40 KB |
| + `Stream.debounce` (§3 path) | 173 KB | ~54 KB |
| `TestClock.adjust` program (test-only, never ships) | 57 KB | — |

Why treeshaking works here, verified in the artifact rather than assumed:
per-module ESM (354 files in `eff:dist/esm`), `"sideEffects": []` in
`eff:package.json`, and both root (`effect`) and deep (`effect/Effect`)
subpath exports — Vite/Rollup (both apps build on Vite:
`repo:apps/desktop/vite.config.ts`, `repo:apps/web/vite.config.ts`) drop
unused modules either way. Context: the shipped web build totals **4.2 MB**
with the largest chunk 354 KB (`build/_app/immutable/chunks/DDTAcKir.js`);
desktop `dist` totals **3.9 MB** (largest asset 354 KB `editor-*.js`). An
Effect-based pull slice lands at roughly one medium chunk, ~1–4% of either
bundle. Caveats: measured with bun's bundler, not the apps' Vite/Rollup
pipeline — same order of magnitude, not the same bytes; confirm with a real
Vite build in the adoption slice before quoting numbers as final.

## 7. What adopting the dependency means for `@np/core`

The hard constraint is `CONTEXT.md` Architecture: "`Core`: The headless
business logic (`@np/core`) ... Entirely platform-agnostic and free of DOM or
Node globals." The seam design already anticipates this: `LspPlatform`
(spawn + `fileExists`, `repo:services.ts:176-180`) and the byte-stream
`LspProcess` contract (`145-174`, "neither platform's stream type leaks into
the plugin's contract") exist so neutral core never touches process APIs.

Verified against the artifact: **zero statement-level `node:` imports across
all of `eff:dist/esm/*.js`** (the only `node:fs`/`node:assert` hits are JSDoc
code *examples inside comments*, e.g. `eff:dist/esm/Effect.js:1655,1679`).
Time goes through the injectable `Clock` service (`TestClock` in tests:
`TestClock.adjust("1 second")`, `TestClock` exports in
`eff:dist/dts/TestClock.d.ts`), so no `setTimeout` global leaks into core
either. Adopting core `effect` therefore keeps the constraint intact; the line
to hold in review is refusing `@effect/platform*` imports in `packages/core`
(platform bindings belong in `apps/desktop`), and keeping the existing
`LspPlatform` seam rather than letting Effect's `Command`/`FileSystem`
become a second one.

`Effect.gen` (generator style, used throughout Effect's own tests via
`it.effect` + `Effect.gen`) would additionally replace the `async`/`await`
chains in `openDocument`/`fetch`/`ensureRunning`
(`repo:lifecycle.ts:241-298, 326-384, 546-641`) with typed-error composition —
style to decide in the adoption slice, not here.

## 8. Recommendation for the adoption decision

- **Adopt `effect` (core package only, measured at 3.19.11) as a dependency of
  `@np/core`, scoped to the #299 pull slice**: the workspace-pull loop, the
  three `Promise.race` sites, edit debounce, and scoped teardown. That is four
  engines we would otherwise write, test, and keep race-free by hand —
  including the backoff math and the coalescing queue Zed needed constants
  for.
- **Adopt `TestClock` alongside for the timer tests** (`@effect/vitest`
  provides `it.effect`): today's real-sleep tests (`60 ms` waits above) become
  `TestClock.adjust`-driven and deterministic — the cheapest reliability win
  in the ticket.
- **Defer `@effect/platform` (Workers) until a measured main-thread case**;
  bar it from `packages/core` in review regardless.
- **Open points for the adoption slice, not this ticket**: pin version
  (measured 3.19.11; note `@effect/platform`'s peer wants `^3.22`, so pin
  forward deliberately), root (`effect`) vs deep (`effect/*`) import style,
  `Effect.gen` vs plain combinators, and a real Vite-bundle measurement to
  replace §6's bun-built numbers.

## Sources

- Effect 3.19.11 artifact (`/tmp/opencode/effect-probe/node_modules/effect`):
  `dist/dts/Schedule.d.ts` (`exponential`, `spaced`, full combinator list,
  no `debounce`); `dist/dts/Effect.d.ts` (`timeout`, `timeoutOption`,
  `timeoutFail`, `timeoutTo`, `timeoutOrElse`, `retry`, `repeat`,
  `acquireRelease`, `forkIn`, `uninterruptible`, no `debounce`);
  `dist/dts/Stream.d.ts:1856` (`debounce` JSDoc); `dist/dts/Scope.d.ts`
  (`addFinalizer`, `close`, `extend`, `fork`, `use`, `make`);
  `dist/dts/TestClock.d.ts` (`adjust`, `setTime`, `sleep`);
  `dist/esm/Effect.js:4839-4875` (`forkIn` scope JSDoc);
  `dist/esm/*.js` statement-level `node:` import grep (zero hits);
  `package.json` (`sideEffects: []`, ESM + deep exports).
- Effect GitHub source via Context7 (`/effect-ts/effect`): `forkIn`
  scope-interrupts-fiber (`internal/effect.ts`); `retryOrElse` schedule loop
  (`internal/schedule.ts`); `Effect.timeoutOrElse` interruption semantics +
  `timeoutOrElse` external-interruption test (`Effect.test.ts`); `waitForCount`
  `repeat`+`spaced` helper (`SqlCleanupTest.ts`).
- Registry metadata: `@effect/platform@0.97.2` exports (`Worker`,
  `WorkerRunner`, `Transferable` present; peer `effect@^3.22.2`).
- Bundlephobia API `?package=effect@3.19.11`: 948 424 B / 290 911 B gzip,
  whole-package ceiling.
- `bun build --minify --target=browser` probes (§6 table; scripts in
  `/tmp/opencode/effect-probe/*.ts`, throwaway).
- This repo: `packages/core/src/plugins/lsp/client.ts:104-130, 146-159,
  167-194, 204-215, 228-310, 312-359, 427-464`;
  `packages/core/src/plugins/lsp/lifecycle.ts:134-154, 164-201, 241-298,
  326-384, 446-474, 480-540, 546-641, 661-678, 768-843`;
  `packages/core/src/plugins/services.ts:81-180`;
  `packages/core/src/plugins/lsp/diagnostics.ts:91-104, 166-256`;
  `packages/core/src/workspace.svelte.ts:171-178`;
  `apps/desktop/src/main.ts:44-71, 383-451`; `CONTEXT.md` (Core constraint);
  `docs/research/298-pull-diagnostics.md` §3, §6 (Zed loop timings).
