import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginHost } from '../host.svelte';
import { lspRegistration } from './registration';
import { LSP_LOG_STORE_SERVICE_KEY, LspLogStore } from './logs';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY, lspServerKey } from './lifecycle';
import { LspDiagnosticsStore } from './diagnostics';
import {
	LSP_PLATFORM_SERVICE_KEY,
	SETTINGS_READER_SERVICE_KEY
} from '../services';
import type { PluginHostInterface } from '../types';
import {
	createRealProcessPlatform,
	isProcessAlive,
	waitFor,
	type RealProcessPlatform
} from '../../../../../tests/fixtures/lsp-platform';

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
	readonly platform: RealProcessPlatform;
	readonly logs: LspLogStore;
	readonly runtime: LspRuntime;
	/** Where the stub records what arrived on the wire, read by {@link received}. */
	readonly wireLog: string;
	open(path: string, content: string): void;
	/** Replaces one stored settings value, the way the settings modal would. */
	setSetting(namespace: string, key: string, value: unknown): void;
	/** Live settings subscriptions the runtime holds. */
	settingsListeners(): number;
}

/**
 * The messages the stub server actually received, one JSON payload per line.
 *
 * The protocol trace is not the place to read this from: it summarizes document
 * bodies away on purpose, so what the server got on the wire is only observable
 * from the server's side. The fixture's `--log-file` is that side.
 */
