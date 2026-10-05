import {
	LSP_PLATFORM_SERVICE_KEY,
	type LspProcess,
	type LspReadableStream,
	type LspPlatform,
	type LspWritableStream
} from '@np/core';

/**
 * The desktop LSP platform (spec #263).
 *
 * Supplies the seam `@np/core` cannot have for itself: it spawns the server and
 * answers one filesystem question. Both halves are IPC, because the renderer has
 * no process host of its own — which is why the manifest limits this plugin to
 * desktop (ADR 0006 allows an explicit platform limit; spec #263 leaves web to a
 * later headless-server spec).
 *
 * Bytes cross the bridge as `Uint8Array` and are re-emitted as bytes. Nothing
 * here decodes to text: a pipe read can split a multi-byte character, and
 * decoding on either side of that split would put U+FFFD into the middle of a
 * source file. The client's frame parser decodes whole frames instead, which is
 * exact by construction.
 *
 * `LspPlatform` is structural, so tests drive this adapter with a stubbed
 * `window.electronAPI` exactly as `SpawnGitAdapter.test.ts` does.
 */
interface ElectronLspBridge {
	fileExists(path: string): Promise<boolean>;
	resolveLspCommand(command: string, bundled?: BundledLspCommand): Promise<ResolvedLspCommand>;
	spawnLspServer(
		plan: ResolvedLspCommand,
		args: string[],
		cwd: string
	): Promise<{ processId: string; pid: number | null }>;
	writeLspServer(processId: string, chunk: Uint8Array): void;
	endLspServer(processId: string): void;
	killLspServer(processId: string): Promise<void>;
	onLspServerData(handlers: {
		onStdout: (processId: string, chunk: Uint8Array) => void;
		onStderr: (processId: string, chunk: Uint8Array) => void;
		onExit: (exit: { processId: string; code: number; signal: string | null; error?: string }) => void;
	}): () => void;
}

/** The descriptor's own declaration of which packaged package its server is in. */
interface BundledLspCommand {
	readonly package: string;
	readonly binary: string;
}

/**
 * A spawn plan the main process minted. The renderer hands it straight back
 * rather than assembling a command of its own, so `vtsls` becomes a path in
 * exactly one place (spec #263).
 */
interface ResolvedLspCommand {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Record<string, string>;
	readonly source: 'bundled' | 'path';
	readonly script?: string;
}

export interface LspBridgeHost {
	readonly electronAPI?: ElectronLspBridge;
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** One server as the client sees it: subscriptions held until its id arrives. */
class IpcLspProcess implements LspProcess {
	private processId: string | null = null;
	private osPid: number | undefined;
	private readonly stdoutListeners = new Set<(chunk: Uint8Array) => void>();
	private readonly stderrListeners = new Set<(chunk: Uint8Array) => void>();
	private readonly exitDeferred = createDeferred<{
		code: number | null;
		signal: string | null;
		error?: string;
	}>();
	/**
	 * Settled once `attach` names the process, so the client can declare a real
	 * parent pid in `initialize` instead of a hard-coded `null` (LSP's "I have no
	 * process id"). A server told `null` cannot watch its parent, so a crashed
	 * renderer leaves it running — the orphan `lsp: false` and plugin disable both
	 * have to be able to prevent. Settled to `undefined` by `reportExit`, because a
	 * spawn that never produced a process never will.
	 */
	private readonly readyDeferred = createDeferred<number | undefined>();
	private disposed = false;

	/** Work the client asked for before the spawn resolved, applied on arrival. */
	private readonly awaitingId: Array<(id: string) => void> = [];

	constructor(private readonly bridge: ElectronLspBridge, private readonly route: ProcessRouter) {
		this.stdin = {
			write: (chunk: Uint8Array) => {
				this.withId((id) => this.bridge.writeLspServer(id, chunk));
			},
			end: () => this.withId((id) => this.bridge.endLspServer(id))
		};
		this.stdout = {
			onData: (listener) => {
				this.stdoutListeners.add(listener);
				return () => this.stdoutListeners.delete(listener);
			}
		};
		this.stderr = {
			onData: (listener) => {
				this.stderrListeners.add(listener);
				return () => this.stderrListeners.delete(listener);
			}
		};
	}

	readonly stdin: LspWritableStream;
	readonly stdout: LspReadableStream;
	readonly stderr: LspReadableStream;

	get pid(): number | undefined {
		return this.osPid;
	}

	get ready(): Promise<number | undefined> {
		return this.readyDeferred.promise;
	}

	get exit(): Promise<{ code: number | null; signal: string | null; error?: string }> {
		return this.exitDeferred.promise;
	}

	/** Called once the spawn round trip names the process. */
	attach(processId: string, pid: number | null): void {
		// A kill that landed before the spawn reply already resolved `ready`
		// and `exit` and never learned the id to kill. The process that just
		// arrived belongs to a disposed adapter, so kill it by id, drop any
		// buffered writes, and never register it.
		if (this.disposed) {
			this.awaitingId.length = 0;
			void this.bridge.killLspServer(processId);
			return;
		}
		this.processId = processId;
		this.osPid = pid ?? undefined;
		// Released before anything is replayed, so a client already waiting on the
		// pid to declare its parent is not left waiting on the replay.
		this.readyDeferred.resolve(this.osPid);
		// Registered before anything is replayed, so an exit arriving immediately
		// after the spawn reply still reaches this process.
		this.route.register(processId, this);
		for (const apply of this.awaitingId) apply(processId);
		this.awaitingId.length = 0;
	}

