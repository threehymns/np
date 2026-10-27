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
	 * The document version last synced to that server, or undefined when the
	 * document has not been synced to it.
	 *
	 * Read when the pull is issued rather than when it is armed, because that
	 * is the text the server computes its answer against, and the store needs
	 * the revision to tell a pull that is still fresh from one that was already
	 * in flight when the text changed.
	 */
	readonly versionFor?: (server: string, uri: string) => number | undefined;
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

interface PendingPull {
	readonly fiber: Fiber.Fiber<void, never>;
	/** The detach epoch the arming call saw; a later detach makes it stale. */
	readonly epoch: number;
}

export class DiagnosticPullCoordinator {
	private readonly pending = new Map<string, Map<string, PendingPull>>();
	private readonly resultIds = new Map<string, Map<string, string>>();
	/**
	 * One counter per URI, bumped when that document is detached.
	 *
	 * `armPull` reads the counter when it is called, not when its effect runs,
	 * so a detach that lands while it waits out an interrupt makes it stale and
	 * it returns without registering anything. The bump happens synchronously in
	 * `forgetUri`, before its effect is forked, so a pull armed in the same turn
	 * cannot slip past it.
	 */
	private readonly detachEpochs = new Map<string, number>();

	constructor(private readonly deps: DiagnosticPullDependencies) {}

	/**
	 * Arms a debounced pull for one (uri, server), on the caller's Scope.
	 *
	 * What triggered it is the runtime's business: an open and a change both
	 * mean the client may be missing what the server knows about the file, so
	 * both arm the same pull.
	 *
	 * A newer trigger interrupts the still-pending pull for the same key, so
	 * rapid edits collapse to one request and a pull already in flight is
	 * replaced by the newer one rather than racing it. Closing the scope
	 * interrupts everything, including a pull sleeping mid-backoff: no further
	 * requests are issued. A detach that lands after this call makes the arm
	 * stale: it does not register its pull, so nothing writes for the closed
	 * document. Requires an ambient Scope (same contract as scopedPullLoop).
	 */
	armPull(uri: string, server: string): Effect.Effect<void, never, Scope.Scope> {
		const self = this;
		// Read at the call site, so a detach between the caller arming and the
		// effect running is observed below rather than overwritten.
		const epoch = self.detachEpochs.get(uri) ?? 0;
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				if ((self.detachEpochs.get(uri) ?? 0) !== epoch) return;
				let serverPulls = self.pending.get(server);
				if (!serverPulls) {
					serverPulls = new Map();
					self.pending.set(server, serverPulls);
				}
				// Every interrupt below is a yield point, so the maps are re-read
				// afterwards: the interrupted pull's own cleanup may have dropped
				// the entry or the whole map, and a concurrent trigger may have
				// registered a newer fiber. Installing the replacement into the
				// state that is current at that point keeps it registered instead
				// of orphaning it in a map nobody consults.
				let prior = serverPulls.get(uri);
				while (prior) {
					yield* restore(Fiber.interrupt(prior.fiber));
					// A detach owns the state now. Leave before registering, or the
					// closed document would be pulled again.
					if ((self.detachEpochs.get(uri) ?? 0) !== epoch) return;
					serverPulls = self.pending.get(server);
					if (!serverPulls) {
						serverPulls = new Map();
						self.pending.set(server, serverPulls);
					}
					const current = serverPulls.get(uri);
					if (current === prior) {
						// The pull's observer has not removed it yet, so take it
						// out here and let the replacement below occupy the slot.
						serverPulls.delete(uri);
						prior = undefined;
					} else {
						prior = current;
					}
				}
				const pullFiber = yield* restore(Effect.forkScoped(self.debouncedPull(uri, server)));
				// Forking is a yield point too: a detach during it owns the
				// fiber just created, so interrupt it rather than register it.
				if ((self.detachEpochs.get(uri) ?? 0) !== epoch) {
					yield* restore(Fiber.interrupt(pullFiber));
					return;
				}
				serverPulls.set(uri, { fiber: pullFiber, epoch });
				yield* restore(
					Effect.forkScoped(
						Fiber.await(pullFiber).pipe(
							Effect.flatMap(() =>
								Effect.sync(() => {
									if (serverPulls.get(uri)?.fiber === pullFiber) {
										serverPulls.delete(uri);
										if (
											serverPulls.size === 0 &&
											self.pending.get(server) === serverPulls
										) {
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
			// The version the server is about to compute against, read before the
			// request goes out: it is the last version synced to that server, and
			// the store files the answer against it.
			const version = self.deps.versionFor?.(server, uri);
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
				diagnostics: report.diagnostics,
				version
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
				for (const pending of serverPulls.values()) {
					yield* Fiber.interrupt(pending.fiber);
				}
				self.pending.delete(server);
			}
			self.resultIds.delete(server);
		});
	}

	/**
	 * Drops all pull state for one detached document: the result-id cache and
	 * any pull armed for it before the detach. A document opened again must not
	 * send a `previousResultId` from its closed session — the store side was
	 * dropped with it, so an "unchanged" answer would leave the reopened
	 * document with no diagnostics — and a pull armed before the detach must not
	 * write after it. Called from `LspRuntime.detachDocument` alongside the
	 * store's `dropUri`, which clears the store side. Scoped to the URI:
	 * other documents on the same server keep their pulls and their cached
	 * ids, and a URI is bound to one server at a time, so no other server
	 * holds live state for it.
	 *
	 * The epoch is bumped synchronously, before the returned effect runs. An
	 * `armPull` call that already read the old epoch is thereby stale even if
	 * its effect has not started yet, and one that already interrupted a pull
	 * checks the epoch again before registering its replacement. A pull armed
	 * after this call reads the new epoch and belongs to the reopened document,
	 * so it is left alone.
	 */
	forgetUri(uri: string): Effect.Effect<void> {
		const self = this;
		const epoch = (self.detachEpochs.get(uri) ?? 0) + 1;
		self.detachEpochs.set(uri, epoch);
		return Effect.gen(function* () {
			// Snapshot the maps: an interrupt below is a yield point, and a
			// replacement registered meanwhile belongs to the document's new
			// session, not to the state this call set out to forget.
			for (const [server, serverPulls] of [...self.pending]) {
				const pending = serverPulls.get(uri);
				if (!pending) {
					if (serverPulls.size === 0 && self.pending.get(server) === serverPulls) {
						self.pending.delete(server);
					}
					continue;
				}
				// A newer session's pull is not this detach's to cancel.
				if (pending.epoch >= epoch) continue;
				yield* Fiber.interrupt(pending.fiber);
				// The interrupt is a yield point: the interrupted pull's observer
				// may have removed this entry or the whole map, and armPull may
				// have registered a replacement. Only remove the state this call
				// actually interrupted, or a reopened document's pull is lost.
				if (
					self.pending.get(server) === serverPulls &&
					serverPulls.get(uri) === pending
				) {
					serverPulls.delete(uri);
					if (serverPulls.size === 0) {
						self.pending.delete(server);
					}
				}
			}
			for (const [server, serverIds] of self.resultIds) {
				serverIds.delete(uri);
				if (serverIds.size === 0) {
					self.resultIds.delete(server);
				}
			}
		});
	}
}
