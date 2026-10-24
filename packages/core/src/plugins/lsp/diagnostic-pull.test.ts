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

	/** A push, computed against the given document version. */
	function pushAt(version: number | undefined, message: string) {
		return parsePublishDiagnostics(server, {
			uri,
			...(version === undefined ? {} : { version }),
			diagnostics: [
				{
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
					message
				}
			]
		})!;
	}

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
					yield* coordinator.armPull(uri, server);
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

	it('a pull lands on a path the server pushed to without a version', async () => {
		// The regression the middle branch introduced: a server that pushes
		// without naming the text it looked at must not keep the file on its
		// own answer, or the pull mechanism only works on the servers that
		// happen to name a version on every publish.
		const store = new LspDiagnosticsStore();
		store.publish(pushAt(undefined, 'pushed without a version'));

		const coordinator = new DiagnosticPullCoordinator({
			store,
			versionFor: () => 7,
			request: () =>
				Effect.succeed({
					kind: 'full',
					resultId: 'r1',
					items: [
						{
							range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
							message: 'pulled'
						}
					]
				})
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(store.read(uri).map((d) => d.message)).toEqual(['pulled']);
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
					yield* coordinator.armPull(uri, server);
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
					yield* coordinator.armPull(uri, server);
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
					yield* coordinator.armPull(uri, server);
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

	it('an empty pull clears that server slice and leaves a sibling server alone', async () => {
		const store = new LspDiagnosticsStore();
		const serverB = 'serverB@/repo';
		let response: unknown = {
			kind: 'full',
			resultId: 'r1',
			items: [
				{
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
					message: 'pulledA'
				}
			]
		};

		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: () => Effect.succeed(response)
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

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

		// The next pull says the file is clean, so that server slice goes and
		// the other server findings for the same path stay.
		response = { kind: 'full', resultId: 'r2', items: [] };
		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(store.read(uri).map((d) => d.message)).toEqual(['pushB']);
	});

	it('a failed pull leaves the pushed findings alone', async () => {
		const store = new LspDiagnosticsStore();
		const push = parsePublishDiagnostics(server, {
			uri,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					message: 'pushed'
				}
			]
		});
		store.publish(push!);
		const revAfterPush = store.revision;

		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: () => Effect.fail(new Error('boom'))
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('30 seconds');
				})
			)
		);

		// The pull failed and was given up on, and the pushed findings are
		// still the ones the store holds: a failed request says nothing about
		// the file, so it must not clear what the server did say.
		expect(store.read(uri).map((d) => d.message)).toEqual(['pushed']);
		expect(store.revision).toBe(revAfterPush);
	});

	it('an unusable pull report leaves the pushed findings alone', async () => {
		const store = new LspDiagnosticsStore();
		const push = parsePublishDiagnostics(server, {
			uri,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					message: 'pushed'
				}
			]
		});
		store.publish(push!);
		const revAfterPush = store.revision;

		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: () => Effect.succeed({ kind: 'not-a-report' })
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('30 seconds');
				})
			)
		);

		expect(store.read(uri).map((d) => d.message)).toEqual(['pushed']);
		expect(store.revision).toBe(revAfterPush);
	});

	it('reports a failed pull once, after the retries are spent', async () => {
		// A failed pull leaves the pushed findings alone, so from the outside it
		// looks exactly like a pull that worked. The reason has to reach the
		// Logs tab, or a server that cannot answer pulls is indistinguishable
		// from a server that was never asked.
		const failures: Array<{ server: string; error: unknown }> = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: () => Effect.fail(new Error('boom')),
			onFailure: (failedServer, error) => failures.push({ server: failedServer, error })
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('30 seconds');
				})
			)
		);

		// Once, not once per attempt: the retries are the same failure.
		expect(failures).toHaveLength(1);
		expect(failures[0].server).toBe(server);
		expect((failures[0].error as Error).message).toBe('boom');
	});

	it('does not report an interrupted pull as a failure', async () => {
		// A server that stopped while a pull was in flight has failed nothing,
		// and neither has an edit that replaced the pull with a newer one. A
		// warning for either would be a lie about a server that did its job.
		const failures: string[] = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			// A request that never settles, so the pull is in flight rather than
			// finished: the position the interruption actually happens in.
			request: () => Effect.never,
			onFailure: (failedServer) => failures.push(failedServer)
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
					yield* coordinator.forgetServer(server);
					yield* TestClock.adjust('30 seconds');
				})
			)
		);

		expect(failures).toEqual([]);
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
					yield* coordinator.armPull(uri, server);
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
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
					expect(calls).toHaveLength(1);
					expect(calls[0].previousResultId).toBeUndefined();

					// A pull still waiting out the debounce never requests after the forget.
					yield* coordinator.armPull(uri, server);
					yield* coordinator.forgetServer(server);
					yield* TestClock.adjust('1 second');
					expect(calls).toHaveLength(1);

					// The next pull starts clean: no previousResultId from the dead run.
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(calls).toHaveLength(2);
		expect(calls[1].previousResultId).toBeUndefined();
	});

	it('forgetUri drops only that document\'s result-id cache and interrupts only its pending pull', async () => {
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();
		const otherUri = 'file:///repo/src/b.ts';
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
					// Both documents pull once and cache their result ids.
					yield* coordinator.armPull(uri, server);
					yield* coordinator.armPull(otherUri, server);
					yield* TestClock.adjust('50 millis');
					expect(calls).toHaveLength(2);

					// A pull for uri still waiting out the debounce never
					// requests after the forget; the other document is untouched.
					yield* coordinator.armPull(uri, server);
					yield* coordinator.forgetUri(uri);
					yield* TestClock.adjust('1 second');
					expect(calls).toHaveLength(2);

					// The next pull for uri starts clean, while the other
					// document still sends its cached id.
					yield* coordinator.armPull(uri, server);
					yield* coordinator.armPull(otherUri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(calls).toHaveLength(4);
		const uriCalls = calls.filter((c) => c.uri === uri);
		const otherCalls = calls.filter((c) => c.uri === otherUri);
		expect(uriCalls).toHaveLength(2);
		expect(uriCalls[1].previousResultId).toBeUndefined();
		expect(otherCalls).toHaveLength(2);
		expect(otherCalls[1].previousResultId).toBe('r1');
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
						yield* coordinator.armPull(uri, server);
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
					yield* coordinator.armPull(uri, server);
					yield* coordinator.armPull(uri, server);
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(calls).toHaveLength(1);
	});

	it('a pull armed for a path replaces the pull already in flight for that path', async () => {
		// The debounce collapses pulls that are armed before it elapses, but a
		// pull that is already on the wire is a request the server is answering.
		// The newer one has to replace it rather than race it, or the file
		// ends up with whichever answer happened to land last.
		const calls: RecordedCall[] = [];
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			request: (srv, u, previousResultId) => {
				calls.push({ server: srv, uri: u, previousResultId });
				// The first pull answers late, so a race would show up as its
				// answer landing after the newer pull's.
				return calls.length === 1
					? Effect.sleep('200 millis').pipe(
							Effect.andThen(
								Effect.succeed({
									kind: 'full',
									resultId: 'r1',
									items: [
										{
											range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
											message: 'stale'
										}
									]
								})
							)
						)
					: Effect.succeed({
							kind: 'full',
							resultId: 'r2',
							items: [
								{
									range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
									message: 'fresh'
								}
							]
						});
			}
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
					// The first pull is in flight: the request went out and the
					// server has not answered it yet.
					expect(calls).toHaveLength(1);

					// A newer pull for the same path replaces the one in flight.
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
					expect(calls).toHaveLength(2);

					// The replaced pull's late answer never lands: it was
					// interrupted, so the file keeps the newer pull's findings.
					yield* TestClock.adjust('200 millis');
				})
			)
		);

		expect(store.read(uri).map((d) => d.message)).toEqual(['fresh']);
	});

	it('a pull armed in a scope never goes out when the scope closes first', async () => {
		// The scope is the runtime's own, and closing it is how a runtime that
		// is being torn down stops asking a server anything. A pull still
		// waiting out its debounce is interrupted rather than sent.
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
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						yield* coordinator.armPull(uri, server);
					})
				);
				yield* TestClock.adjust('1 second');
			})
		);

		expect(calls).toHaveLength(0);
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

	it('attributes a pull the version last synced to that server', async () => {
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			versionFor: () => 7,
			request: () =>
				Effect.succeed({
					kind: 'full',
					resultId: 'r1',
					items: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							message: 'pulled'
						}
					]
				})
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		expect(store.read(uri).map((d) => d.message)).toEqual(['pulled']);

		// A push computed against the same revision is refused, and so is one
		// computed against an older revision: two answers about the same text
		// are the same age rather than one older than the other, so the
		// revision is a tie and the source decides — a push never replaces a
		// pull.
		store.publish(pushAt(7, 'pushed at 7'));
		expect(store.read(uri).map((d) => d.message)).toEqual(['pulled']);

		store.publish(pushAt(6, 'pushed at 6'));
		expect(store.read(uri).map((d) => d.message)).toEqual(['pulled']);

		// A push computed against a newer revision takes the slice, and that
		// is what pins the pull's revision at 7: a pull filed at 8 would have
		// refused it, and a pull that named no revision at all would have
		// refused it too, because a push never replaces a pull.
		store.publish(pushAt(8, 'pushed at 8'));
		expect(store.read(uri).map((d) => d.message)).toEqual(['pushed at 8']);
	});

	it('reads the version when the pull is computed, not when it was armed', async () => {
		let version = 3;
		const store = new LspDiagnosticsStore();
		const coordinator = new DiagnosticPullCoordinator({
			store,
			versionFor: () => version,
			request: () =>
				Effect.succeed({
					kind: 'full',
					resultId: 'r1',
					items: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							message: 'pulled'
						}
					]
				})
		});

		await runTestClock(
			Effect.scoped(
				Effect.gen(function* () {
					yield* coordinator.armPull(uri, server);
					// The document moves on while the pull waits out its debounce.
					version = 4;
					yield* TestClock.adjust('50 millis');
				})
			)
		);

		// The pull was computed against version 4: a push at 4 is the same
		// revision, so the source decides and the push is refused, and a push
		// at 3 is older and is refused too.
		store.publish(pushAt(4, 'pushed at 4'));
		expect(store.read(uri).map((d) => d.message)).toEqual(['pulled']);

		store.publish(pushAt(3, 'pushed at 3'));
		expect(store.read(uri).map((d) => d.message)).toEqual(['pulled']);

		// A push at a newer revision lands, and that is what pins the pull's
		// revision at 4: a pull filed at 3 would have let the push at 4
		// through, and a pull filed at 5 would have refused the push at 5.
		store.publish(pushAt(5, 'pushed at 5'));
		expect(store.read(uri).map((d) => d.message)).toEqual(['pushed at 5']);
	});
});