function received(harness: { readonly wireLog: string }): string[] {
	try {
		return readFileSync(harness.wireLog, 'utf-8').split('\n').filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

/**
 * The `editor.lsp` gate's own view of the stored settings, as a mutable object.
 *
 * A plain object rather than a settings manager, because the seam the runtime uses
 * is a resolved *read* plus a change subscription, and that is what a test has to
 * vary: swapping the manager would exercise the manager instead of the gate.
 */
function settingsReader(store: Record<string, Record<string, unknown>>): {
	read: (namespace: string, key: string) => unknown;
	subscribe: (listener: () => void) => () => void;
	set(namespace: string, key: string, value: unknown): void;
	/** Live subscriptions, so releasing one is observable. */
	listeners: () => number;
} {
	const listeners = new Set<() => void>();
	return {
		read: (namespace, key) => store[namespace]?.[key],
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set: (namespace, key, value) => {
			store[namespace] = { ...store[namespace], [key]: value };
			// What the app's publication does: one notification per change, for a
			// change of *any* setting, with no say in what it was.
			for (const listener of [...listeners]) listener();
		},
		listeners: () => listeners.size
	};
}

async function startPlugin(
	script: readonly string[] = [],
	settings: Record<string, Record<string, unknown>> = {}
): Promise<Harness> {
	const host = new PluginHost({ platform: 'desktop' });
	const wireLog = join(makeProject({}), 'wire.log');
	// Always on: the stub is the only witness to what the client sent, and a
	// suite where some tests have one and some do not is a suite where the
	// difference is invisible.
	const platform = createRealProcessPlatform({ script: [...script, '--log-file', wireLog] });
	host.provideService(LSP_PLATFORM_SERVICE_KEY, platform);
	const settingsAccess = settingsReader(settings);
	host.provideService(SETTINGS_READER_SERVICE_KEY, {
		read: settingsAccess.read,
		subscribe: settingsAccess.subscribe
	});
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
		platform,
		logs,
		runtime,
		wireLog,
		setSetting: (namespace, key, value) => settingsAccess.set(namespace, key, value),
		settingsListeners: settingsAccess.listeners,
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

/** A runtime driven directly, with its platform, settings and logs injected. */
async function startRuntime(
	options: {
		script?: readonly string[];
		capacity?: number;
		initializeTimeoutMs?: number;
		settings?: Record<string, Record<string, unknown>>;
		/** Replaces the platform, for a test that has to count what it asks. */
		platform?: RealProcessPlatform;
	}
): Promise<{
	runtime: LspRuntime;
	platform: RealProcessPlatform;
	logs: LspLogStore;
	diagnostics: LspDiagnosticsStore;
	setSetting: (namespace: string, key: string, value: unknown) => void;
}> {
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
	const platform =
		options.platform ?? createRealProcessPlatform(options.script ? { script: options.script } : {});
	const logs = new LspLogStore(options.capacity);
	const diagnostics = new LspDiagnosticsStore();
	const settingsAccess = settingsReader(options.settings ?? {});
	const runtime = new LspRuntime({
		host,
		pluginId: 'ts',
		logs,
		platform,
		diagnostics,
		readSettings: settingsAccess.read,
		subscribeSettings: settingsAccess.subscribe,
		initializeTimeoutMs: options.initializeTimeoutMs
	});
	cleanups.push(() => runtime.dispose());
	return {
		runtime,
		platform,
		logs,
		diagnostics,
		setSetting: (namespace, key, value) => settingsAccess.set(namespace, key, value)
	};
}

/**
 * Waits for handshakes to finish, not merely for processes to exist. Spawning and
 * running are different moments, and a stop issued between them races the start
 * — which the runtime handles, but which is not what these tests are about.
 */
async function waitForRunning(runtime: LspRuntime, count: number): Promise<void> {
	await waitFor(() => runtime.getStatusRows().filter((s) => s.state === 'running').length === count, {
		label: `${count} running server(s)`
	});
}

function trace(logs: LspLogStore): string[] {
	return logs.read({ kind: 'protocol' }).map((e) => e.message);
}

/**
 * The URIs the server was opened for, in the order it received them.
 *
 * Off the wire rather than off the trace, which summarizes document bodies away, and
 * off the runtime, which reports what it believes it synced rather than what the
 * process was actually told.
 */
function openedUris(harness: { readonly wireLog: string }): string[] {
	return received(harness)
		.filter((line) => line.includes('didOpen'))
		.map((line) => JSON.parse(line).params.textDocument.uri as string);
}

/**
 * A handshake the stub will not answer until the test says so.
 *
 * The stub watches for the file rather than sleeping, so a test can hold a server
 * provably in `starting` while it presents documents to it. Nothing else reaches this
 * window: a test that awaited its first document would present the second one after
 * the handshake and pass against a runtime that drops it, which is how a missing
 * queue survives a suite that appears to cover it.
 */
function makeGate(): { readonly script: readonly string[]; release(): void } {
	const path = join(makeProject({}), 'release');
	return {
		script: ['--mode', 'gated', '--gate-file', path],
		release: () => writeFileSync(path, 'go\n')
	};
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

		expect(harness.platform.spawned).toHaveLength(0);
		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');

		await waitFor(() => harness.platform.spawned.length === 1, { label: 'a server to spawn' });
		await waitForRunning(harness.runtime, 1);
		const [spawned] = harness.platform.spawned;
		// The descriptor's own configuration reaches the platform, and the resolved
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
		// declares: no incremental ranges are sent at all. Read off the wire rather
		// than off the trace, because the trace deliberately does not retain
		// document bodies — a buffer that kept five hundred copies of the file being
		// edited would grow with the file on the keystroke path.
		await waitFor(() => trace(harness.logs).some((line) => line.includes('didOpen')), {
			label: 'the didOpen notification'
		});
		const didOpen = trace(harness.logs).find((line) => line.includes('didOpen'))!;
		expect(didOpen).toContain('"languageId":"typescript"');
		expect(didOpen).not.toContain('contentChanges');
		// What the trace keeps instead: that a body went, and how big it was.
		expect(didOpen).toContain('<document text: 20 chars>');
		expect(didOpen).not.toContain('export const a');
		await waitFor(() => received(harness).some((line) => line.includes('didOpen')), {
			label: 'the stub to record the didOpen it received'
		});
		expect(received(harness).find((line) => line.includes('didOpen'))).toContain(
			'"text":"export const a = 1;'
		);

		// The handshake carries the client's real pid, which is what lets a server
		// watch its parent and exit rather than linger after the editor dies. Read
		// off the wire and matched against this process — the parent — rather than
		// the spawned child, because the claim is only true if it names the watcher.
		// A hard-coded value would satisfy a check that only looked for "not null".
		const initialize = JSON.parse(received(harness).find((line) => line.includes('"initialize"'))!);
		expect(initialize.params.processId).toBe(process.pid);
		// And the completion support the client then asks about with
		// `textDocument/completion`: undeclared, a server is entitled to refuse.
		// Read as ClientCapabilities (`textDocument.completion`): the previous
		// shape used the server names (`completionProvider`), which a
		// spec-correct server ignores in the client slot.
		expect(initialize.params.capabilities).not.toHaveProperty('completionProvider');
		expect(initialize.params.capabilities).not.toHaveProperty('textDocumentSync');
		expect(initialize.params.capabilities.textDocument.completion).toBeDefined();
		// Spec #280 flips ADR 0021's declared absence: the client now
		// implements the visible-window round trip, so it advertises the four
		// properties it resolves (never `textEdit`) alongside markdown docs.
		expect(
			initialize.params.capabilities.textDocument.completion.completionItem?.resolveSupport
				?.properties
		).toEqual(['additionalTextEdits', 'command', 'detail', 'documentation']);
		expect(
			initialize.params.capabilities.textDocument.hover?.contentFormat
		).toEqual(['markdown']);

		expect(harness.runtime.getStatusRows()).toEqual([
			{
				server: lspServerKey('typescript', root),
				descriptorId: 'typescript',
				root,
				marker: 'tsconfig.json',
				state: 'running',
				pid: harness.platform.pids[0],
				details: []
			}
		]);
	});

	it('syncs each served language with the protocol id its server answers to', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/app.tsx': 'export const App = () => null;\n',
			'src/page.jsx': 'export const Page = () => null;\n'
		});
		const harness = await startPlugin();

		harness.open(join(root, 'src/app.tsx'), 'export const App = () => null;\n');
		await waitFor(() => trace(harness.logs).some((line) => line.includes('app.tsx')), {
			label: 'the tsx didOpen'
		});

		// The registry names the language `TSX` and the server answers to
		// `typescriptreact`; syncing it as `tsx` would leave the server with a
		// language it has no grammar for. The mapping is the descriptor's.
		expect(trace(harness.logs).find((line) => line.includes('app.tsx'))).toContain(
			'"languageId":"typescriptreact"'
		);

		harness.open(join(root, 'src/page.jsx'), 'export const Page = () => null;\n');
		await waitFor(() => trace(harness.logs).some((line) => line.includes('page.jsx')), {
			label: 'the jsx didOpen'
		});
		expect(trace(harness.logs).find((line) => line.includes('page.jsx'))).toContain(
			'"languageId":"javascriptreact"'
		);
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

		expect(harness.platform.spawned).toHaveLength(0);
		// Not one buffer either: a note that pays for no server leaves no trace.
		expect(harness.logs.read()).toEqual([]);
		expect(harness.runtime.getStatusRows()).toEqual([]);

		harness.open(join(root, 'src/a.ts'), 'const a = 1;');
		await waitForRunning(harness.runtime, 1);
		await settle();
		expect(harness.platform.spawned).toHaveLength(1);
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
		expect(harness.platform.spawned[0].cwd).toBe(root);
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

		expect(harness.platform.spawned).toHaveLength(2);
		// Order-insensitive, and not because the order does not matter: each document's
		// root walk probes the filesystem, so which of the two settles first is the
		// machine's answer rather than the runtime's. What this asserts is the point —
		// one process per project root.
		expect(harness.platform.spawned.map((s) => s.cwd).sort()).toEqual(
			[root, join(root, 'packages/app')].sort()
		);
		expect(harness.runtime.getStatusRows().map((s) => s.server)).toEqual([
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
		expect(harness.platform.spawned).toHaveLength(1);
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
		const [outerPid, innerPid] = harness.platform.pids;

		// Stopping one leaves the other running.
		expect(await harness.runtime.stopServer(outer)).toBe(true);
		await waitFor(() => !isProcessAlive(outerPid), { label: 'the stopped server to exit' });
		expect(isProcessAlive(innerPid)).toBe(true);
		expect(harness.runtime.getStatusRows().find((s) => s.server === outer)?.state).toBe('stopped');

		// A stop is final: editing a document under it does not resurrect the server.
		harness.open(join(root, 'src/a.ts'), 'const a = 2;');
		await settle();
		expect(harness.platform.spawned).toHaveLength(2);

		// Restarting brings that server back as a new process with its documents
		// re-opened, so a restart is not a silent loss of context.
		const didOpens = () => trace(harness.logs).filter((line) => line.includes('didOpen')).length;
		const before = didOpens();
		expect(await harness.runtime.restartServer(outer)).toBe(true);
		await waitFor(() => harness.platform.spawned.length === 3, { label: 'the restart' });
		expect(harness.platform.spawned[2].cwd).toBe(root);
		expect(harness.runtime.getStatusRows().find((s) => s.server === outer)?.state).toBe('running');
		await waitFor(() => didOpens() > before, { label: 'the re-opened document' });
		// And the untouched server was neither restarted nor stopped with it.
		expect(harness.platform.pids[1]).toBe(innerPid);
		expect(isProcessAlive(innerPid)).toBe(true);
		expect(harness.runtime.getStatusRows().find((s) => s.server === inner)?.state).toBe('running');
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
		const firstPids = [...harness.platform.pids];

		await harness.runtime.restartAll();

		await waitFor(() => harness.platform.spawned.length === 4, { label: 'both restarts' });
		await waitForRunning(harness.runtime, 2);
		for (const pid of firstPids) {
			await waitFor(() => !isProcessAlive(pid), { label: `old pid ${pid} to exit` });
		}
		// Both roots come back, each against its own project.
		expect(harness.platform.spawned.slice(2).map((s) => s.cwd).sort()).toEqual(
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

		const pids = [...harness.platform.pids];
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
		const [pid] = harness.platform.pids;

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
		await waitFor(() => runtime.getStatusRows()[0]?.state === 'running', { label: 'the server' });
		// Every change is a full-content sync, so each keystroke adds trace lines.
		// Enough of them overflow a 20-entry buffer.
		for (let i = 0; i < 40; i++) {
			await runtime.openDocument({ path, fileName: 'a.ts', content: `const a = ${i};` });
		}
		await settle();

		expect(logs.read()).toHaveLength(20);
		expect(logs.droppedCount).toBeGreaterThan(0);
	});

	it('stays inert, with no server and no failure, when no platform is published', async () => {
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
		expect(logs.read().some((e) => e.message.includes('No LSP platform'))).toBe(true);
	});

	it('reports a server that cannot start, and leaves nothing running', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const harness = await startPlugin(['--mode', 'fail']);
		harness.open(join(root, 'src/a.ts'), '');
		await waitFor(
			() => harness.logs.read().some((e) => e.level === 'error' && e.message.includes('Failed to start')),
			{ label: 'the failed start to be logged' }
		);
		expect(harness.runtime.getStatusRows()[0].state).toBe('failed');
		// A failed start must not leave the failed process behind either.
		for (const pid of harness.platform.pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
	});

	it('gives up on a server that never completes the handshake', async () => {
		// The timeout path #265 depends on: a silent server must not strand the
		// runtime on a document it will never be able to answer.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const { runtime, logs, platform } = await startRuntime({
			script: ['--mode', 'silent'],
			initializeTimeoutMs: 250
		});

		await runtime.openDocument({
			path: join(root, 'src/a.ts'),
			fileName: 'a.ts',
			content: ''
		});
		await settle();

		expect(runtime.getStatusRows()[0].state).toBe('failed');
		expect(logs.read().some((e) => e.message.includes('did not answer "initialize"'))).toBe(true);
		for (const pid of platform.pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
	});
});

