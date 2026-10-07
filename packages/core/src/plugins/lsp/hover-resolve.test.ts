import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PluginHost } from '../host.svelte';
import { lspRegistration } from './registration';
import { LSP_LOG_STORE_SERVICE_KEY, LspLogStore } from './logs';
import { LspRuntime, LSP_RUNTIME_SERVICE_KEY, lspServerKey } from './lifecycle';
import { LspDiagnosticsStore } from './diagnostics';
import { LSP_PLATFORM_SERVICE_KEY, SETTINGS_READER_SERVICE_KEY } from '../services';
import {
	createRealProcessPlatform,
	waitFor,
	type RealProcessPlatform
} from '../../../../../tests/fixtures/lsp-platform';

/**
 * Hover presentation and the `completionItem/resolve` round trip (spec #280).
 *
 * Hover is its own `textDocument/hover` request with no resolve phase (#292);
 * resolve rides with it as the doc-fill path because it has no display surface
 * of its own (#295). Both run against the scripted stub over real pipes, so
 * framing, handshake and request are genuinely exercised.
 */

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

function makeProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'lsp-hover-'));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

function settingsReader(store: Record<string, Record<string, unknown>>) {
	const listeners = new Set<() => void>();
	return {
		read: (namespace: string, key: string) => store[namespace]?.[key],
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}

async function startPlugin(script: readonly string[] = []) {
	const host = new PluginHost({ platform: 'desktop' });
	const wireLog = join(makeProject({}), 'wire.log');
	const platform = createRealProcessPlatform({ script: [...script, '--log-file', wireLog] });
	host.provideService(LSP_PLATFORM_SERVICE_KEY, platform);
	host.provideService(SETTINGS_READER_SERVICE_KEY, {
		...settingsReader({}),
	});
	host.register(lspRegistration);
	await host.activate(lspRegistration.manifest.id);
	cleanups.push(async () => {
		if (host.isPluginActive(lspRegistration.manifest.id)) {
			await host.deactivate(lspRegistration.manifest.id);
		}
	});
	const runtime = host.getService<LspRuntime>(LSP_RUNTIME_SERVICE_KEY)!;
	const logs = host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY)!;
	return { host, platform, runtime, logs, wireLog };
}

function received(wireLog: string): string[] {
	try {
		return readFileSync(wireLog, 'utf-8').split('\n').filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

function docFor(root: string, name = 'a.ts', content = 'const x = Widget;\n') {
	return {
		path: join(root, name),
		fileName: name,
		content,
		language: 'TypeScript' as const
	};
}

describe('textDocument/hover', () => {
	it('renders type, signature and documentation for a symbol the server reports', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const x = Widget;\n' });
		const { runtime } = await startPlugin([]);

		const answer = await runtime.fetchHover({ document: docFor(root), line: 0, character: 10 });

		expect(answer.state).toBe('serving');
		if (answer.state !== 'serving') return;
		expect(answer.hover).not.toBeNull();
		expect(answer.hover?.contents).toContain('(class) Widget');
		expect(answer.hover?.contents).toContain('A thing with an id');
	}, 30_000);

	it('hovers to nothing rather than to an error when the server reports nothing', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const x = 1;\n' });
		const { runtime } = await startPlugin(['--mode', 'no-hover']);

		const answer = await runtime.fetchHover({ document: docFor(root), line: 0, character: 2 });

		expect(answer.state).toBe('serving');
		if (answer.state !== 'serving') return;
		expect(answer.hover).toBeNull();
	}, 30_000);

	it('is inactive for prose nothing serves, leaving note hovers alone', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'note.md': '# hello\n' });
		const { runtime } = await startPlugin([]);

		const answer = await runtime.fetchHover({
			document: { path: join(root, 'note.md'), fileName: 'note.md', content: '# hello\n', language: 'Markdown' },
			line: 0,
			character: 2
		});

		expect(answer.state).toBe('inactive');
	}, 30_000);

	it('is unavailable when hover itself fails, degrading to no tooltip', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const x = 1;\n' });
		const { runtime } = await startPlugin(['--mode', 'fail-hover']);

		const answer = await runtime.fetchHover({ document: docFor(root), line: 0, character: 2 });

		expect(answer.state).toBe('unavailable');
	}, 30_000);
});

