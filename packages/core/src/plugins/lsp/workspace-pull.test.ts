import { describe, expect, it } from 'bun:test';
import { Clock, Effect, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { LspDiagnosticsStore } from './diagnostics';
import {
	WorkspacePullCoordinator,
	WorkspacePullParseError,
	type WorkspaceDiagnosticParams
} from './workspace-pull';

/**
 * The workspace pull loop (spec #308, #298 §3).
 *
 * A server that answers `workspace/diagnostic` is asked about the whole
 * workspace, not about the file the editor happens to have open, and the answer
 * arrives as a report per path. The loop is what keeps that answer current
 * without asking the server on every keystroke: a pull, then an idle wait, then
 * another pull, and a backoff when the server cannot answer.
 *
 * The timing is asserted on the TestClock, so the cadence is a fact about the
 * code rather than a fact about how fast the machine is.
 */

function runTestClock<A, E>(program: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
}

const server = 'typescript@/repo';
const uri = 'file:///repo/src/a.ts';

function diagnostic(message: string) {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
		severity: 1,
		message
	};
}

/** A workspace report that names one path and one diagnostic on it. */
function fullReport(message: string, resultId: string) {
	return {
		items: [
			{
				uri,
				version: null,
				kind: 'full',
				resultId,
				items: [diagnostic(message)]
			}
		]
	};
}

describe('The workspace pull loop (#308)', () => {
	it('pulls once at once, then once per repull interval', async () => {
		const requests: WorkspaceDiagnosticParams[] = [];
		const coordinator = new WorkspacePullCoordinator({
			store: new LspDiagnosticsStore(),
			request: (_server, params) => {
				requests.push(params);
				return Effect.succeed([]);
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
					expect(requests).toHaveLength(1);

					yield* TestClock.adjust('2 seconds');
					expect(requests).toHaveLength(2);

					yield* TestClock.adjust('2 seconds');
					expect(requests).toHaveLength(3);
				})
			)
		);
	});

	it('lands the workspace report per path in the merged store', async () => {
		const store = new LspDiagnosticsStore();
		const coordinator = new WorkspacePullCoordinator({
			store,
			request: () => Effect.succeed(fullReport('workspace diagnostic', 'r1'))
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
				})
			)
		);

		expect(store.read(uri).map((d) => d.message)).toEqual(['workspace diagnostic']);
	});

	it('carries the previous result ids into the next pull', async () => {
		const requests: WorkspaceDiagnosticParams[] = [];
		const coordinator = new WorkspacePullCoordinator({
			store: new LspDiagnosticsStore(),
			request: (_server, params) => {
				requests.push(params);
				return Effect.succeed(fullReport('workspace diagnostic', 'r1'));
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
					yield* TestClock.adjust('2 seconds');
				})
			)
		);

		expect(requests).toHaveLength(2);
		expect(requests[0].previousResultIds).toEqual([]);
		expect(requests[1].previousResultIds).toEqual([{ uri, value: 'r1' }]);
		// A token per pull, so the server's partial results can be told apart.
		expect(requests[0].partialResultToken).toBeDefined();
		expect(requests[1].partialResultToken).not.toBe(requests[0].partialResultToken);
	});

	it('backs off when a pull fails, and keeps trying', async () => {
		const stamps: number[] = [];
		const failures: string[] = [];
		const coordinator = new WorkspacePullCoordinator({
			store: new LspDiagnosticsStore(),
			request: () =>
				Effect.gen(function* () {
					stamps.push(yield* Clock.currentTimeMillis);
					return yield* Effect.fail(new Error('boom'));
				}),
			onFailure: (failed, _error) => failures.push(failed)
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('2 seconds');
				})
			)
		);

		// The retries are spaced by the backoff, not immediate: 50 ms, then 100 ms,
		// each jittered, and never more than the 1 s cap.
		expect(stamps.length).toBeGreaterThan(3);
		const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
		expect(gaps[0]).toBeLessThanOrEqual(60);
		expect(gaps[1]).toBeGreaterThanOrEqual(80);
		for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1000);
		// One failure, not one per attempt: the retries are the same failure.
		expect(failures).toEqual([server]);
	});

	it('a storm of refresh signals produces one repull', async () => {
		const requests: WorkspaceDiagnosticParams[] = [];
		const coordinator = new WorkspacePullCoordinator({
			store: new LspDiagnosticsStore(),
			request: (_server, params) => {
				requests.push(params);
				return Effect.succeed([]);
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
					const before = requests.length;

					for (let i = 0; i < 10; i++) yield* coordinator.notifyRefresh(server);
					yield* TestClock.adjust('1 millis');

					expect(requests).toHaveLength(before + 1);
				})
			)
		);
	});

	it('stopping the server ends the loop with zero further requests', async () => {
		const requests: WorkspaceDiagnosticParams[] = [];
		const coordinator = new WorkspacePullCoordinator({
			store: new LspDiagnosticsStore(),
			request: (_server, params) => {
				requests.push(params);
				return Effect.succeed([]);
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
					const before = requests.length;

					yield* coordinator.stop(server);
					yield* TestClock.adjust('30 seconds');

					expect(requests).toHaveLength(before);
				})
			)
		);
	});

	it('closing the scope ends the loop with zero further requests', async () => {
		const requests: WorkspaceDiagnosticParams[] = [];
		const coordinator = new WorkspacePullCoordinator({
			store: new LspDiagnosticsStore(),
			request: (_server, params) => {
				requests.push(params);
				return Effect.succeed([]);
			}
		});

		await runTestClock(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				yield* coordinator.start(server).pipe(Effect.provideService(Scope.Scope, scope));
				yield* TestClock.adjust('1 millis');
				const before = requests.length;

				yield* Scope.close(scope, undefined as never);
				yield* TestClock.adjust('30 seconds');

				expect(requests).toHaveLength(before);
			})
		);
	});

	it('files a partial result that names the pull in flight, and drops one that does not', async () => {
		// The token is what says whose result it is: a server streams the
		// report while it works, and a value that names another pull is not a
		// result of this one.
		const store = new LspDiagnosticsStore();
		const coordinator = new WorkspacePullCoordinator({
			store,
			request: (_server, params) =>
				Effect.gen(function* () {
					coordinator.acceptPartialResult(
						server,
						params.partialResultToken,
						fullReport('partial', 'r1')
					);
					coordinator.acceptPartialResult(server, 'another-pull', fullReport('stray', 'r2'));
					return yield* Effect.succeed({ items: [] });
				})
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
				})
			)
		);

		expect(store.read(uri).map((d) => d.message)).toEqual(['partial']);
	});

	it('takes an answer of nothing as nothing to file, not as a failure', async () => {
		// A server with nothing new to say says so, and there is nothing to
		// file and nothing to complain about.
		const failures: string[] = [];
		const coordinator = new WorkspacePullCoordinator({
			store: new LspDiagnosticsStore(),
			request: () => Effect.succeed(null),
			onFailure: (failed) => failures.push(failed)
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
				})
			)
		);

		expect(failures).toEqual([]);
	});

	it('fails the pull on a report it cannot use, rather than filing half of it', async () => {
		const failures: unknown[] = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new WorkspacePullCoordinator({
			store,
			request: () => Effect.succeed({ items: 'not a list' }),
			onFailure: (_failed, error) => failures.push(error)
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.start(server);
					yield* TestClock.adjust('1 millis');
				})
			)
		);

		expect(store.read(uri)).toEqual([]);
		expect(failures[0]).toBeInstanceOf(WorkspacePullParseError);
	});
});