/**
 * A document presented while its server is still starting.
 *
 * The workspace opens every restored document in a loop right after session restore,
 * so the second file of a folder always arrives while the first is still
 * handshaking. A document arriving in that window used to be dropped outright: not
 * queued, not retried, not remembered. Nothing sent it but the next
 * `document:opened` or `document:changed` — in practice, the next keystroke — so it
 * offered no server completions and showed no diagnostics until somebody typed in
 * it.
 *
 * Every test here opens both documents before the handshake is allowed to land, and
 * asserts on what the server was actually told to do rather than on the runtime's
 * own account of it. A negative assertion cannot be separated from "the handshake
 * never came back" on its own, so each of them leaves a later successful handshake
 * in reach: a queue that had outlived its server would be flushed by it.
 */
describe('Documents presented while their server is still starting (#264)', () => {
	it('syncs both of two documents presented before the handshake returns, in order', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/first.ts': 'export const first = 1;\n',
			'src/second.ts': 'export const second = 2;\n'
		});
		const gate = makeGate();
		const harness = await startPlugin(gate.script);

		// The restore loop's shape, with nothing awaited between the two opens — that
		// is the whole of the race, and the assertion under them is what makes it
		// provable: neither document had spawned a server yet, so the second one
		// cannot have waited for a handshake that had not begun.
		harness.open(join(root, 'src/first.ts'), 'export const first = 1;\n');
		harness.open(join(root, 'src/second.ts'), 'export const second = 2;\n');
		expect(harness.platform.spawned).toHaveLength(0);

		await waitFor(() => received(harness).some((line) => line.includes('"initialize"')), {
			label: 'the handshake to reach the server'
		});
		// The stub has the request and has not answered it, which is what `starting`
		// means from the client's side.
		expect(harness.runtime.getStatusRows().map((server) => server.state)).toEqual(['starting']);

		gate.release();
		// One is proof enough that the handshake landed *and* the flush has run: that
		// didOpen is written by the server's own process, so it reaches the wire after
		// the flush that follows it. Waiting for two instead would make a runtime that
		// drops the second document look like a slow one.
		await waitFor(() => openedUris(harness).length >= 1, {
			label: 'the first document to reach the server'
		});
		await settle();

		// Both, in the order they were presented. The document that started the server
		// was presented before anything that found it starting, so it goes first and
		// the queue drains behind it.
		expect(openedUris(harness)).toEqual([
			`file://${join(root, 'src/first.ts')}`,
			`file://${join(root, 'src/second.ts')}`
		]);
	});

	it('opens each queued document exactly once, and changes it in place afterwards', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/a.ts': 'export const a = 1;\n',
			'src/b.ts': 'export const b = 2;\n'
		});
		const gate = makeGate();
		const harness = await startPlugin(gate.script);

		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		harness.open(join(root, 'src/b.ts'), 'export const b = 2;\n');
		await waitFor(() => received(harness).some((line) => line.includes('"initialize"')), {
			label: 'the handshake to reach the server'
		});
		gate.release();
		await waitFor(() => openedUris(harness).length >= 1, {
			label: 'a didOpen to reach the server'
		});
		await settle();

		// One per document, not zero and not two: a flush that ran against a server
		// which had already re-presented its own documents would open each of them
		// twice, and the server's version numbering would stop agreeing with the
		// runtime's.
		expect(new Set(openedUris(harness)).size).toBe(2);

		harness.open(join(root, 'src/b.ts'), 'export const b = 3;\n');
		await waitFor(() => received(harness).some((line) => line.includes('didChange')), {
			label: 'the didChange notification'
		});
		expect(openedUris(harness)).toHaveLength(2);
		expect(received(harness).filter((line) => line.includes('didChange'))).toHaveLength(1);
	});

	it('sends nothing for a document queued behind a start that fails', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/a.ts': 'export const a = 1;\n',
			'src/b.ts': 'export const b = 2;\n'
		});
		const gate = makeGate();
		const harness = await startPlugin(gate.script);

		const errors: string[] = [];
		const restore = captureErrors(errors);
		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		harness.open(join(root, 'src/b.ts'), 'export const b = 2;\n');
		await waitFor(() => received(harness).some((line) => line.includes('"initialize"')), {
			label: 'the handshake to reach the server'
		});

		// The process dies under the handshake: a failed start, at the moment the
		// queued document's send would have been redeemed.
		const [pid] = harness.platform.pids;
		harness.platform.spawned[0].process.kill();
		await waitFor(() => harness.runtime.getStatusRows()[0]?.state === 'failed', {
			label: 'the start to be recorded as failed'
		});
		gate.release();
		await settle();
		restore();
		expect(openedUris(harness)).toEqual([]);
		// Contained like every other entry point: a document event cannot throw back
		// at the editor, and a failed server behind it cannot either.
		expect(errors).toEqual([]);

		// The failure does not leave the document queued for the next attempt to send.
		// Its text was as stale as the handshake that never came back, and the next
		// attempt is a handshake this document never asked to wait for.
		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		await waitFor(() => openedUris(harness).length === 1, {
			label: 'the retried document to reach the new server'
		});
		expect(openedUris(harness)).toEqual([`file://${join(root, 'src/a.ts')}`]);
		expect(harness.platform.spawned).toHaveLength(2);
		await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
	});

	it('drops a queued document when its server is stopped before the handshake lands', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/a.ts': 'export const a = 1;\n',
			'src/b.ts': 'export const b = 2;\n'
		});
		const gate = makeGate();
		const harness = await startPlugin(gate.script);

		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		harness.open(join(root, 'src/b.ts'), 'export const b = 2;\n');
		await waitFor(() => received(harness).some((line) => line.includes('"initialize"')), {
			label: 'the handshake to reach the server'
		});
		const [pid] = harness.platform.pids;
		const server = lspServerKey('typescript', root);

		// Stopped while starting: the user changed their mind before the server had
		// finished coming up.
		expect(await harness.runtime.stopServer(server)).toBe(true);
		await waitFor(() => !isProcessAlive(pid), { label: 'the stopped server to exit' });
		gate.release();
		await settle();
		expect(openedUris(harness)).toEqual([]);

		// A server stopped by the user gets no flush it never asked for. The next edit
		// presents its document again and is declined exactly as the one before it was,
		// so neither document reaches a process the user took away.
		harness.open(join(root, 'src/b.ts'), 'export const b = 3;\n');
		await settle();
		expect(openedUris(harness)).toEqual([]);
		expect(harness.platform.spawned).toHaveLength(1);

		// And an explicit restart is no reprieve for the queued document. A restart
		// re-presents the documents bound to the server, and this one was never bound
		// to anything; the flush below is the only thing that could still send it, and
		// that is why presenting a document again is what makes this assertion mean
		// more than "the handshake never came back".
		expect(await harness.runtime.restartServer(server)).toBe(true);
		await waitForRunning(harness.runtime, 1);
		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		await waitFor(() => openedUris(harness).length === 1, {
			label: 'the presented document to reach the restarted server'
		});
		expect(openedUris(harness)).toEqual([`file://${join(root, 'src/a.ts')}`]);
	});

	it('never syncs a queued document whose language is turned off before the handshake lands', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/app.ts': 'export const a = 1;\n',
			'src/view.tsx': 'export const V = () => null;\n'
		});
		const gate = makeGate();
		const harness = await startPlugin(gate.script);

		// One descriptor serves both languages and one process serves both, so both
		// documents are presented to the same handshake — which is the point: a
		// per-process switch could drop the tsx document without ever reaching this
		// queue, and would be wrong.
		harness.open(join(root, 'src/view.tsx'), 'export const V = () => null;\n');
		harness.open(join(root, 'src/app.ts'), 'export const a = 1;\n');
		expect(harness.platform.spawned).toHaveLength(0);
		await waitFor(() => received(harness).some((line) => line.includes('"initialize"')), {
			label: 'the handshake to reach the server'
		});
		expect(harness.runtime.getStatusRows().map((server) => server.state)).toEqual(['starting']);

		// The switch alone, with no edit: the tsx document was presented before the user
		// turned servers off for its language, and the flush reads the gate again
		// exactly because this transition happened while it was waiting. Without that
		// re-read both documents would reach the server, because both are sent by the
		// flush — so this is also the control for the test above.
		harness.setSetting('editor', 'languages', { TSX: { lsp: false } });
		gate.release();
		await waitFor(() => openedUris(harness).length === 1, {
			label: 'the document that was still enabled to reach the server'
		});
		await settle();

		expect(openedUris(harness)).toEqual([`file://${join(root, 'src/app.ts')}`]);
		// And a later edit of the queued document declines rather than finding it
		// still waiting.
		expect(
			await harness.runtime.openDocument({
				path: join(root, 'src/view.tsx'),
				fileName: 'view.tsx',
				content: 'export const V = () => null;\n',
				language: 'TSX'
			})
		).toBeNull();
		expect(openedUris(harness)).toEqual([`file://${join(root, 'src/app.ts')}`]);
	});

	it('leaves nothing behind when the runtime is disposed with a document queued', async () => {
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/a.ts': 'export const a = 1;\n',
			'src/b.ts': 'export const b = 2;\n'
		});
		const gate = makeGate();
		const harness = await startPlugin(gate.script);

		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		harness.open(join(root, 'src/b.ts'), 'export const b = 2;\n');
		await waitFor(() => received(harness).some((line) => line.includes('"initialize"')), {
			label: 'the handshake to reach the server'
		});
		const pids = [...harness.platform.pids];

		await harness.host.deactivate(lspRegistration.manifest.id);
		gate.release();
		await settle();

		// The queue does not outlive the runtime: the handshake the document was
		// waiting on was cancelled with the process, and the gate landing afterwards
		// changes nothing, because there is no process left to send it to.
		expect(openedUris(harness)).toEqual([]);
		expect(harness.runtime.getStatusRows()).toEqual([]);
		expect(harness.settingsListeners()).toBe(0);
		for (const pid of pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}

		// A document event after the disable starts nothing either, so there is no
		// longer anywhere for a surviving document to be flushed to.
		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		await settle();
		expect(openedUris(harness)).toEqual([]);
		expect(harness.platform.spawned).toHaveLength(1);
	});
});

