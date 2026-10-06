import { Duration, Effect, Option } from 'effect';

/**
 * The three hand-rolled `Promise.race` sites in `client.ts`, now driven by
 * Effect v4 (ticket #302, research #301).
 *
 * v4 note: `Effect.timeoutFail` no longer exists (it did in 3.x). The domain
 * error is carried by `Effect.timeoutOrElse` with `orElse` failing instead —
 * same shape, one combinator rather than two. `Effect.timeoutOption` is
 * unchanged from 3.x.
 *
 * Two layers, deliberately:
 *
 * - `*Effect` programs take an `Effect` and are what `TestClock` tests drive.
 *   Time here is the injectable `Clock` service, so `TestClock.adjust` moves it
 *   deterministically with no real sleeps.
 * - `withTimeout` / `settleWithin` take a `Promise` and are what `LspClient`
 *   calls. They lift the promise with `Effect.tryPromise` and run the same
 *   program on the live clock, keeping the client's public shape (same request
 *   shapes, same `LspTimeoutError`) while removing every direct `setTimeout`
 *   and `Promise.race` from `@np/core`.
 *
 * Honest limit, carried over from #301 §2: Effect interrupts the *wait*, not
 * the wire. JSON-RPC has no cancel for an arbitrary in-flight request, so a
 * timed-out completion is still answered and dropped, as before. The win is
 * deterministic cleanup of the waiter, not protocol cancellation.
 *
 * Nothing here imports `@effect/platform` or any Node global: time goes
 * through Effect's `Clock`, and the promise lift never touches `process`.
 */

/**
 * Fails with the caller's domain error when the effect outlives the bound.
 * The v4 spelling of 3.x `Effect.timeoutFail`: `timeoutOrElse` failing.
 */
export function timeoutFailEffect<A, E>(
	self: Effect.Effect<A, E>,
	timeoutMs: number,
	onTimeout: () => void,
	makeError: () => E
): Effect.Effect<A, E> {
	return self.pipe(
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () =>
				Effect.sync(() => {
					onTimeout();
				}).pipe(Effect.flatMap(() => Effect.fail(makeError())))
		})
	);
}

/**
 * Resolves `Option.none` on expiry instead of failing — the `settleWithin`
 * shape ("a late answer to a default-none question is the same answer as no
 * answer"), typed instead of nullable.
 */
export function timeoutOptionEffect<A, E>(
	self: Effect.Effect<A, E>,
	timeoutMs: number
): Effect.Effect<Option.Option<A>, E> {
	return self.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
}

/**
 * `request()`'s bound, Promise in / Promise out. Same contract as the
 * hand-rolled `withTimeout` it replaces: on expiry `onTimeout` runs (the
 * pending-map delete) and the caller sees `makeError()`.
 */
export async function withTimeout<T>(
	settled: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void,
	makeError: () => Error
): Promise<T> {
	return Effect.runPromise(
		timeoutFailEffect(
			Effect.tryPromise(() => settled),
			timeoutMs,
			onTimeout,
			makeError
		) as Effect.Effect<T, unknown>
	);
}

/**
 * A value, or null when it did not arrive in time. Same contract as the
 * hand-rolled `settleWithin` it replaces: never fails, unlike
 * {@link withTimeout}.
 */
export async function settleWithin<T>(pending: Promise<T>, timeoutMs: number): Promise<T | null> {
	const option = await Effect.runPromise(
		timeoutOptionEffect(
			Effect.tryPromise(() => pending),
			timeoutMs
		) as Effect.Effect<Option.Option<T>, unknown>
	);
	return Option.getOrNull(option);
}

/**
 * `true` when the exit promise settles first, `false` on expiry. Same
 * contract as `LspClient.waitForExit`: bounded, never throws.
 */
export async function settleExit(exit: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	const option = await Effect.runPromise(
		timeoutOptionEffect(
			Effect.tryPromise(() => exit),
			timeoutMs
		) as Effect.Effect<Option.Option<unknown>, unknown>
	);
	return Option.isSome(option);
}
