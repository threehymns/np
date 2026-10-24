import { Deferred, Effect, Exit, Scope } from 'effect';
import { parseDiagnostic, type LspDiagnostic, type LspDiagnosticsStore } from './diagnostics';
import { pullWithBackoff, WORKSPACE_PULL_REPULL_INTERVAL } from './pull-schedules';

/**
 * The workspace pull loop (spec #308, #298 §3).
 *
 * A server that answers `workspace/diagnostic` is asked about the whole
 * workspace rather than about the file the editor happens to have open, and it
 * answers with a report per path. That is the only way an unopened file gets
 * diagnostics at all, and the loop is what keeps the answer current without
 * asking the server on every keystroke.
 *
 * The loop is per server, and it is owned by a scope: a server that stops
 * ends its own loop and leaves every other server's alone, and a runtime that
 * is disposed ends all of them. The scope is the teardown, so a pull that was
 * in flight when the server went away is interrupted rather than filed.
 *
 * The timing is the one ADR 0023 and `pull-schedules.ts` already hold: the pull
 * is retried with a jittered exponential backoff, and the loop waits the idle
 * repull interval between pulls. The one thing the schedule cannot express is
 * the refresh: a server that asks for one wants the pull *now*, not after the
 * interval, so the wait is cut short by a signal rather than merely accompanied
 * by one.
 */

export interface WorkspaceDiagnosticParams {
	/**
	 * The result ids the server gave for these paths last time, per URI.
	 *
	 * The server compares them against its own state and answers "unchanged"
	 * for a path it has nothing new to say about, which is what keeps the
	 * repull cheap. The protocol's own shape is a list of uri/value pairs,
	 * one per path the client has a result id for.
	 */
	readonly previousResultIds: readonly WorkspacePreviousResultId[];
	/**
	 * The token the server may use to send partial results while it works.
	 *
	 * A workspace report can take a while to compute, and a server that streams
	 * it says so with `$/progress` notifications carrying this token.
	 */
	readonly partialResultToken: string;
}

/** One path's result id from the last report, as the protocol carries it. */
export interface WorkspacePreviousResultId {
	readonly uri: string;
	readonly value: string;
}

export interface WorkspacePullDependencies {
	/**
	 * The `workspace/diagnostic` request itself, at the protocol boundary.
	 *
	 * The failure is the caller's: a server that cannot answer is a server the
	 * loop backs off from, not one the loop dies on.
	 */
	readonly request: (
		server: string,
		params: WorkspaceDiagnosticParams
	) => Effect.Effect<unknown, unknown>;
	/** Where the diagnostics are filed, one path at a time. */
	readonly store: LspDiagnosticsStore;
	/**
	 * Whether a URI may receive workspace-pulled diagnostics, mirroring the
	 * `editor.lsp` gate the push path applies in `onNotification`. A URI the
	 * gate rejects is skipped before its result id is recorded or its
	 * diagnostics are filed, and any remembered result id for it is dropped
	 * so a later pull starts clean.
	 */
	readonly accepts?: (uri: string) => boolean;
	/**
	 * Called once when a pull fails, so the reason reaches the Logs tab. A
	 * failed pull says nothing about the files, so the diagnostics that are
	 * already filed stay exactly as they are.
	 */
	readonly onFailure?: (server: string, error: unknown) => void;
}

/** One path's answer inside a workspace report. */
export interface WorkspacePullEntry {
	readonly uri: string;
	/** Absent when the server named no result id for the path. */
	readonly resultId: string | undefined;
	/** True when the server said the path is unchanged since the last report. */
	readonly unchanged: boolean;
	readonly diagnostics: readonly LspDiagnostic[];
}

export class WorkspacePullParseError extends Error {
	readonly _tag = 'WorkspacePullParseError';
	constructor(server: string) {
		super(`Language server "${server}" returned an unusable workspace/diagnostic response.`);
		this.name = 'WorkspacePullParseError';
	}
}

/**
 * Reads `capabilities.diagnosticProvider.workspaceDiagnostics` out of an
 * `initialize` result, total over JSON.
 *
 * The server's own to say, and the whole of whether it is asked: a server
 * that does not announce the workspace pull is never asked about the
 * workspace, so the pull machinery is off for it rather than merely empty.
 */
export function parseWorkspaceDiagnosticSupport(result: unknown): boolean {
	if (typeof result !== 'object' || result === null) return false;
	const capabilities = (result as Record<string, unknown>).capabilities;
	if (typeof capabilities !== 'object' || capabilities === null) return false;
	const provider = (capabilities as Record<string, unknown>).diagnosticProvider;
	if (typeof provider !== 'object' || provider === null) return false;
	return (provider as Record<string, unknown>).workspaceDiagnostics === true;
}

