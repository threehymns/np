import { Duration, Effect, Schedule, type Fiber, type Scope } from 'effect';

/**
 * The workspace-pull cadence for the #299 pull slice, as Effect v4 schedules
 * (ticket #302, research #301 §1, Zed timings from #298 §3/§6).
 *
 * This module owns the *policy* — how often to repull, how backoff grows —
 * and nothing else. It starts no loop, opens no document, and touches no
 * completion path: the loop driver that consumes these schedules lands with
 * #299, and the completion trigger/context work belongs to #306. Kept small
 * on purpose so #306 merges without touching this file.
 *
 * v4 notes (verified against `effect@4.0.1`, not carried over from 3.x):
 * - `Schedule.spaced` / `Schedule.exponential` / `Schedule.jittered` are
 *   unchanged.
 * - `Schedule.upTo` now takes `{ duration?, times? }` (elapsed/recurrence
 *   bound), not a bare `Duration`. It does *not* clamp backoff delays, so the
 *   30–1000 ms clamp is a `modifyDelay` cap on each selected delay instead:
 *   retries continue indefinitely at no more than the ceiling.
 * - `Schedule.intersect` / `union` from the 3.x sketch are `min` / `max` in v4
 *   terms for delay combination; neither is needed for the two schedules here.
 */

/** Zed's 2 s repull idle (`WORKSPACE_DIAGNOSTICS_REPULL_DELAY`, #298 §3). */
export const WORKSPACE_PULL_REPULL_INTERVAL = Duration.seconds(2);

/** Zed's backoff base, `50 * 2^attempts` ms (#298 §3). */
export const WORKSPACE_PULL_BACKOFF_BASE = Duration.millis(50);

/** Zed's backoff clamp, 30–1000 ms (#298 §3). The floor is the first delay. */
export const WORKSPACE_PULL_BACKOFF_MAX = Duration.millis(1000);

/**
 * Fixed-interval repull: recurs forever, never overlapping. When one pull
 * takes longer than the interval the next runs immediately after, without
 * pile-up — the `spaced` guarantee the #301 sketch verified.
 */
export const repullSchedule: Schedule.Schedule<number> = Schedule.spaced(
	WORKSPACE_PULL_REPULL_INTERVAL
);

/**
 * Exponential backoff with jitter, capped at one second.
 *
 * `exponential("50 millis")` *is* Zed's `50 * 2^attempts` (factor 2
 * default); `jittered` guards thundering-herd restarts; the `modifyDelay`
 * cap keeps every selected delay at or under the documented 1000 ms ceiling
 * while retrying indefinitely, instead of stopping recurrence once a delay
 * outgrows it.
 */
export const pullBackoffSchedule: Schedule.Schedule<Duration.Duration> = Schedule.exponential(
	WORKSPACE_PULL_BACKOFF_BASE
).pipe(
	Schedule.jittered,
	Schedule.modifyDelay(({ duration }) =>
		Effect.succeed(Duration.min(duration, WORKSPACE_PULL_BACKOFF_MAX))
	)
);

/**
 * One pull attempt with backoff, for the #299 loop to drive.
 *
 * `Effect.retry` re-runs `pull` while it fails, waiting per `pullBackoffSchedule`;
 * callers compose this with `Effect.repeat(repullSchedule)` for the perpetual
 * cadence and `Effect.forkScoped` so the fiber dies with the entry's scope
 * (`stop` / `dispose` interrupts it — the structured answer to the manual
 * `dropPending` / handshake-loser bookkeeping in `lifecycle.ts`).
 */
export function pullWithBackoff<E, R>(
	pull: Effect.Effect<void, E, R>
): Effect.Effect<void, E, R> {
	return pull.pipe(Effect.retry(pullBackoffSchedule));
}

/**
 * The perpetual pull loop for one server, as the #301 sketch composed it:
 * `repeat` the attempt on the repull cadence, `retry` failures under backoff,
 * `forkScoped` so the fiber dies with the entry's scope (`stop` / `dispose`
 * interrupts it — the structured answer to the manual `dropPending` /
 * handshake-loser bookkeeping in `lifecycle.ts`).
 *
 * Requires an ambient `Scope` (the entry's): the #299 slice provides it when
 * it wires the loop to the per-server entry. Kept here rather than in #299
 * so the composition is pinned by this slice's `TestClock` coverage.
 */
export function scopedPullLoop<E, R>(
	pull: Effect.Effect<void, E, R>
): Effect.Effect<Fiber.Fiber<number, E>, never, R | Scope.Scope> {
	return pull.pipe(
		Effect.repeat(repullSchedule),
		Effect.retry(pullBackoffSchedule),
		Effect.forkScoped
	);
}
