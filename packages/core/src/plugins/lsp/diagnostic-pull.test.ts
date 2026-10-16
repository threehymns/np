import { describe, expect, it } from 'bun:test';
import { Effect, Fiber, type Scope } from 'effect';
import { TestClock } from 'effect/testing';
import {
	DiagnosticPullCoordinator,
	parseDiagnosticPullSupport,
	parsePullDiagnosticReport
} from './diagnostic-pull';
import {
	LspDiagnosticsStore,
	parsePublishDiagnostics
} from './diagnostics';
import { PULL_RETRY_LIMIT } from './pull-schedules';

/** Runs a TestClock program: time only moves via `TestClock.adjust`, never real sleeps. */
function runTestClock<A, E>(program: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
}

interface RecordedCall {
	readonly server: string;
	readonly uri: string;
	readonly previousResultId: string | undefined;
}

describe('Document pull coordinator and merged store on Effect (#307)', () => {
	const uri = 'file:///repo/src/a.ts';
	const server = 'typescript@/repo';

	it('edit -> debounced pull -> fresh full report merges, and the pull entry wins over a prior push for the same (uri, server)', async () => {
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();

		const seed = parsePublishDiagnostics(server, {
			uri,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
					message: 'old'
				}
			]
		});
		store.publish(seed!);
		expect(store.read(uri).map((d) => d.message)).toEqual(['old']);

		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: (srv, u, previousResultId) => {
				calls.push({ server: srv, uri: u, previousResultId });
				return Effect.succeed({
					kind: 'full',
					resultId: 'r1',
					items: [
						{
							range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
							message: 'pulled'
						}
					]
				});
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('49 millis');
					expect(calls).toHaveLength(0);
					yield* TestClock.adjust('1 millis');
				})
			)
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].previousResultId).toBeUndefined();
		const diagnostics = store.read(uri);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe('pulled');
	});

	it('unchanged report costs nothing and refreshes the result-id cache', async () => {
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();
		let response: unknown = {
			kind: 'full',
			resultId: 'r1',
			items: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
					message: 'initial'
				}
			]
		};

		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: (srv, u, previousResultId) => {
				calls.push({ server: srv, uri: u, previousResultId });
				return Effect.succeed(response);
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].previousResultId).toBeUndefined();
		expect(store.read(uri).map((d) => d.message)).toEqual(['initial']);

		response = { kind: 'unchanged', resultId: 'r2' };
		const revBefore = store.revision;
		let listenerCalls = 0;
		const unsubscribe = store.subscribe(() => {
			listenerCalls++;
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		unsubscribe();
		expect(calls).toHaveLength(2);
		expect(calls[1].previousResultId).toBe('r1');
		expect(store.revision).toBe(revBefore);
		expect(listenerCalls).toBe(0);
		expect(store.read(uri).map((d) => d.message)).toEqual(['initial']);

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(calls).toHaveLength(3);
		expect(calls[2].previousResultId).toBe('r2');
	});

	it('a push for a pulled (uri, server) is dropped; a push for another server still lands', () => {
		const store = new LspDiagnosticsStore();
		const serverA = 'serverA@/repo';
		const serverB = 'serverB@/repo';

		store.pull({
			uri,
			server: serverA,
			diagnostics: [
				{
					server: serverA,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					severity: 'error',
					message: 'pulledA',
					source: 'test',
					code: null
				}
			]
		});

		const revAfterPull = store.revision;
		let listenerCalls = 0;
		store.subscribe(() => {
			listenerCalls++;
		});

		const pushA = parsePublishDiagnostics(serverA, {
			uri,
			diagnostics: [
				{
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
					message: 'pushA'
				}
			]
		});
		store.publish(pushA!);

		expect(store.read(uri).map((d) => d.message)).toEqual(['pulledA']);
		expect(store.revision).toBe(revAfterPull);
		expect(listenerCalls).toBe(0);

		const pushB = parsePublishDiagnostics(serverB, {
			uri,
			diagnostics: [
				{
					range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
					message: 'pushB'
				}
			]
		});
		store.publish(pushB!);

		expect(store.read(uri).map((d) => d.message)).toEqual(['pulledA', 'pushB']);
		expect(store.revision).toBe(revAfterPull + 1);
		expect(listenerCalls).toBe(1);
	});

	it('retries are bounded: a permanently failing server gives up instead of retrying forever', async () => {
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: () => {
				calls.push({ server, uri, previousResultId: undefined });
				return Effect.fail(new Error('boom'));
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('30 seconds');
					// One initial attempt plus PULL_RETRY_LIMIT retries, then silence.
					expect(calls).toHaveLength(PULL_RETRY_LIMIT + 1);
					// Advancing time further issues nothing more.
					yield* TestClock.adjust('30 seconds');
					expect(calls).toHaveLength(PULL_RETRY_LIMIT + 1);
				})
			)
		);
	});

	it('forgetServer drops the result-id cache and interrupts a pending pull', async () => {
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: (srv, u, previousResultId) => {
				calls.push({ server: srv, uri: u, previousResultId });
				return Effect.succeed({ kind: 'full', resultId: 'r1', items: [] });
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('50 millis');
					expect(calls).toHaveLength(1);
					expect(calls[0].previousResultId).toBeUndefined();

					// A pull still waiting out the debounce never requests after the forget.
					yield* coordinator.notifyEdit(uri, server);
					yield* coordinator.forgetServer(server);
					yield* TestClock.adjust('1 second');
					expect(calls).toHaveLength(1);

					// The next pull starts clean: no previousResultId from the dead run.
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(calls).toHaveLength(2);
		expect(calls[1].previousResultId).toBeUndefined();
	});

	it('backoff then stop: failures retry per the backoff schedule, and interrupting mid-backoff issues zero further requests', async () => {
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: (srv, u, previousResultId) => {
				calls.push({ server: srv, uri: u, previousResultId });
				return Effect.fail(new Error('boom'));
			}
		});

		const program = Effect.scoped(
			Effect.gen(function* () {
				const fiber = yield* Effect.scoped(
					Effect.gen(function* () {
						yield* coordinator.notifyEdit(uri, server);
						yield* Effect.never;
					})
				).pipe(Effect.forkChild);
				yield* TestClock.adjust('50 millis');
				yield* TestClock.adjust('500 millis');
				const during = calls.length;
				expect(during).toBeGreaterThan(1);
				yield* Fiber.interrupt(fiber);
				yield* TestClock.adjust('30 seconds');
				expect(calls.length).toBe(during);
			})
		);

		await runTestClock(program);
	});

	it('rapid edits collapse to one pull', async () => {
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: (srv, u, previousResultId) => {
				calls.push({ server: srv, uri: u, previousResultId });
				return Effect.succeed({ kind: 'full', resultId: 'r1', items: [] });
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.notifyEdit(uri, server);
					yield* coordinator.notifyEdit(uri, server);
					yield* coordinator.notifyEdit(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(calls).toHaveLength(1);
	});

	it('parses pull diagnostic reports and diagnostic pull support', () => {
		const full = parsePullDiagnosticReport(server, uri, {
			kind: 'full',
			resultId: 'r1',
			items: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
					message: 'valid',
					severity: 1
				},
				null,
				{ message: 'missing range' }
			]
		});
		expect(full).toEqual({
			uri,
			server,
			resultId: 'r1',
			unchanged: false,
			diagnostics: [
				{
					server,
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
					severity: 'error',
					message: 'valid',
					source: null,
					code: null
				}
			]
		});

		const unchanged = parsePullDiagnosticReport(server, uri, {
			kind: 'unchanged',
			resultId: 'r2'
		});
		expect(unchanged).toEqual({
			uri,
			server,
			resultId: 'r2',
			unchanged: true,
			diagnostics: []
		});

		expect(parsePullDiagnosticReport(server, uri, { kind: 'bogus' })).toBeNull();
		expect(parsePullDiagnosticReport(server, uri, null)).toBeNull();
		expect(parsePullDiagnosticReport(server, uri, undefined)).toBeNull();
		expect(parsePullDiagnosticReport(server, uri, 'text')).toBeNull();
		expect(parsePullDiagnosticReport(server, uri, {})).toBeNull();

		expect(parseDiagnosticPullSupport({ capabilities: { diagnosticProvider: true } })).toBe(true);
		expect(parseDiagnosticPullSupport({ capabilities: { diagnosticProvider: {} } })).toBe(true);
		expect(parseDiagnosticPullSupport({ capabilities: { diagnosticProvider: false } })).toBe(false);
		expect(parseDiagnosticPullSupport({ capabilities: {} })).toBe(false);
		expect(parseDiagnosticPullSupport({ capabilities: null })).toBe(false);
		expect(parseDiagnosticPullSupport({})).toBe(false);
		expect(parseDiagnosticPullSupport(null)).toBe(false);
		expect(parseDiagnosticPullSupport(undefined)).toBe(false);
	});

	it('push-only servers behave exactly as before without pull entries', () => {
		const store = new LspDiagnosticsStore();
		let notifications = 0;
		store.subscribe(() => {
			notifications++;
		});
		const initialRev = store.revision;

		const push = parsePublishDiagnostics(server, {
			uri,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					message: 'push error'
				}
			]
		});
		store.publish(push!);

		expect(store.revision).toBe(initialRev + 1);
		expect(notifications).toBe(1);
		expect(store.read(uri)).toHaveLength(1);

		const cleanPush = parsePublishDiagnostics(server, {
			uri,
			diagnostics: []
		});
		store.publish(cleanPush!);

		expect(store.revision).toBe(initialRev + 2);
		expect(notifications).toBe(2);
		expect(store.read(uri)).toHaveLength(0);
	});
});
