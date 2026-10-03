import {
	LSP_TRANSPORT_SERVICE_KEY,
	type LspProcess,
	type LspReadableStream,
	type LspTransport,
	type LspWritableStream
} from '@np/core';

/**
 * The desktop LSP transport (spec #263).
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
 * `LspTransport` is structural, so tests drive this adapter with a stubbed
 * `window.electronAPI` exactly as `SpawnGitAdapter.test.ts` does.
 */
interface ElectronLspBridge {
	fileExists(path: string): Promise<boolean>;
	spawnLspServer(command: string, args: string[], cwd: string): Promise<{ processId: string; pid: number | null }>;
	writeLspServer(processId: string, chunk: Uint8Array): void;
	endLspServer(processId: string): void;
	killLspServer(processId: string): Promise<void>;
	onLspServerData(handlers: {
		onStdout: (processId: string, chunk: Uint8Array) => void;
		onStderr: (processId: string, chunk: Uint8Array) => void;
		onExit: (exit: { processId: string; code: number; signal: string | null; error?: string }) => void;
	}): () => void;
}

export interface LspBridgeHost {
	readonly electronAPI?: ElectronLspBridge;
}

const textEncoder = new TextEncoder();

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
	private disposed = false;

	/** Work the client asked for before the spawn resolved, applied on arrival. */
	private readonly awaitingId: Array<(id: string) => void> = [];

	constructor(private readonly bridge: ElectronLspBridge, private readonly route: ProcessRouter) {
		this.stdin = {
			write: (chunk: Uint8Array | string) => {
				const bytes = typeof chunk === 'string' ? textEncoder.encode(chunk) : chunk;
				this.withId((id) => this.bridge.writeLspServer(id, bytes));
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

	get exit(): Promise<{ code: number | null; signal: string | null; error?: string }> {
		return this.exitDeferred.promise;
	}

	/** Called once the spawn round trip names the process. */
	attach(processId: string, pid: number | null): void {
		this.processId = processId;
		this.osPid = pid ?? undefined;
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
		this.exitDeferred.resolve({ code, signal, error });
	}

	kill(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.processId) void this.bridge.killLspServer(this.processId);
		// A process killed before the exit arrives would otherwise leave `exit`
		// pending forever, and the client waits on it to close the handshake.
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
 * can install its own window before the transport is built.
 */
function defaultBridgeHost(): LspBridgeHost {
	return { electronAPI: (globalThis as { window?: LspBridgeHost }).window?.electronAPI };
}

/** Builds one transport over the preload bridge. */
export function createElectronLspTransport(host: LspBridgeHost = defaultBridgeHost()): LspTransport {
	const bridge = host.electronAPI;
	if (!bridge) {
		throw new Error(
			'No Electron bridge is available, so language servers cannot be started.\n' +
				'Action: Publish the LSP transport only in the desktop renderer. On web, publish nothing: the plugin resolves no transport and stays inert.'
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
			void bridge
				.spawnLspServer(options.command, [...options.args], options.cwd)
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
 * Publishes the transport under the seam key the LSP plugin resolves.
 *
 * The host stores it opaquely (ADR 0008): `@np/core` names the capability, the
 * desktop app supplies it, and a build that does not supply it leaves the plugin
 * with no LSP at all.
 */
export function provideLspTransport(
	host: { provideService(key: string, service: unknown): void },
	bridgeHost: LspBridgeHost = defaultBridgeHost()
): LspTransport | undefined {
	if (!bridgeHost.electronAPI) return undefined;
	const transport = createElectronLspTransport(bridgeHost);
	host.provideService(LSP_TRANSPORT_SERVICE_KEY, transport);
	return transport;
}
