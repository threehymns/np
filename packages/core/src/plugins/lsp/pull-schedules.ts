import { Duration, Effect, Schedule, type Fiber, type Scope } from 'effect';

/**
 * Workspace-pull policy only — no loop starts here, no document opens.
 */

/** Zed's 2 s repull idle (`WORKSPACE_DIAGNOSTICS_REPULL_DELAY`, #298 §3). */
export const WORKSPACE_PULL_REPULL_INTERVAL = Duration.seconds(2);

/** Zed's backoff base, `50 * 2^attempts` ms (#298 §3). */
export const WORKSPACE_PULL_BACKOFF_BASE = Duration.millis(50);

/** Zed's backoff clamp, 30–1000 ms (#298 §3). The floor is the first delay. */
export const WORKSPACE_PULL_BACKOFF_MAX = Duration.millis(1000);

/**
 * When one pull overruns the interval the next runs immediately after, without pile-up.
 */
export const repullSchedule: Schedule.Schedule<number> = Schedule.spaced(
	WORKSPACE_PULL_REPULL_INTERVAL
);

/**
 * Jittered exponential backoff, capped at 1 s while retrying indefinitely.
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
 * Re-runs `pull` while it fails, waiting per `pullBackoffSchedule`.
 */
export function pullWithBackoff<E, R>(
	pull: Effect.Effect<void, E, R>
): Effect.Effect<void, E, R> {
	return pull.pipe(Effect.retry(pullBackoffSchedule));
}

/**
 * Requires an ambient `Scope` (the entry's): leaving it interrupts the fiber.
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
