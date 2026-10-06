import { describe, expect, it } from 'bun:test';
import { Cause, Deferred, Effect, Exit, Fiber, Option, Result, Schedule } from 'effect';
import { TestClock } from 'effect/testing';
import {
	timeoutFailEffect,
	timeoutOptionEffect
} from './effect-timeouts';
import { pullBackoffSchedule, pullWithBackoff, repullSchedule, scopedPullLoop } from './pull-schedules';

class DomainTimeout extends Error {
	readonly _tag = 'DomainTimeout';
	constructor() {
		super('domain timeout');
		this.name = 'DomainTimeout';
	}
}

/** Runs a TestClock program: time only moves via `TestClock.adjust`, never real sleeps. */
function runTestClock<A, E>(program: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
}

describe('Effect v4 timeouts, on TestClock (#302)', () => {
	it('fails with the domain error when the bound lapses, and runs cleanup', async () => {
		let cleaned = 0;
		const program = Effect.gen(function* () {
			const fiber = yield* timeoutFailEffect(
				Effect.never,
				100,
				() => {
					cleaned++;
				},
				() => new DomainTimeout()
			).pipe(Effect.forkChild);
			yield* TestClock.adjust('100 millis');
			return yield* Fiber.await(fiber);
		});
		const exit = await runTestClock(program);
		expect(cleaned).toBe(1);
		expect(Exit.isFailure(exit)).toBe(true);
		if (!Exit.isFailure(exit)) throw new Error('expected the timeout to fail');
		const found = Cause.findFail(exit.cause);
		expect(Result.isSuccess(found)).toBe(true);
		if (Result.isSuccess(found)) {
			expect(found.success.error).toBeInstanceOf(DomainTimeout);
		}
	});

	it('passes the value through when the effect beats the bound', async () => {
		let cleaned = 0;
		const program = Effect.gen(function* () {
			const fiber = yield* timeoutFailEffect(
				Effect.succeed('fast'),
				100,
				() => {
					cleaned++;
				},
				() => new DomainTimeout()
			).pipe(Effect.forkChild);
			yield* TestClock.adjust('100 millis');
			return yield* Fiber.join(fiber);
		});
		expect(await runTestClock(program)).toBe('fast');
		expect(cleaned).toBe(0);
	});

	it('resolves None on expiry instead of failing, Some on time', async () => {
		const late = Effect.gen(function* () {
			const fiber = yield* timeoutOptionEffect(Effect.never, 50).pipe(Effect.forkChild);
			yield* TestClock.adjust('50 millis');
			return yield* Fiber.join(fiber);
		});
		expect(Option.isNone(await runTestClock(late))).toBe(true);

		const early = Effect.gen(function* () {
			const fiber = yield* timeoutOptionEffect(Effect.succeed(7), 50).pipe(Effect.forkChild);
			yield* TestClock.adjust('50 millis');
			return yield* Fiber.join(fiber);
		});
		const won = await runTestClock(early);
		expect(Option.isSome(won)).toBe(true);
		expect(Option.getOrThrow(won)).toBe(7);
	});

	it('a Deferred waiter unblocks by TestClock, not by sleeping', async () => {
		const program = Effect.gen(function* () {
			const gate = yield* Deferred.make<string>();
			const fiber = yield* timeoutOptionEffect(Deferred.await(gate), 60).pipe(Effect.forkChild);
			yield* TestClock.adjust('30 millis');
			yield* Deferred.succeed(gate, 'answer');
			return yield* Fiber.join(fiber);
		});
		const won = await runTestClock(program);
		expect(Option.getOrNull(won)).toBe('answer');
	});
});

describe('Pull schedules, on TestClock (#302)', () => {
	it('repull cadence repeats on the 2 s interval without overlap', async () => {
		let runs = 0;
		const program = Effect.gen(function* () {
			const fiber = yield* Effect.sync(() => {
				runs++;
			}).pipe(
				Effect.repeat(Schedule.spaced('2 seconds').pipe(Schedule.upTo({ times: 2 }))),
				Effect.forkChild
			);
			yield* TestClock.adjust('4 seconds');
			yield* Fiber.join(fiber);
		});
		await runTestClock(program);
		expect(runs).toBe(3);
		expect(repullSchedule).toBeDefined();
	});

	it('backoff retries a flaky pull until it succeeds', async () => {
		let attempts = 0;
		const program = Effect.gen(function* () {
			const fiber = yield* pullWithBackoff(
				Effect.sync(() => {
					attempts++;
				}).pipe(
					Effect.flatMap(() =>
						attempts < 3 ? Effect.fail('boom' as const) : Effect.void
					)
				)
			).pipe(Effect.forkChild);
			yield* TestClock.adjust('10 seconds');
			yield* Fiber.join(fiber);
		});
		await runTestClock(program);
		expect(attempts).toBe(3);
		expect(pullBackoffSchedule).toBeDefined();
	});

	it('scoped loop repulls on cadence and dies with its scope', async () => {
		let runs = 0;
		const program = Effect.scoped(
			Effect.gen(function* () {
				yield* scopedPullLoop(
					Effect.sync(() => {
						runs++;
					})
				);
				yield* TestClock.adjust('4 seconds');
			})
		);
		await runTestClock(program);
		// Initial run plus one per 2 s interval; leaving the scope interrupts
		// the fiber, so nothing runs after.
		expect(runs).toBe(3);
	});
});
