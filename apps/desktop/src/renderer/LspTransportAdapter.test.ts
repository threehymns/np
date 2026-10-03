import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createElectronLspTransport, provideLspTransport } from './LspTransportAdapter';
import { LSP_TRANSPORT_SERVICE_KEY } from '@np/core';

/**
 * The desktop transport over a stubbed preload bridge, the same seam
 * `SpawnGitAdapter.test.ts` uses for git.
 *
 * What matters here is that bytes stay bytes. The bridge hands the adapter a
 * `Uint8Array` per pipe read, and the adapter re-emits it untouched; the only
 * decode happens in the client's frame parser, once a whole frame has arrived.
 * A test that decoded here would prove the wrong thing and hide the bug this
 * arrangement exists to prevent.
 */
describe('createElectronLspTransport', () => {
	let mockSpawn: ReturnType<typeof mock>;
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
		mockSpawn = mock(async () => ({ processId: 'p1', pid: 4242 }));
		mockWrite = mock(() => {});
		mockEnd = mock(() => {});
		mockKill = mock(async () => {});
		mockExists = mock(async () => true);
		unsubscribe = mock(() => {});

		(globalThis as any).window = {
			electronAPI: {
				fileExists: mockExists,
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
		const transport = createElectronLspTransport(bridgeHost());
		const spawned = transport.spawn({ command: 'vtsls', args: ['--stdio'], cwd: '/repo' });

		await waitFor(() => mockSpawn.mock.calls.length === 1);
		expect(mockSpawn).toHaveBeenCalledWith('vtsls', ['--stdio'], '/repo');
		expect(spawned.pid).toBe(4242);
	});

	it('answers the marker probe through the bridge', async () => {
		const transport = createElectronLspTransport(bridgeHost());
		expect(await transport.fileExists('/repo/tsconfig.json')).toBe(true);
		expect(mockExists).toHaveBeenCalledWith('/repo/tsconfig.json');
	});

	it('carries a chunk across as bytes, so a split character survives the bridge', async () => {
		const transport = createElectronLspTransport(bridgeHost());
		const received: Uint8Array[] = [];
		const spawned = transport.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		spawned.stdout.onData((chunk) => received.push(chunk));
		await waitFor(() => capturedHandlers !== null);

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

	it('encodes a string write as UTF-8 bytes for the server', async () => {
		const transport = createElectronLspTransport(bridgeHost());
		const spawned = transport.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		await waitFor(() => mockSpawn.mock.calls.length === 1);

		spawned.stdin.write('héllo');
		expect(mockWrite).toHaveBeenCalledTimes(1);
		const [processId, chunk] = mockWrite.mock.calls[0] as [string, Uint8Array];
		expect(processId).toBe('p1');
		expect(new TextDecoder().decode(chunk)).toBe('héllo');
	});

	it('defers writes and subscriptions made before the spawn round trip', async () => {
		// The client subscribes to stdout and writes `initialize` immediately; the
		// process id only exists one IPC round trip later. Losing either would lose
		// the first bytes the server sends.
		let resolveSpawn: ((value: { processId: string; pid: number }) => void) | undefined;
		mockSpawn.mockImplementation(
			() =>
				new Promise<{ processId: string; pid: number }>((resolve) => {
					resolveSpawn = resolve;
				})
		);
		const transport = createElectronLspTransport(bridgeHost());
		const received: Uint8Array[] = [];
		const spawned = transport.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
		spawned.stdout.onData((chunk) => received.push(chunk));
		spawned.stdin.write('early');

		resolveSpawn!({ processId: 'p9', pid: 77 });
		await waitFor(() => mockWrite.mock.calls.length === 1);
		expect(mockWrite.mock.calls[0][0]).toBe('p9');

		capturedHandlers!.onStdout('p9', new TextEncoder().encode('late'));
		expect(received).toHaveLength(1);
		expect(spawned.pid).toBe(77);
	});

	it('resolves exit once, and kills a server on request', async () => {
		const transport = createElectronLspTransport(bridgeHost());
		const spawned = transport.spawn({ command: 'vtsls', args: [], cwd: '/repo' });
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
		const transport = createElectronLspTransport(bridgeHost());
		const spawned = transport.spawn({ command: 'vtsls', args: [], cwd: '/repo' });

		const exit = await spawned.exit;
		expect(exit.code).toBe(-1);
		expect(exit.error).toContain('ENOENT');
	});

	it('publishes under the seam key, and publishes nothing without a bridge', () => {
		const published: Array<[string, unknown]> = [];
		const host = {
			provideService: (key: string, service: unknown) => published.push([key, service])
		};

		expect(provideLspTransport(host, bridgeHost())).toBeDefined();
		expect(published[0][0]).toBe(LSP_TRANSPORT_SERVICE_KEY);

		delete (globalThis as any).window;
		expect(provideLspTransport(host)).toBeUndefined();
		expect(published).toHaveLength(1);
	});

	it('refuses to build a transport with no bridge, and says what to do', () => {
		delete (globalThis as any).window;
		expect(() => createElectronLspTransport(bridgeHost())).toThrow(/Action:/);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for the bridge call.');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