/**
 * Reads a `workspace/diagnostic` answer: the report a request answers with,
 * or the one a partial result carries.
 *
 * Total over JSON, like every other parser here: a shape the server made up
 * is not a report, and the caller turns that into a failure rather than
 * filing half of it. An answer of nothing at all is not a failure though: a
 * server with nothing new to say says so, and there is nothing to file and
 * nothing to complain about.
 */
export function parseWorkspaceDiagnosticReports(
	server: string,
	payload: unknown
): WorkspacePullEntry[] | null {
	if (payload === null || payload === undefined) return [];
	const reports = Array.isArray(payload) ? payload : [payload];
	const entries: WorkspacePullEntry[] = [];
	for (const report of reports) {
		if (typeof report !== 'object' || report === null) return null;
		const record = report as Record<string, unknown>;
		// The whole workspace is unchanged: nothing to file, and the result id
		// it names belongs to no path.
		if (record.kind === 'unchanged') continue;
		if (!Array.isArray(record.items)) return null;
		for (const item of record.items) {
			const entry = parseWorkspaceDocumentReport(server, item);
			if (entry) entries.push(entry);
		}
	}
	return entries;
}

/**
 * Reads one path's report out of a workspace report.
 *
 * A path the server named without a usable shape is dropped rather than
 * failing the whole report: the other paths in it are still good news.
 */
