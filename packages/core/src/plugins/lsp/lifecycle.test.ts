import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginHost } from '../host.svelte';
import { lspRegistration } from './registration';
import { LSP_LOG_STORE_SERVICE_KEY, LspLogStore } from './logs';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY, lspServerKey } from './lifecycle';
import { LSP_TRANSPORT_SERVICE_KEY } from '../services';
import type { PluginHostInterface } from '../types';
import {
	createRealProcessTransport,
	isProcessAlive,
	waitFor,
	type RealProcessTransport
} from '../../../../../tests/fixtures/lsp-transport';

/**
 * The lifecycle against a real process.
 *
 * The server is the scripted stub spawned over real pipes and driven by the real
 * client, so framing, handshake, exit and orphan behaviour are observed rather
 * than asserted against a mock (ADR 0004 makes the same argument for real git).
 * Only the executable is swapped for the stub, because vtsls is not bundled until
 * #265; the command and arguments the descriptor declares are asserted anyway.
 *
 * Everything goes through the plugin's own trigger — the workspace's document
 * lifecycle event — and the plugin's own disablement, because "disabling the
 * plugin stops everything" is a statement about that path and nothing else.
 */

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

/** A project layout on disk, so root markers are real files. */
function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'lsp-project-'));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

interface Harness {
	readonly host: PluginHost;
	readonly transport: RealProcessTransport;
	readonly logs: LspLogStore;
	readonly runtime: LspRuntime;
	open(path: string, content: string): void;
}

async function startPlugin(script: readonly string[] = []): Promise<Harness> {
	const host = new PluginHost({ platform: 'desktop' });
	const transport = createRealProcessTransport(script.length > 0 ? { script } : {});
	host.provideService(LSP_TRANSPORT_SERVICE_KEY, transport);
	host.register(lspRegistration);
	await host.activate(lspRegistration.manifest.id);
	// Every teardown goes through the plugin's own disablement: the path that has
	// to leave no orphan behind.
	cleanups.push(async () => {
		if (host.isPluginActive(lspRegistration.manifest.id)) {
			await host.deactivate(lspRegistration.manifest.id);
		}
	});
	const logs = host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)!;
	const runtime = host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY)!;
	return {
		host,
		transport,
		logs,
		runtime,
		open: (path, content) => {
			host.emit('document:opened', {
				document: {
					origin: { scheme: 'file', path, name: basename(path) },
					fileName: basename(path),
					content,
					language: null
				}
			});
		}
	};
}

/** A runtime driven directly, with its transport and log capacity injected. */
async function startRuntime(
	options: { script?: readonly string[]; capacity?: number; initializeTimeoutMs?: number }
): Promise<{ runtime: LspRuntime; transport: RealProcessTransport; logs: LspLogStore }> {
	const host = new PluginHost({ platform: 'desktop' });
	host.register({
		manifest: { id: 'ts', name: 'TS', version: 0 },
		setup: (h: PluginHostInterface) => {
			h.registerLspDescriptor('ts', {
				id: 'ts',
				command: 'vtsls',
				args: ['--stdio'],
				rootMarkers: ['tsconfig.json'],
				languages: ['typescript']
			});
		}
	});
	await host.activate('ts');
	const transport = createRealProcessTransport(
		options.script ? { script: options.script } : {}
	);
	const logs = new LspLogStore(options.capacity);
	const runtime = new LspRuntime({
		host,
		pluginId: 'ts',
		logs,
		transport,
		initializeTimeoutMs: options.initializeTimeoutMs
	});
	cleanups.push(() => runtime.dispose());
	return { runtime, transport, logs };
}

/**
 * Waits for handshakes to finish, not merely for processes to exist. Spawning and
 * running are different moments, and a stop issued between them races the start
 * — which the runtime handles, but which is not what these tests are about.
 */
async function waitForRunning(runtime: LspRuntime, count: number): Promise<void> {
	await waitFor(() => runtime.getServers().filter((s) => s.state === 'running').length === count, {
		label: `${count} running server(s)`
	});
}

