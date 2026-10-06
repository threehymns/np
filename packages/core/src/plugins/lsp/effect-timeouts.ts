import { Duration, Effect, Option } from 'effect';

/**
 * Effect v4 timeouts for `client.ts`.
 *
 * Honest limit: Effect interrupts the *wait*, not the wire — a timed-out
 * request is still answered and dropped. Time goes through Effect's `Clock`;
 * nothing here imports `@effect/platform` or any Node global.
 */

/**
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

export function timeoutOptionEffect<A, E>(
	self: Effect.Effect<A, E>,
	timeoutMs: number
): Effect.Effect<Option.Option<A>, E> {
	return self.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
}

/**
 * On expiry runs `onTimeout` (pending-map delete) and fails with `makeError()`.
 */
export async function withTimeout<T>(
	settled: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void,
	makeError: () => Error
): Promise<T> {
	return Effect.runPromise(
		timeoutFailEffect(
			Effect.tryPromise({
				try: () => settled,
				catch: (error) => error
			}),
			timeoutMs,
			onTimeout,
			makeError
		) as Effect.Effect<T, unknown>
	);
}

/**
 * Never fails, unlike `withTimeout`: absent in time reads as `null`.
 */
export async function settleWithin<T>(pending: Promise<T>, timeoutMs: number): Promise<T | null> {
	const option = await Effect.runPromise(
		timeoutOptionEffect(
			Effect.tryPromise({
				try: () => pending,
				catch: (error) => error
			}),
			timeoutMs
		) as Effect.Effect<Option.Option<T>, unknown>
	);
	return Option.getOrNull(option);
}

/**
 * Bounded, never throws.
 */
export async function settleExit(exit: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	const option = await Effect.runPromise(
		timeoutOptionEffect(
			Effect.tryPromise({
				try: () => exit,
				catch: (error) => error
			}),
			timeoutMs
		) as Effect.Effect<Option.Option<unknown>, unknown>
	);
	return Option.isSome(option);
}
