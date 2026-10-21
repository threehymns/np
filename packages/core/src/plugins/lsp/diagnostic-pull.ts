import { Duration, Effect, Fiber, type Scope } from 'effect';
import {
	parseDiagnostic,
	type LspDiagnostic,
	type LspDiagnosticsStore
} from './diagnostics';
import { boundedPullRetrySchedule } from './pull-schedules';

export interface LspPullReport {
	readonly uri: string;
	readonly server: string;
	/** Present on full reports; refreshed (not cleared) on unchanged reports. */
	readonly resultId: string | undefined;
	readonly unchanged: boolean;
	/** Empty when unchanged. */
	readonly diagnostics: readonly LspDiagnostic[];
}

/**
 * Parses a server response to `textDocument/diagnostic`.
 * Unusable kind values return null, while malformed items in full reports are dropped.
 */
export function parsePullDiagnosticReport(
	server: string,
	uri: string,
	result: unknown
): LspPullReport | null {
	if (typeof result !== 'object' || result === null) return null;
	const raw = result as Record<string, unknown>;
	if (typeof raw.kind !== 'string') return null;

	if (raw.kind === 'full') {
		const items = Array.isArray(raw.items) ? raw.items : [];
		const diagnostics: LspDiagnostic[] = [];
		for (const item of items) {
			const diagnostic = parseDiagnostic(server, item);
			if (diagnostic) diagnostics.push(diagnostic);
		}
		const resultId = typeof raw.resultId === 'string' ? raw.resultId : undefined;
		return { uri, server, resultId, unchanged: false, diagnostics };
	}

	if (raw.kind === 'unchanged') {
		const resultId = typeof raw.resultId === 'string' ? raw.resultId : undefined;
		return { uri, server, resultId, unchanged: true, diagnostics: [] };
	}

	return null;
}

/**
 * Reads `capabilities.diagnosticProvider` off an `initialize` result, total over JSON.
 * `true` or any object means the server answers `textDocument/diagnostic`; anything
 * else means it does not.
 */
export function parseDiagnosticPullSupport(result: unknown): boolean {
	if (typeof result !== 'object' || result === null) return false;
	const capabilities = (result as Record<string, unknown>).capabilities;
	if (typeof capabilities !== 'object' || capabilities === null) return false;
	const provider = (capabilities as Record<string, unknown>).diagnosticProvider;
	if (provider === true) return true;
	if (typeof provider === 'object' && provider !== null) return true;
	return false;
}

export interface DiagnosticPullRequest {
	(server: string, uri: string, previousResultId: string | undefined): Effect.Effect<unknown, unknown>;
}

export interface DiagnosticPullDependencies {
	readonly request: DiagnosticPullRequest;
	readonly store: LspDiagnosticsStore;
	/**
	 * Called once when a pull ends in failure, so the reason reaches the Logs
	 * tab. A failed pull leaves the pushed findings alone, which from the
	 * outside is indistinguishable from a pull that worked.
	 */
	readonly onFailure?: (server: string, error: unknown) => void;
}

/**
 * 50ms editor debounce from the pull contract (#298).
 * Coalesces rapid keystrokes to prevent flooding the server with pull requests.
 */
export const DIAGNOSTIC_PULL_DEBOUNCE = Duration.millis(50);

export class PullParseError extends Error {
	readonly _tag = 'PullParseError';
	constructor(server: string) {
		super(`Language server "${server}" returned an unusable textDocument/diagnostic response.`);
		this.name = 'PullParseError';
	}
}

export class DiagnosticPullCoordinator {
	private readonly pending = new Map<string, Map<string, Fiber.Fiber<void, never>>>();
	private readonly resultIds = new Map<string, Map<string, string>>();

	constructor(private readonly deps: DiagnosticPullDependencies) {}

	/**
	 * Arms a debounced pull for one (uri, server), on the caller's Scope.
	 * A newer edit interrupts the still-pending pull for the same key, so rapid
	 * edits collapse to one request. Closing the scope interrupts everything,
	 * including a pull sleeping mid-backoff: no further requests are issued.
	 * Requires an ambient Scope (same contract as scopedPullLoop).
	 */
	notifyEdit(uri: string, server: string): Effect.Effect<void, never, Scope.Scope> {
		const self = this;
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				let serverPulls = self.pending.get(server);
				if (!serverPulls) {
					serverPulls = new Map();
					self.pending.set(server, serverPulls);
				}
				const prior = serverPulls.get(uri);
				if (prior) {
					yield* restore(Fiber.interrupt(prior));
				}
				const pullFiber = yield* restore(Effect.forkScoped(self.debouncedPull(uri, server)));
				serverPulls.set(uri, pullFiber);
				yield* restore(
					Effect.forkScoped(
						Fiber.await(pullFiber).pipe(
							Effect.flatMap(() =>
								Effect.sync(() => {
									if (serverPulls.get(uri) === pullFiber) {
										serverPulls.delete(uri);
										if (serverPulls.size === 0) {
											self.pending.delete(server);
										}
									}
								})
							)
						)
					)
				);
			})
		);
	}

	private debouncedPull(uri: string, server: string): Effect.Effect<void, never> {
		// Retries are bounded: a server that fails every attempt terminates
		// instead of hammering it forever, and Effect.ignore handles that
		// terminal failure explicitly, so the error channel needs no cast.
		// The next edit re-arms a pull.
		//
		// The failure is reported once, after the last attempt, rather than once
		// per attempt: the retries are one failure, not six.
		//
		// An interruption is not a failure and is not reported: a server that
		// stopped mid-pull, or an edit that replaced this pull with a newer
		// one, has failed nothing and must not leave a warning behind.
		return Effect.sleep(DIAGNOSTIC_PULL_DEBOUNCE).pipe(
			Effect.flatMap(() =>
				this.pullOnce(uri, server).pipe(
					Effect.retry(boundedPullRetrySchedule),
					Effect.tapError((error) =>
						Effect.sync(() => {
							this.deps.onFailure?.(server, error);
						})
					)
				)
			),
			Effect.ignore
		);
	}

	private pullOnce(uri: string, server: string): Effect.Effect<void, unknown> {
		const self = this;
		return Effect.gen(function* () {
			const previousResultId = self.resultIds.get(server)?.get(uri);
			const rawResult = yield* self.deps.request(server, uri, previousResultId);
			const report = parsePullDiagnosticReport(server, uri, rawResult);
			if (!report) {
				return yield* Effect.fail(new PullParseError(server));
			}
			if (report.resultId !== undefined) {
				let serverIds = self.resultIds.get(server);
				if (!serverIds) {
					serverIds = new Map();
					self.resultIds.set(server, serverIds);
				}
				serverIds.set(uri, report.resultId);
			}
			if (report.unchanged) {
				return;
			}
			self.deps.store.pull({
				uri: report.uri,
				server: report.server,
				diagnostics: report.diagnostics
			});
		});
	}

	/**
	 * Drops all pull state for a stopped server: the result-id cache and any
	 * pending debounced pull. A restart must not send a `previousResultId`
	 * from the dead process, and an in-flight pull against the old process
	 * must not write after the stop. Called from `LspRuntime.stopEntry`
	 * alongside the store's `dropServer`, which clears the store side.
	 */
	forgetServer(server: string): Effect.Effect<void> {
		const self = this;
		return Effect.gen(function* () {
			const serverPulls = self.pending.get(server);
			if (serverPulls) {
				for (const fiber of serverPulls.values()) {
					yield* Fiber.interrupt(fiber);
				}
				self.pending.delete(server);
			}
			self.resultIds.delete(server);
		});
	}
}