	deliverStdout(chunk: Uint8Array): void {
		for (const listener of [...this.stdoutListeners]) listener(chunk);
	}

	deliverStderr(chunk: Uint8Array): void {
		for (const listener of [...this.stderrListeners]) listener(chunk);
	}

	/** Reports a server that died, or a spawn that never happened at all. */
	reportExit(code: number | null, signal: string | null, error?: string): void {
		// A spawn that failed can never name itself, and the client is waiting on
		// that name before it can declare a parent. Left pending it would hold the
		// handshake until the timeout instead of failing it on the exit that is
		// already known.
		this.readyDeferred.resolve(this.osPid);
		this.exitDeferred.resolve({ code, signal, error });
	}

	kill(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.processId) void this.bridge.killLspServer(this.processId);
		// Both are resolved rather than left pending: `exit` because the client
		// waits on it to close the shutdown handshake, and `ready` because a
		// stop landing before the spawn round trip returns would otherwise strand a
		// client waiting for a parent pid that is never coming. Both resolve
		// idempotently, so the later `attach` cannot contradict a resolved one.
		this.readyDeferred.resolve(this.osPid);
		this.exitDeferred.resolve({ code: null, signal: null });
	}

	private withId(apply: (id: string) => void): void {
		if (this.processId) apply(this.processId);
		else this.awaitingId.push(apply);
	}
}

/** Routes shared `lsp:*` channel messages to the process they belong to. */
class ProcessRouter {
	private readonly processes = new Map<string, IpcLspProcess>();

	register(processId: string, process: IpcLspProcess): void {
		this.processes.set(processId, process);
	}

	deliverStdout(processId: string, chunk: Uint8Array): void {
		this.processes.get(processId)?.deliverStdout(chunk);
	}

	deliverStderr(processId: string, chunk: Uint8Array): void {
		this.processes.get(processId)?.deliverStderr(chunk);
	}

	reportExit(processId: string, code: number | null, signal: string | null, error?: string): void {
		const process = this.processes.get(processId);
		this.processes.delete(processId);
		process?.reportExit(code, signal, error);
	}
}

/**
 * The bridge as the renderer finds it: the preload installs `electronAPI` on the
 * window. Read through a function rather than a module-level constant so a test
 * can install its own window before the platform is built.
 */
function defaultBridgeHost(): LspBridgeHost {
	return { electronAPI: (globalThis as { window?: LspBridgeHost }).window?.electronAPI };
}

/** Builds one platform over the preload bridge. */
export function createElectronLspPlatform(host: LspBridgeHost = defaultBridgeHost()): LspPlatform {
	const bridge = host.electronAPI;
	if (!bridge) {
		throw new Error(
			'No Electron bridge is available, so language servers cannot be started.\n' +
				'Action: Publish the LSP platform only in the desktop renderer. On web, publish nothing: the plugin resolves no platform and stays inert.'
		);
	}

	const router = new ProcessRouter();
	bridge.onLspServerData({
		onStdout: (processId, chunk) => router.deliverStdout(processId, chunk),
		onStderr: (processId, chunk) => router.deliverStderr(processId, chunk),
		onExit: ({ processId, code, signal, error }) => router.reportExit(processId, code, signal, error)
	});

	return {
		fileExists: (path) => bridge.fileExists(path),
		spawn(options): LspProcess {
			const process = new IpcLspProcess(bridge, router);
			// The declared command is resolved first: `vtsls` is a name, and the
			// plan that runs is the packaged dependency if there is one and the
			// name itself otherwise (see LspCommandResolver). Which package that is
			// comes from the descriptor, so this adapter carries no table of server
			// names. A resolution that fails is reported as an exit rather than
			// swallowed, so a missing server reaches the log instead of becoming a
			// silent one.
			void bridge
				.resolveLspCommand(options.command, options.bundled)
				.then((plan) => bridge.spawnLspServer(plan, [...options.args], options.cwd))
				.then((spawned) => process.attach(spawned.processId, spawned.pid))
				// A spawn that never produced a process is reported as an exit, so
				// the client's wait on `exit` resolves instead of hanging on a pid
				// that does not exist, and the reason travels with it into the
				// handshake failure the client logs.
				.catch((error: unknown) =>
					process.reportExit(-1, null, error instanceof Error ? error.message : String(error))
				);
			return process;
		}
	};
}

/**
 * Publishes the platform under the seam key the LSP plugin resolves.
 *
 * The host stores it opaquely (ADR 0008): `@np/core` names the capability, the
 * desktop app supplies it, and a build that does not supply it leaves the plugin
 * with no LSP at all.
 */
export function provideLspPlatform(
	host: { provideService(key: string, service: unknown): void },
	bridgeHost: LspBridgeHost = defaultBridgeHost()
): LspPlatform | undefined {
	if (!bridgeHost.electronAPI) return undefined;
	const platform = createElectronLspPlatform(bridgeHost);
	host.provideService(LSP_PLATFORM_SERVICE_KEY, platform);
	return platform;
}