function trace(logs: LspLogStore): string[] {
	return logs.read({ kind: 'protocol' }).map((e) => e.message);
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/** Lets queued microtasks and timers run without asserting on elapsed time. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 60));
}

function captureErrors(sink: string[]): () => void {
	const original = console.error;
	console.error = (...args: unknown[]) => {
		sink.push(args.map((arg) => String(arg)).join(' '));
		original(...args);
	};
	return () => {
		console.error = original;
	};
}

describe('Server lifecycle against a real stdio server (#264)', () => {
	it('starts on the first served file, against the resolved root, with full content', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const harness = await startPlugin();

		expect(harness.transport.spawned).toHaveLength(0);
		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');

		await waitFor(() => harness.transport.spawned.length === 1, { label: 'a server to spawn' });
		await waitForRunning(harness.runtime, 1);
		const [spawned] = harness.transport.spawned;
		// The descriptor's own configuration reaches the transport, and the resolved
		// root is the server's working directory.
		expect(spawned.requestedCommand).toBe('vtsls');
		expect([...spawned.requestedArgs]).toEqual(['--stdio']);
		expect(spawned.cwd).toBe(root);

		// The handshake reached a real server and came back framed. The root the
		// client resolved is the root the server was told about.
		await waitFor(() => trace(harness.logs).some((line) => line.includes('"serverInfo"')), {
			label: 'the initialize reply'
		});
		expect(trace(harness.logs).join('\n')).toContain(`file://${root}`);

		// The document is synced with its full text, which is what this slice
		// declares: no incremental ranges are sent at all.
		await waitFor(() => trace(harness.logs).some((line) => line.includes('didOpen')), {
			label: 'the didOpen notification'
		});
		const didOpen = trace(harness.logs).find((line) => line.includes('didOpen'))!;
		expect(didOpen).toContain('export const a = 1;\\n');
		expect(didOpen).toContain('"languageId":"typescript"');
		expect(didOpen).not.toContain('contentChanges');

		expect(harness.runtime.getServers()).toEqual([
			{
				server: lspServerKey('typescript', root),
				descriptorId: 'typescript',
				root,
				marker: 'tsconfig.json',
				state: 'running',
				pid: harness.transport.pids[0]
			}
		]);
	});

	it('starts nothing for prose, an unserved language, or a file with no extension', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'notes/note.md': '# heading',
			'scripts/build.py': 'print(1)',
			'LICENSE': 'MIT'
		});
		const harness = await startPlugin();

		harness.open(join(root, 'notes/note.md'), '# heading');
		harness.open(join(root, 'scripts/build.py'), 'print(1)');
		harness.open(join(root, 'LICENSE'), 'MIT');
		await settle();

		expect(harness.transport.spawned).toHaveLength(0);
		// Not one buffer either: a note that pays for no server leaves no trace.
		expect(harness.logs.read()).toEqual([]);
		expect(harness.runtime.getServers()).toEqual([]);

		harness.open(join(root, 'src/a.ts'), 'const a = 1;');
		await waitForRunning(harness.runtime, 1);
		await settle();
		expect(harness.transport.spawned).toHaveLength(1);
	});

	it('resolves the root by marker order in a nested layout and attributes it to one descriptor', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'packages/app/package.json': '{}',
			'packages/app/src/a.ts': ''
		});
		const harness = await startPlugin();
		harness.open(join(root, 'packages/app/src/a.ts'), '');
		await waitForRunning(harness.runtime, 1);

		// The nearer `package.json` did not outrank the `tsconfig.json` above it, and
		// the decision is recorded against the one descriptor that made it.
		expect(harness.transport.spawned[0].cwd).toBe(root);
		await waitFor(
			() => harness.logs.read({ kind: 'server' }).some((e) => e.message.includes('via tsconfig.json')),
			{ label: 'the root decision to be logged' }
		);
		const decision = harness.logs
			.read({ kind: 'server' })
			.find((e) => e.message.includes('via tsconfig.json'))!;
		expect(decision.server).toBe(lspServerKey('typescript', root));
		expect(decision.server).toContain('typescript');
	});

	it('gives each nested project its own server', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'packages/app/tsconfig.json': '{}',
			'src/a.ts': '',
			'packages/app/src/b.ts': ''
		});
		const harness = await startPlugin();
		harness.open(join(root, 'src/a.ts'), '');
		harness.open(join(root, 'packages/app/src/b.ts'), '');
		await waitForRunning(harness.runtime, 2);

		expect(harness.transport.spawned.map((s) => s.cwd)).toEqual([
			root,
			join(root, 'packages/app')
		]);
		expect(harness.runtime.getServers().map((s) => s.server)).toEqual([
			lspServerKey('typescript', root),
			lspServerKey('typescript', join(root, 'packages/app'))
		]);
	});

	it('reports two descriptors claiming one file instead of picking one', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const harness = await startPlugin();
		harness.open(join(root, 'src/a.ts'), '');
		await waitForRunning(harness.runtime, 1);

		// The same file again, after the registry changed under it: a cached answer
		// would let the conflict hide behind the memo.
		harness.host.register({
			manifest: { id: 'ts-rival', name: 'TS Rival', version: 0 },
			setup: (h: PluginHostInterface) => {
				h.registerLspDescriptor('ts-rival', {
					id: 'ts-rival',
					command: 'other-server',
					args: [],
					rootMarkers: ['package.json'],
					languages: ['TypeScript']
				});
			}
		});
		await harness.host.activate('ts-rival');

		const errors: string[] = [];
		const restore = captureErrors(errors);
		harness.open(join(root, 'src/a.ts'), 'edited');
		await settle();
		restore();

		// No second server: resolving by registration order would make the answer
		// depend on which plugin enabled first.
		expect(harness.transport.spawned).toHaveLength(1);
		const reported = errors.join('\n');
		expect(reported).toContain('ts-rival');
		expect(reported).toContain('typescript');
		expect(reported).toContain('Action:');
		await harness.host.deactivate('ts-rival');
	});

	it('restarts and stops one server at a time', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'packages/app/tsconfig.json': '{}',
			'src/a.ts': '',
			'packages/app/src/b.ts': ''
		});
		const harness = await startPlugin();
		harness.open(join(root, 'src/a.ts'), '');
		harness.open(join(root, 'packages/app/src/b.ts'), '');
		await waitForRunning(harness.runtime, 2);

		const outer = lspServerKey('typescript', root);
		const inner = lspServerKey('typescript', join(root, 'packages/app'));
		const [outerPid, innerPid] = harness.transport.pids;

		// Stopping one leaves the other running.
		expect(await harness.runtime.stopServer(outer)).toBe(true);
		await waitFor(() => !isProcessAlive(outerPid), { label: 'the stopped server to exit' });
		expect(isProcessAlive(innerPid)).toBe(true);
		expect(harness.runtime.getServers().find((s) => s.server === outer)?.state).toBe('stopped');

		// A stop is final: editing a document under it does not resurrect the server.
		harness.open(join(root, 'src/a.ts'), 'const a = 2;');
		await settle();
		expect(harness.transport.spawned).toHaveLength(2);

		// Restarting brings that server back as a new process with its documents
		// re-opened, so a restart is not a silent loss of context.
		const didOpens = () => trace(harness.logs).filter((line) => line.includes('didOpen')).length;
		const before = didOpens();
		expect(await harness.runtime.restartServer(outer)).toBe(true);
		await waitFor(() => harness.transport.spawned.length === 3, { label: 'the restart' });
		expect(harness.transport.spawned[2].cwd).toBe(root);
		expect(harness.runtime.getServers().find((s) => s.server === outer)?.state).toBe('running');
		await waitFor(() => didOpens() > before, { label: 'the re-opened document' });
		// And the untouched server was neither restarted nor stopped with it.
		expect(harness.transport.pids[1]).toBe(innerPid);
		expect(isProcessAlive(innerPid)).toBe(true);
		expect(harness.runtime.getServers().find((s) => s.server === inner)?.state).toBe('running');
	});

	it('restarts every server at once, replacing each process', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'packages/app/tsconfig.json': '{}',
			'src/a.ts': '',
			'packages/app/src/b.ts': ''
		});
		const harness = await startPlugin();
		harness.open(join(root, 'src/a.ts'), '');
		harness.open(join(root, 'packages/app/src/b.ts'), '');
		await waitForRunning(harness.runtime, 2);
		const firstPids = [...harness.transport.pids];

		await harness.runtime.restartAll();

		await waitFor(() => harness.transport.spawned.length === 4, { label: 'both restarts' });
		await waitForRunning(harness.runtime, 2);
		for (const pid of firstPids) {
			await waitFor(() => !isProcessAlive(pid), { label: `old pid ${pid} to exit` });
		}
		// Both roots come back, each against its own project.
		expect(harness.transport.spawned.slice(2).map((s) => s.cwd).sort()).toEqual(
			[root, join(root, 'packages/app')].sort()
		);
	});

	it('stops every server when the plugin is disabled, with no orphan process', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'packages/app/tsconfig.json': '{}',
			'src/a.ts': '',
			'packages/app/src/b.ts': ''
		});
		const harness = await startPlugin();
		harness.open(join(root, 'src/a.ts'), '');
		harness.open(join(root, 'packages/app/src/b.ts'), '');
		await waitForRunning(harness.runtime, 2);

		const pids = [...harness.transport.pids];
		expect(pids.every((pid) => isProcessAlive(pid))).toBe(true);

		await harness.host.deactivate(lspRegistration.manifest.id);

		// The state flag is not the assertion: the processes themselves are gone.
		for (const pid of pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
		expect(harness.host.isPluginActive(lspRegistration.manifest.id)).toBe(false);
		expect(harness.host.getLspDescriptors()).toEqual([]);
	});

	it('kills a server that ignores shutdown rather than leaving it running', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const harness = await startPlugin(['--mode', 'no-shutdown']);
		harness.open(join(root, 'src/a.ts'), '');
		await waitForRunning(harness.runtime, 1);
		const [pid] = harness.transport.pids;

		expect(await harness.runtime.stopServer(lspServerKey('typescript', root))).toBe(true);

		await waitFor(() => !isProcessAlive(pid), {
			label: 'the unresponsive server to be killed',
			timeoutMs: 10_000
		});
		// Both bounded waits elapse here: no reply to `shutdown`, then no exit
		// after `exit`. The bound is production behaviour, not a test concession.
		expect(
			harness.logs
				.read({ kind: 'server' })
				.some((e) => e.message.includes('killing the process instead'))
		).toBe(true);
		expect(harness.logs.read().some((e) => e.message.includes('did not exit after shutdown'))).toBe(
			true
		);
	}, 20_000);

	it('records server stderr and the protocol trace in capped per-server buffers', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const harness = await startPlugin(['--stderr', 'stub server: booted']);
		harness.open(join(root, 'src/a.ts'), 'const a = 1;');
		await waitFor(
			() => harness.logs.read({ kind: 'server' }).some((e) => e.message.includes('booted')),
			{ label: 'the stderr line' }
		);
		// stderr arrives while the process starts; the lifecycle lines the test
		// reads below are only written once the handshake has come back.
		await waitForRunning(harness.runtime, 1);

		const server = lspServerKey('typescript', root);
		const serverLines = harness.logs.read({ kind: 'server', server });
		// The startup line survives intact, multi-byte characters included: stderr
		// arrives in arbitrary chunks and a per-chunk decode would mangle it.
		const booted = serverLines.find((e) => e.message.includes('booted'))!;
		expect(booted.message).toBe('stub server: booted — café ✓');
		expect(booted.message).not.toContain('\uFFFD');
		expect(serverLines.some((e) => e.message.startsWith('Started vtsls'))).toBe(true);

		const protocol = harness.logs.read({ kind: 'protocol' });
		expect(protocol.some((e) => e.message.includes('"method":"initialize"'))).toBe(true);
		expect(protocol.some((e) => e.message.includes('didOpen'))).toBe(true);
		expect(protocol.every((e) => e.level === 'trace')).toBe(true);
		expect(harness.logs.servers()).toEqual([server]);
	});

	it('caps the buffers of a real server rather than growing them without bound', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const { runtime, logs } = await startRuntime({ capacity: 20 });
		const path = join(root, 'src/a.ts');

		await runtime.openDocument({ path, fileName: 'a.ts', content: 'const a = 1;' });
		await waitFor(() => runtime.getServers()[0]?.state === 'running', { label: 'the server' });
		// Every change is a full-content sync, so each keystroke adds trace lines.
		// Enough of them overflow a 20-entry buffer.
		for (let i = 0; i < 40; i++) {
			await runtime.openDocument({ path, fileName: 'a.ts', content: `const a = ${i};` });
		}
		await settle();

		expect(logs.read()).toHaveLength(20);
		expect(logs.droppedCount).toBeGreaterThan(0);
	});

	it('stays inert, with no server and no failure, when no transport is published', async () => {
		// Web publishes nothing (spec #263), so the plugin has to degrade to "no
		// LSP" rather than fail to activate or throw on the first document.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const host = new PluginHost({ platform: 'desktop' });
		host.register(lspRegistration);
		await host.activate(lspRegistration.manifest.id);
		cleanups.push(async () => {
			if (host.isPluginActive(lspRegistration.manifest.id)) {
				await host.deactivate(lspRegistration.manifest.id);
			}
		});

		host.emit('document:opened', {
			document: {
				origin: { scheme: 'file', path: join(root, 'src/a.ts'), name: 'a.ts' },
				fileName: 'a.ts',
				content: '',
				language: null
			}
		});
		await settle();

		const logs = host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)!;
		expect(logs.read({ kind: 'protocol' })).toEqual([]);
		expect(logs.read().some((e) => e.message.includes('No LSP transport'))).toBe(true);
	});

	it('reports a server that cannot start, and leaves nothing running', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const harness = await startPlugin(['--mode', 'fail']);
		harness.open(join(root, 'src/a.ts'), '');
		await waitFor(
			() => harness.logs.read().some((e) => e.level === 'error' && e.message.includes('Failed to start')),
			{ label: 'the failed start to be logged' }
		);
		expect(harness.runtime.getServers()[0].state).toBe('failed');
		// A failed start must not leave the failed process behind either.
		for (const pid of harness.transport.pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
	});

	it('gives up on a server that never completes the handshake', async () => {
		// The timeout path #265 depends on: a silent server must not strand the
		// runtime on a document it will never be able to answer.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const { runtime, logs, transport } = await startRuntime({
			script: ['--mode', 'silent'],
			initializeTimeoutMs: 250
		});

		await runtime.openDocument({
			path: join(root, 'src/a.ts'),
			fileName: 'a.ts',
			content: ''
		});
		await settle();

		expect(runtime.getServers()[0].state).toBe('failed');
		expect(logs.read().some((e) => e.message.includes('did not answer "initialize"'))).toBe(true);
		for (const pid of transport.pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
	});
});