/**
 * `editor.lsp` gates the server, not just the completions.
 *
 * The setting is per language and it decides whether a *document* is scoped to a
 * server at all. Three legs follow from that, and each is asserted here against a
 * real process: no start, no sync, no diagnostics.
 *
 * Two edges of the same rule are asserted with it, because both are decisions that
 * would otherwise be invisible. A server other languages are still using survives
 * the switch — that is the trade, and it is not free. A server whose last served
 * document went does not: a process with nothing to serve is not a server the user
 * has, and a row in the status menu with no document attached is what "this switch
 * does nothing" looks like from the outside.
 */
describe('editor.lsp gates the server for documents of that language (#263)', () => {
	it('starts no server at all, and syncs nothing, for a language turned off', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const harness = await startPlugin([], {
			editor: { lsp: false, languages: { TypeScript: { lsp: false } } }
		});

		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		await settle();

		// No process, which is the whole of it: a switch a user reads as "off"
		// while a server is spawned for the file is the bug this replaces.
		expect(harness.platform.spawned).toHaveLength(0);
		expect(harness.runtime.getStatusRows()).toEqual([]);
		expect(trace(harness.logs).join('\n')).not.toContain('didOpen');
		expect(received(harness)).toEqual([]);
	});

	it('answers a completion query as inactive, which is what the source settles for it', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const { runtime, platform } = await startRuntime({
			settings: { editor: { lsp: false, languages: { typescript: { lsp: false } } } }
		});

		const answer = await runtime.fetch({
			document: {
				path: join(root, 'src/a.ts'),
				fileName: 'a.ts',
				content: 'export const a = 1;\n',
				language: 'typescript'
			},
			line: 0,
			character: 0
		});

		// `inactive` and not `unavailable`: nothing failed and nothing was tried, and
		// the difference is what tells the words source this is the ordinary path.
		expect(answer.state).toBe('inactive');
		expect(platform.spawned).toHaveLength(0);
	});

	it('leaves a language with no descriptor alone, and throws nothing', async () => {
		// Prose has no server either way, so the gate has nothing to withhold. The
		// risk being covered is the opposite of the first test: a gate that fails on
		// the way to deciding there is no server would break every Markdown note.
		const root = makeProject({ 'tsconfig.json': '{}', 'notes.md': '# Notes\n' });
		const harness = await startPlugin([], {
			editor: { lsp: false, languages: { Markdown: { lsp: false } } }
		});

		expect(() => harness.open(join(root, 'notes.md'), '# Notes\n')).not.toThrow();
		await settle();
		expect(harness.platform.spawned).toHaveLength(0);
		expect(harness.runtime.getStatusRows()).toEqual([]);
	});

	it('serves a sibling language from the shared process, without syncing the turned-off one', async () => {
		// One descriptor serves TypeScript and TSX; one process serves both. The gate
		// is per document, so turning it off for TSX must not silence TypeScript —
		// which is what a per-process gate would do, and would be wrong.
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/app.ts': 'export const a = 1;\n',
			'src/view.tsx': 'export const V = () => null;\n'
		});
		const harness = await startPlugin([], {
			editor: { languages: { TSX: { lsp: false } } }
		});

		harness.open(join(root, 'src/view.tsx'), 'export const V = () => null;\n');
		await settle();
		expect(harness.platform.spawned).toHaveLength(0);

		harness.open(join(root, 'src/app.ts'), 'export const a = 1;\n');
		await waitForRunning(harness.runtime, 1);

		expect(harness.platform.spawned).toHaveLength(1);
		// Read off the wire, and waited for there: the protocol trace is written by
		// the client as it sends, so waiting on it only proves the notification left
		// this side, while these assertions are about what the server was told.
		await waitFor(() => received(harness).some((line) => line.includes('didOpen')), {
			label: 'the didOpen the stub received'
		});
		const opened = received(harness).filter((line) => line.includes('didOpen'));
		expect(opened).toHaveLength(1);
		expect(opened[0]).toContain('src/app.ts');
		expect(opened.join('\n')).not.toContain('view.tsx');
	});

	it('stops a server whose last served document is turned off, and leaves no orphan', async () => {
		// The switch, and nothing else. No edit, no document event, no keystroke —
		// because a user who flips a switch while the editor sits idle and has to
		// type next to see it happen concludes the switch is broken.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const harness = await startPlugin();
		harness.open(join(root, 'src/a.ts'), 'export const a = 1;\n');
		await waitForRunning(harness.runtime, 1);
		const [pid] = harness.platform.pids;
		expect(isProcessAlive(pid)).toBe(true);

		harness.setSetting('editor', 'languages', { TypeScript: { lsp: false } });

		// A server nothing is served from any more is not a server the user has, so
		// it leaves the status list rather than sitting there with no document
		// attached. The pid is the assertion; the row is the consequence.
		await waitFor(() => harness.runtime.getStatusRows().length === 0, {
			label: 'the emptied server to leave the status list'
		});
		await waitFor(() => !isProcessAlive(pid), { label: 'the stopped server to exit' });
		// One process for the whole thing: nothing was started or restarted on the
		// way out.
		expect(harness.platform.pids).toEqual([pid]);
		// And the document said so on the wire rather than going stale in the
		// server's copy of it.
		await waitFor(() => received(harness).some((line) => line.includes('didClose')), {
			label: 'the didClose notification'
		});
	});

	it('keeps a server running while another language of the same process is enabled', async () => {
		// The trade the gate still makes: a settings toggle must not kill a process
		// other open files depend on. One descriptor serves both languages and one
		// process serves both, so turning `lsp` off for TSX closes the tsx document
		// and leaves the process alone.
		const root = makeProject({
			'tsconfig.json': '{}',
			'src/app.ts': 'export const a = 1;\n',
			'src/view.tsx': 'export const V = () => null;\n'
		});
		const harness = await startPlugin();
		harness.open(join(root, 'src/app.ts'), 'export const a = 1;\n');
		await waitFor(() => received(harness).some((line) => line.includes('didOpen')), {
			label: 'the ts didOpen'
		});
		harness.open(join(root, 'src/view.tsx'), 'export const V = () => null;\n');
		await waitFor(() => received(harness).filter((line) => line.includes('didOpen')).length === 2, {
			label: 'the tsx didOpen'
		});
		const [pid] = harness.platform.pids;

		harness.setSetting('editor', 'languages', { TSX: { lsp: false } });

		await waitFor(
			() => received(harness).some((line) => line.includes('view.tsx') && line.includes('didClose')),
			{ label: 'the tsx didClose' }
		);
		await settle();
		expect(isProcessAlive(pid)).toBe(true);
		expect(harness.platform.pids).toEqual([pid]);
		expect(harness.runtime.getStatusRows()[0].state).toBe('running');
		// And the ts document was not closed with it: the process still holds it.
		expect(received(harness).some((line) => line.includes('didClose') && line.includes('app.ts'))).toBe(
			false
		);
	});

	it('does no work for a settings change that flips no gate', async () => {
		// The notification is not "your setting changed": it is "something changed",
		// and by a wide margin the something is unrelated — another key in this
		// namespace, or another plugin's namespace entirely. Re-evaluating has to
		// cost two settings reads per synced document and nothing more.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const base = createRealProcessPlatform();
		let probes = 0;
		// The same platform with its filesystem question counted. The spawned and pid
		// lists are the base's own arrays, so one process is one process from either
		// end.
		const counted: RealProcessPlatform = {
			spawned: base.spawned,
			pids: base.pids,
			fileExists: async (path) => {
				probes++;
				return base.fileExists(path);
			},
			spawn: (options) => base.spawn(options)
		};
		const { runtime, setSetting } = await startRuntime({
			settings: { editor: { lsp_fetch_timeout_ms: 0 } },
			platform: counted
		});

		await runtime.openDocument({ path: join(root, 'src/a.ts'), fileName: 'a.ts', content: '' });
		await waitForRunning(runtime, 1);
		await runtime.openDocument({ path: join(root, 'src/b.ts'), fileName: 'b.ts', content: '' });
		await settle();
		// The control: resolving a document walks the filesystem, so the counter does
		// move. Without this a zero below would only prove the counter cannot count.
		expect(probes).toBeGreaterThan(0);
		const walked = probes;
		const spawned = base.spawned.length;

		setSetting('editor', 'lsp_fetch_timeout_ms', 900);
		await settle();

		expect(probes).toBe(walked);
		expect(base.spawned).toHaveLength(spawned);
		expect(runtime.getStatusRows()[0].state).toBe('running');
		expect(isProcessAlive(base.pids[0])).toBe(true);

		// The same subscription, on a change that does flip a gate: a negative
		// assertion about work not done cannot tell "cheap" from "never ran", so the
		// next line is what makes the one above mean what it says.
		setSetting('editor', 'languages', { TypeScript: { lsp: false } });
		await waitFor(() => runtime.getStatusRows().length === 0, {
			label: 'the emptied server to leave the status list'
		});
		await waitFor(() => !isProcessAlive(base.pids[0]), { label: 'the stopped server to exit' });
	});

	it('ignores a settings change once the plugin is disabled', async () => {
		// The subscription is the runtime's, so the disable has to take it with it:
		// a runtime that outlived its own subscription would keep answering settings
		// changes for the rest of the session, and the next activation would find a
		// second one.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': '' });
		const harness = await startPlugin();
		harness.open(join(root, 'src/a.ts'), '');
		await waitForRunning(harness.runtime, 1);
		const [pid] = harness.platform.pids;
		expect(harness.settingsListeners()).toBe(1);

		await harness.host.deactivate(lspRegistration.manifest.id);
		await waitFor(() => !isProcessAlive(pid), { label: 'the disabled plugin to leave no orphan' });
		expect(harness.runtime.getStatusRows()).toEqual([]);
		// The subscription went with it. A disposed runtime ignores what it hears, so
		// the leak has no other symptom — which is exactly why it has to be pinned
		// here rather than left to the guard that hides it.
		expect(harness.settingsListeners()).toBe(0);

		expect(() => harness.setSetting('editor', 'languages', { TypeScript: { lsp: false } })).not.toThrow();
		await settle();
		expect(harness.platform.spawned).toHaveLength(1);
		expect(harness.runtime.getStatusRows()).toEqual([]);
	});

	it('drops a report about a document whose language is turned off', async () => {
		// The server is running because a *sibling* language is served, and it has an
		// opinion about a file it was never asked about — which is what a
		// project-wide indexer does, and which is why dropping the report cannot be
		// left to "the document was never synced". The setting says this document is
		// not diagnosed, so nothing reaches the store.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const tsxUri = `file://${join(root, 'src/view.tsx')}`;
		const { runtime, diagnostics } = await startRuntime({
			script: ['--diagnostic-uri', tsxUri],
			settings: { editor: { languages: { TSX: { lsp: false } } } }
		});

		// Declined before anything is scoped to it, so the stub never learns of it.
		expect(
			await runtime.openDocument({
				path: join(root, 'src/view.tsx'),
				fileName: 'view.tsx',
				content: 'export const V = () => null;\n',
				language: 'TSX'
			})
		).toBeNull();

		await runtime.openDocument({
			path: join(root, 'src/a.ts'),
			fileName: 'a.ts',
			content: 'export const a = 1;\n',
			language: 'typescript'
		});
		await waitForRunning(runtime, 1);
		await settle();

		expect(diagnostics.uris()).toEqual([]);
		expect(diagnostics.read(tsxUri)).toEqual([]);
	});

	it('files that same unsolicited report when the language is on, so the drop is the gate', async () => {
		// The control for the test above. Without it, a stub that published nothing
		// would make that test pass for the wrong reason, and "no diagnostics" would
		// be indistinguishable from "no server".
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const tsxUri = `file://${join(root, 'src/view.tsx')}`;
		const { runtime, diagnostics } = await startRuntime({
			script: ['--diagnostic-uri', tsxUri]
		});

		await runtime.openDocument({
			path: join(root, 'src/a.ts'),
			fileName: 'a.ts',
			content: 'export const a = 1;\n',
			language: 'typescript'
		});
		await waitForRunning(runtime, 1);
		await waitFor(() => diagnostics.uris().includes(tsxUri), {
			label: 'the unsolicited report to be filed'
		});

		expect(diagnostics.read(tsxUri)).toHaveLength(2);
		expect(diagnostics.read(tsxUri).map((d) => d.severity).sort()).toEqual(['error', 'warning']);
	});

	it('clears a painted diagnostic when the language is turned off afterwards', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const settings: Record<string, Record<string, unknown>> = {};
		const { runtime, platform, diagnostics, setSetting } = await startRuntime({
			script: ['--diagnostics'],
			settings
		});
		const uri = `file://${join(root, 'src/a.ts')}`;

		await runtime.openDocument({
			path: join(root, 'src/a.ts'),
			fileName: 'a.ts',
			content: 'export const a = 1;\n'
		});
		await waitForRunning(runtime, 1);
		await waitFor(() => diagnostics.read(uri).length > 0, { label: 'the painted diagnostic' });
		expect(diagnostics.read(uri)).toHaveLength(2);

		setSetting('editor', 'languages', { typescript: { lsp: false } });
		// The setting alone, with no edit: the gate says this document is not
		// diagnosed, so what was already painted has to go without waiting to be
		// told twice.
		await waitFor(() => diagnostics.read(uri).length === 0, {
			label: 'the painted diagnostic to clear'
		});
		expect(diagnostics.uris()).toEqual([]);
		// And the process goes with it, because this was the last document the
		// server was serving.
		for (const pid of platform.pids) {
			await waitFor(() => !isProcessAlive(pid), { label: `pid ${pid} to exit` });
		}
		expect(runtime.getStatusRows()).toEqual([]);

		// A later edit still declines, rather than finding a stopped entry and
		// starting it again.
		expect(
			await runtime.openDocument({
				path: join(root, 'src/a.ts'),
				fileName: 'a.ts',
				content: 'export const a = 2;\n'
			})
		).toBeNull();
		expect(platform.pids).toHaveLength(1);
		expect(diagnostics.read(uri)).toEqual([]);
	});

	it('keeps the runtime serving every language when no settings reader is published', async () => {
		// The absence has to be the documented default. A runtime that read `lsp` as
		// off because nothing published settings would silently serve nothing, and
		// nothing about that would look like a setting.
		const root = makeProject({ 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1;\n' });
		const host = new PluginHost({ platform: 'desktop' });
		host.register(lspRegistration);
		await host.activate(lspRegistration.manifest.id);
		cleanups.push(async () => {
			if (host.isPluginActive(lspRegistration.manifest.id)) {
				await host.deactivate(lspRegistration.manifest.id);
			}
		});
		const platform = createRealProcessPlatform();
		const runtime = new LspRuntime({
			host,
			pluginId: lspRegistration.manifest.id,
			logs: new LspLogStore(),
			platform
		});
		// A second runtime over a host whose plugin is already active, so this one has
		// to be torn down by hand: the deactivate cleanup below disposes the plugin's
		// runtime, not this one.
		cleanups.push(() => runtime.dispose());

		await runtime.openDocument({
			path: join(root, 'src/a.ts'),
			fileName: 'a.ts',
			content: 'export const a = 1;\n'
		});
		await waitFor(() => runtime.getStatusRows().some((s) => s.state === 'running'), {
			label: 'the server to start with no reader published'
		});
		expect(runtime.getStatusRows()[0].state).toBe('running');
	});
});