function parseWorkspaceDocumentReport(server: string, item: unknown): WorkspacePullEntry | null {
	if (typeof item !== 'object' || item === null) return null;
	const record = item as Record<string, unknown>;
	if (typeof record.uri !== 'string' || record.uri.length === 0) return null;
	const resultId = typeof record.resultId === 'string' ? record.resultId : undefined;
	if (record.kind === 'unchanged') {
		return { uri: record.uri, resultId, unchanged: true, diagnostics: [] };
	}
	const raw = Array.isArray(record.items) ? record.items : [];
	const diagnostics: LspDiagnostic[] = [];
	for (const entry of raw) {
		const diagnostic = parseDiagnostic(server, entry);
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return { uri: record.uri, resultId, unchanged: false, diagnostics };
}

/** One server's loop: the scope it is forked on, and what it remembers. */
interface ServerLoop {
	/** The scope the loop is forked on: closing it ends the loop. */
	readonly scope: Scope.Closeable;
	/** The result id per path, for the next request's `previousResultIds`. */
	readonly resultIds: Map<string, string>;
	/** Whether a refresh is waiting to be honoured. */
	refreshPending: boolean;
	/** The deferred the repull wait is parked on, so a refresh can cut it short. */
	wake: Deferred.Deferred<void> | null;
	/** The token of the pull in flight, for the partial results it may send. */
	token: string | null;
	/** Whether the failure that is being retried has already been reported. */
	reported: boolean;
	/** Counts the pulls, so every pull asks under a token of its own. */
	pulls: number;
}

export class WorkspacePullCoordinator {
	private readonly servers = new Map<string, ServerLoop>();

	constructor(private readonly deps: WorkspacePullDependencies) {}

	/**
	 * Starts one server's loop, on a scope of its own.
	 *
	 * The scope is a child of the caller's, so closing the caller's scope ends
	 * this loop too, and closing this one ends the loop without touching any
	 * other server's.
	 */
	start(server: string): Effect.Effect<void, never, Scope.Scope> {
		const self = this;
		return Effect.gen(function* () {
			const parent = yield* Scope.Scope;
			const previous = self.servers.get(server);
			if (previous) yield* Scope.close(previous.scope, Exit.void);
			const scope = yield* Scope.fork(parent);
			const state: ServerLoop = {
				scope,
				resultIds: new Map(),
				refreshPending: false,
				wake: null,
				token: null,
				reported: false,
				pulls: 0
			};
			self.servers.set(server, state);
			yield* Effect.forkScoped(self.loop(server, state)).pipe(
				Effect.provideService(Scope.Scope, scope)
			);
		});
	}

	/**
	 * Ends one server's loop, and forgets what it remembered.
	 *
	 * The result ids go with the server: a restarted server must not be handed
	 * the result id of the process that died.
	 */
	stop(server: string): Effect.Effect<void> {
		const self = this;
		return Effect.gen(function* () {
			const state = self.servers.get(server);
			if (!state) return;
			self.servers.delete(server);
			yield* Scope.close(state.scope, Exit.void);
		});
	}

	/**
	 * The server asked for a refresh: the repull wait is cut short and the
	 * pull comes now.
	 *
	 * A storm of refreshes is one repull. The signal is a latch rather than a
	 * queue: the first refresh wakes the wait, and the ones that follow it
	 * before the pull has run are the same request, asked once.
	 */
	notifyRefresh(server: string): Effect.Effect<void> {
		const self = this;
		return Effect.gen(function* () {
			const state = self.servers.get(server);
			if (!state) return;
			state.refreshPending = true;
			const wake = state.wake;
			if (!wake) return;
			state.wake = null;
			yield* Deferred.succeed(wake, undefined);
		});
	}

	/**
	 * Files a partial result the server sent for the pull in flight.
	 *
	 * A token that names no pull in flight is not a result of ours: the server
	 * may be streaming a pull that has already finished, or one that was
	 * abandoned with its server.
	 */
	acceptPartialResult(server: string, token: string, payload: unknown): void {
		const state = this.servers.get(server);
		if (!state || state.token !== token) return;
		const entries = parseWorkspaceDiagnosticReports(server, payload);
		if (!entries) return;
		this.file(server, entries, state);
	}

	/**
	 * The loop: a pull, then the repull wait, then a pull again.
	 *
	 * The pull is retried with the backoff schedule until it succeeds, so a
	 * server that cannot answer is waited for rather than given up on.
	 */
	private loop(server: string, state: ServerLoop): Effect.Effect<void> {
		const self = this;
		return Effect.gen(function* () {
			for (;;) {
				yield* pullWithBackoff(self.pullOnce(server, state)).pipe(Effect.ignore);
				yield* self.waitForTrigger(state);
				// The loop yields before it pulls again. A burst of refresh
				// signals that lands in the same turn is one pull rather than
				// one pull each, which is the whole of what the coalescing is:
				// the signals that arrive while the loop is on its way to the
				// wire are the same request, asked once.
				yield* Effect.yieldNow;
			}
		});
	}

	/**
	 * The repull wait: the idle interval, or a refresh, whichever comes first.
	 *
	 * A refresh that lands while the wait is running wakes it, and one that
	 * lands while a pull is running is remembered and honoured by the wait
	 * that follows, so no refresh is lost and none is counted twice.
	 */
	private waitForTrigger(state: ServerLoop): Effect.Effect<void> {
		return Effect.gen(function* () {
			if (state.refreshPending) {
				state.refreshPending = false;
				return;
			}
			const wake = yield* Deferred.make<void>();
			state.wake = wake;
			yield* Effect.race(
				Effect.sleep(WORKSPACE_PULL_REPULL_INTERVAL),
				Deferred.await(wake)
			);
			state.wake = null;
		});
	}

	/**
	 * One pull: the request, and what its answer says.
	 *
	 * A failure is reported once, not once per attempt: the retries are the
	 * same failure, and a server that cannot answer is worth one line in the
	 * Logs tab rather than one per attempt.
	 */
	private pullOnce(server: string, state: ServerLoop): Effect.Effect<void, unknown> {
		const self = this;
		return Effect.gen(function* () {
			// The pull that starts now covers every refresh that landed before
			// it, so the pending flag is consumed here and not after the answer.
			state.refreshPending = false;
			state.pulls++;
			const token = `workspace-pull:${server}:${state.pulls}`;
			state.token = token;
			const raw = yield* self.deps
				.request(server, {
					previousResultIds: [...state.resultIds].map(([uri, value]) => ({ uri, value })),
					partialResultToken: token
				})
				.pipe(
					Effect.tapError((error) =>
						Effect.sync(() => {
							self.reportFailure(server, state, error);
						})
					),
					// The token is the pull in flight, and the pull is over
					// when the request is: a partial result that arrives
					// after it belongs to a pull that is not running, and
					// filing it would file a report for a question that
					// was never asked.
					Effect.ensuring(
						Effect.sync(() => {
							state.token = null;
						})
					)
				);
			const entries = parseWorkspaceDiagnosticReports(server, raw);
			if (!entries) {
				const error = new WorkspacePullParseError(server);
				self.reportFailure(server, state, error);
				return yield* Effect.fail(error);
			}
			state.reported = false;
			self.file(server, entries, state);
		});
	}

	/**
	 * Files the report, one path at a time, and remembers the result ids.
	 *
	 * A path the server called unchanged keeps the diagnostics that are already
	 * filed for it: there is nothing new to say about it, which is not the
	 * same as there being nothing wrong with it.
	 */
	private file(server: string, entries: readonly WorkspacePullEntry[], state: ServerLoop): void {
		for (const entry of entries) {
			if (this.deps.accepts && !this.deps.accepts(entry.uri)) {
				state.resultIds.delete(entry.uri);
				continue;
			}
			if (entry.resultId !== undefined) state.resultIds.set(entry.uri, entry.resultId);
			if (entry.unchanged) continue;
			this.deps.store.workspacePull({
				uri: entry.uri,
				server,
				diagnostics: entry.diagnostics
			});
		}
	}

	private reportFailure(server: string, state: ServerLoop, error: unknown): void {
		if (state.reported) return;
		state.reported = true;
		this.deps.onFailure?.(server, error);
	}
}