describe('completionItem/resolve', () => {
	it('asks for the part the item withheld, filling docs and detail immediately', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const w = wid' });
		const { runtime, wireLog } = await startPlugin(['--mode', 'lazy-docs']);
		const document = docFor(root, 'a.ts', 'const w = wid');

		const fetched = await runtime.fetch({
			document,
			line: 0,
			character: 'const w = wid'.length
		});
		expect(fetched.state).toBe('serving');
		if (fetched.state !== 'serving') return;
		// Withheld: the stub sent no docs in lazy mode.
		expect(fetched.items[0].documentation).toBeNull();

		const resolved = await runtime.resolveCompletion(document, fetched.items[0]);

		expect(resolved.documentation).toContain('A thing with an id');
		expect(resolved.detail).toBe('(class) Widget');
		await waitFor(() => received(wireLog).some((line) => line.includes('completionItem/resolve')), {
			label: 'the resolve request on the wire'
		});
	}, 30_000);

	it('resolves once-only: a second request for the same item costs no round trip', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const w = wid' });
		const { runtime, wireLog } = await startPlugin(['--mode', 'lazy-docs']);
		const document = docFor(root, 'a.ts', 'const w = wid');

		const fetched = await runtime.fetch({ document, line: 0, character: 13 });
		if (fetched.state !== 'serving') return;

		await runtime.resolveCompletion(document, fetched.items[0]);
		await waitFor(() => received(wireLog).filter((l) => l.includes('completionItem/resolve')).length >= 1, {
			label: 'the first resolve'
		});
		const before = received(wireLog).filter((l) => l.includes('completionItem/resolve')).length;

		await runtime.resolveCompletion(document, fetched.items[0]);
		// Settled without another request: once-only.
		expect(received(wireLog).filter((l) => l.includes('completionItem/resolve'))).toHaveLength(before);
	}, 30_000);

	it('resolves the visible window plus-minus four, skipping documented items except the selection', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const w = wid' });
		const { runtime } = await startPlugin(['--mode', 'lazy-docs']);
		const document = docFor(root, 'a.ts', 'const w = wid');

		// Ten items sharing one label but distinct data, so each is its own
		// resolve key. Index 0 already documented (nothing withheld).
		const items = Array.from({ length: 10 }, (_, i) => ({
			label: 'Widget',
			insertText: 'Widget',
			detail: null as string | null,
			documentation: i === 0 ? 'already here' : null,
			kind: 7 as number | null,
			replaceRange: null,
			data: { id: i }
		}));
		// Selection at 5: window is 1..9, so 0 stays untouched either way.
		const resolved = await runtime.resolveVisible(document, items, 5);

		expect(resolved[0].documentation).toBe('already here');
		for (let i = 1; i <= 9; i++) {
			expect(resolved[i].documentation).toContain('A thing with an id');
		}
	}, 30_000);

	it('keeps the unresolved item when resolve fails, rather than failing the popover', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const w = wid' });
		const { runtime } = await startPlugin(['--mode', 'fail-resolve']);
		const document = docFor(root, 'a.ts', 'const w = wid');

		const fetched = await runtime.fetch({ document, line: 0, character: 13 });
		if (fetched.state !== 'serving') return;

		const resolved = await runtime.resolveCompletion(document, fetched.items[0]);
		expect(resolved.documentation).toBe(fetched.items[0].documentation);
	}, 30_000);

	it('gates resolve on the server announcing resolveProvider', async () => {
		const root = makeProject({ 'tsconfig.json': '{}', 'a.ts': 'const w = wid' });
		const { runtime } = await startPlugin([]);
		const document = docFor(root, 'a.ts', 'const w = wid');

		// The stub announces resolveProvider:true, so the gate is open.
		await runtime.fetch({ document, line: 0, character: 13 });
		const server = lspServerKey('typescript', root);
		expect(runtime.canResolve(server)).toBe(true);
		expect(runtime.canHover(server)).toBe(true);
	}, 30_000);
});
