import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createElectronLspPlatform, provideLspPlatform } from './LspPlatformAdapter';
import { LSP_PLATFORM_SERVICE_KEY } from '@np/core';

/**
 * The desktop platform over a stubbed preload bridge, the same seam
 * `SpawnGitAdapter.test.ts` uses for git.
 *
 * What matters here is that bytes stay bytes. The bridge hands the adapter a
 * `Uint8Array` per pipe read, and the adapter re-emits it untouched; the only
 * decode happens in the client's frame parser, once a whole frame has arrived.
 * A test that decoded here would prove the wrong thing and hide the bug this
 * arrangement exists to prevent.
 */
describe('createElectronLspPlatform', () => {
	let mockSpawn: ReturnType<typeof mock>;
	let mockResolve: ReturnType<typeof mock>;
	let mockWrite: ReturnType<typeof mock>;
	let mockEnd: ReturnType<typeof mock>;
	let mockKill: ReturnType<typeof mock>;
	let mockExists: ReturnType<typeof mock>;
	let capturedHandlers: {
		onStdout: (processId: string, chunk: Uint8Array) => void;
		onStderr: (processId: string, chunk: Uint8Array) => void;
		onExit: (exit: { processId: string; code: number; signal: string | null; error?: string }) => void;
	} | null = null;
	let unsubscribe: ReturnType<typeof mock> | null = null;

	beforeEach(() => {
		mockSpawn = mock(async () => ({ processId: 'p1', pid: 4242, parentPid: 4243 }));
		// Returns a token naming main's stored plan, never the plan itself.
		mockResolve = mock(async (_command: string) => 'tok-1');
		mockWrite = mock(() => {});
		mockEnd = mock(() => {});
		mockKill = mock(async () => {});
		mockExists = mock(async () => true);
		unsubscribe = mock(() => {});

		(globalThis as any).window = {
			electronAPI: {
				fileExists: mockExists,
				resolveLspCommand: mockResolve,
				spawnLspServer: mockSpawn,
				writeLspServer: mockWrite,
				endLspServer: mockEnd,
				killLspServer: mockKill,
				onLspServerData: mock((handlers: typeof capturedHandlers) => {
					capturedHandlers = handlers;
					return unsubscribe;
				})
			}
		};
	});

	afterEach(() => {
		delete (globalThis as any).window;
		capturedHandlers = null;
	});

	/** The renderer host is the window the preload installed the bridge on. */
	const bridgeHost = () => (globalThis as any).window;

	it('spawns the descriptor command and arguments in the resolved root', async () => {
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: ['--stdio'], cwd: '/repo' });

		// The declared name is resolved first to a token, then the token is what
		// gets spawned — never a command this side assembled.
		await waitFor(() => mockSpawn.mock.calls.length === 1);
		expect(mockResolve).toHaveBeenCalledWith('vtsls', undefined);
		expect(mockSpawn.mock.calls[0]).toEqual([
			'tok-1',
			['--stdio'],
			'/repo',
		]);
		expect(spawned.pid).toBe(4242);
	});

	it("hands the descriptor's bundled declaration to the resolver", async () => {
		// The descriptor says which package its server ships as; the resolver acts
		// on that rather than on a name it has in a table of its own, which is what
		// makes a second bundled server configuration alone (spec #263, story 10).
		const platform = createElectronLspPlatform(bridgeHost());
		platform.spawn({
			command: 'vtsls',
			args: ['--stdio'],
			cwd: '/repo',
			bundled: { package: '@vtsls/language-server', binary: 'bin/vtsls.js' }
		});

		await waitFor(() => mockResolve.mock.calls.length === 1);
		expect(mockResolve.mock.calls[0][1]).toEqual({
			package: '@vtsls/language-server',
			binary: 'bin/vtsls.js'
		});
	});

	it('passes the resolve token through untouched', async () => {
		// The token names main's stored plan (interpreter, script and env
		// included). Rebuilding it here would drop ELECTRON_RUN_AS_NODE and start
		// an Electron instance instead of a server; passing the token through is
		// what keeps the plan in exactly one place.
		mockResolve.mockImplementation(async () => 'tok-bundled');
		const platform = createElectronLspPlatform(bridgeHost());
		platform.spawn({ command: 'vtsls', args: ['--stdio'], cwd: '/repo' });

		await waitFor(() => mockSpawn.mock.calls.length === 1);
		expect(mockSpawn.mock.calls[0]).toEqual(['tok-bundled', ['--stdio'], '/repo']);
	});

	it('reports a resolution failure as an exit rather than spawning nothing', async () => {
		mockResolve.mockImplementation(async () => {
			throw new Error('resolve vtsls failed');
		});
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });

		const exit = await spawned.exit;
		expect(exit.code).toBe(-1);
		expect(exit.error).toContain('resolve vtsls failed');
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it('answers the marker probe through the bridge', async () => {
		const platform = createElectronLspPlatform(bridgeHost());
		expect(await platform.fileExists('/repo/tsconfig.json')).toBe(true);
		expect(mockExists).toHaveBeenCalledWith('/repo/tsconfig.json');
	});

	it('carries a chunk across as bytes, so a split character survives the bridge', async () => {
		const platform = createElectronLspPlatform(bridgeHost());
		const received: Uint8Array[] = [];
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		spawned.stdout.onData((chunk) => received.push(chunk));
		// Delivery routes by process id, which exists only once the spawn round
		// trip has landed — and there are two hops to it, the resolution and the
		// spawn.
		await waitFor(() => mockSpawn.mock.calls.length === 1);
		expect(capturedHandlers).not.toBeNull();

		// Two pipe reads that split a multi-byte character in half, which is what
		// a large document actually produces.
		const bytes = new TextEncoder().encode('{"text":"café"}');
		const cut = bytes.indexOf(0xc3) + 1;
		capturedHandlers!.onStdout('p1', bytes.subarray(0, cut));
		capturedHandlers!.onStdout('p1', bytes.subarray(cut));

		expect(received).toHaveLength(2);
		// Reassembled by the consumer, byte for byte and not a character earlier.
		expect(Buffer.concat(received.map((c) => Buffer.from(c))).toString('utf8')).toBe(
			'{"text":"café"}'
		);
	});

	it('forwards written bytes across the bridge untouched', async () => {
		// The sink takes bytes because the client frames a message as UTF-8 and
		// hands the result over: an adapter that re-encoded a string would be
		// guessing at an encoding it has no way to know.
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		await waitFor(() => mockSpawn.mock.calls.length === 1);

		const bytes = new TextEncoder().encode('héllo');
		spawned.stdin.write(bytes);
		expect(mockWrite).toHaveBeenCalledTimes(1);
		const [processId, chunk] = mockWrite.mock.calls[0] as [string, Uint8Array];
		expect(processId).toBe('p1');
		expect(chunk).toBe(bytes);
	});

	it('defers writes and subscriptions made before the spawn round trip', async () => {
		// The client subscribes to stdout and writes `initialize` immediately; the
		// process id only exists one IPC round trip later. Losing either would lose
		// the first bytes the server sends.
		let resolveSpawn: ((value: { processId: string; pid: number; parentPid: number }) => void) | undefined;
		mockSpawn.mockImplementation(
			() =>
				new Promise<{ processId: string; pid: number; parentPid: number }>((resolve) => {
					resolveSpawn = resolve;
				})
		);
		const platform = createElectronLspPlatform(bridgeHost());
		const received: Uint8Array[] = [];
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		spawned.stdout.onData((chunk) => received.push(chunk));
		spawned.stdin.write('early');

		// The write above is still buffered: the spawn itself has not been called
		// yet, so there is nothing to attach to.
		await waitFor(() => mockSpawn.mock.calls.length === 1);
		resolveSpawn!({ processId: 'p9', pid: 77, parentPid: 78 });
		await waitFor(() => mockWrite.mock.calls.length === 1);
		expect(mockWrite.mock.calls[0][0]).toBe('p9');

		capturedHandlers!.onStdout('p9', new TextEncoder().encode('late'));
		expect(received).toHaveLength(1);
		expect(spawned.pid).toBe(77);
	});

	it('resolves `ready` with the parent pid the spawn round trip brings back', async () => {
		// The client waits on this before declaring `processId`, and that value is the
		// only thing that lets a server notice its parent died — so a `ready` that
		// resolved early or never would be a server told `null`, silently.
		// `pid` stays the server for status; `ready` is the parent for `initialize`.
		let resolveSpawn: ((value: { processId: string; pid: number; parentPid: number }) => void) | undefined;
		mockSpawn.mockImplementation(
			() =>
				new Promise<{ processId: string; pid: number; parentPid: number }>((resolve) => {
					resolveSpawn = resolve;
				})
		);
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		await waitFor(() => mockSpawn.mock.calls.length === 1);
		expect(spawned.pid).toBeUndefined();

		resolveSpawn!({ processId: 'p9', pid: 77, parentPid: 78 });
		expect(await spawned.ready).toBe(78);
		expect(spawned.pid).toBe(77);
		expect(spawned.parentPid).toBe(78);
	});

	it('resolves `ready` even when the spawn never produced a process', async () => {
		// A client waiting for a parent that is never coming would hang the handshake
		// until its timeout instead of failing on the exit that is already known.
		mockSpawn.mockImplementation(async () => {
			throw new Error('spawn vtsls ENOENT');
		});
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });

		expect(await spawned.ready).toBeUndefined();
		await expect(spawned.exit).resolves.toMatchObject({ error: 'spawn vtsls ENOENT' });
	});

	it('resolves `ready` when a kill lands before the spawn reply does', async () => {
		// A stop can arrive mid-handshake. Leaving `ready` pending here would strand a
		// client on a server that has already been killed.
		let resolveSpawn: ((value: { processId: string; pid: number; parentPid: number }) => void) | undefined;
		mockSpawn.mockImplementation(
			() =>
				new Promise<{ processId: string; pid: number; parentPid: number }>((resolve) => {
					resolveSpawn = resolve;
				})
		);
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		spawned.stdin.write(new TextEncoder().encode('early'));
		spawned.kill();

		expect(await spawned.ready).toBeUndefined();
		// And the later attach cannot contradict an already-resolved one: the late
		// process is killed by id, buffered writes are dropped, and nothing is registered.
		resolveSpawn!({ processId: 'p9', pid: 77, parentPid: 78 });
		await waitFor(() => mockKill.mock.calls.length === 1);
		expect(mockKill).toHaveBeenCalledWith('p9');
		expect(mockWrite).not.toHaveBeenCalled();
		expect(await spawned.ready).toBeUndefined();
	});

	it('resolves exit once, and kills a server on request', async () => {
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		await waitFor(() => mockSpawn.mock.calls.length === 1);

		capturedHandlers!.onExit({ processId: 'p1', code: 0, signal: null });
		expect(await spawned.exit).toEqual({ code: 0, signal: null });

		spawned.kill();
		expect(mockKill).toHaveBeenCalledWith('p1');
		// Killing twice is safe: a disable can ask again and must not throw.
		expect(() => spawned.kill()).not.toThrow();
	});

	it('resolves exit with the reason when the spawn itself failed', async () => {
		mockSpawn.mockImplementation(async () => {
			throw new Error('spawn vtsls ENOENT');
		});
		const platform = createElectronLspPlatform(bridgeHost());
		const spawned = platform.spawn({ command: 'vtsls', args: [], cwd: '/repo' });

		const exit = await spawned.exit;
		expect(exit.code).toBe(-1);
		expect(exit.error).toContain('ENOENT');
	});

	it('publishes under the seam key, and publishes nothing without a bridge', () => {
		const published: Array<[string, unknown]> = [];
		const host = {
			provideService: (key: string, service: unknown) => published.push([key, service])
		};

		expect(provideLspPlatform(host, bridgeHost())).toBeDefined();
		expect(published[0][0]).toBe(LSP_PLATFORM_SERVICE_KEY);

		delete (globalThis as any).window;
		expect(provideLspPlatform(host)).toBeUndefined();
		expect(published).toHaveLength(1);
	});

	it('refuses to build a platform with no bridge, and says what to do', () => {
		delete (globalThis as any).window;
		expect(() => createElectronLspPlatform(bridgeHost())).toThrow(/Action:/);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for the bridge call.');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
