import '../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import {
	PluginHost,
	lspRegistration,
	LSP_DIAGNOSTICS_STORE_SERVICE_KEY,
	type LspDiagnostic,
	type LspDiagnosticsStore
} from '@np/core';
import { diagnosticsView, type DiagnosticsView } from './diagnostics-tab';

/**
 * What the diagnostics tab decides, over the merged store (spec #309, issue
 * #309, ADR 0022, ADR 0029).
 *
 * The store is the one the plugin publishes and the editor's underlines read,
 * so what the tab shows and what the editor paints cannot drift apart. The
 * findings arrive the way they arrive in the app: one file pushed by a server,
 * one file pulled from it, and the tab reads both out of the same place.
 */

const hosts: PluginHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) {
		if (host.isPluginActive('lsp')) await host.deactivate('lsp');
	}
});

async function startStore(): Promise<LspDiagnosticsStore> {
	const host = new PluginHost({ platform: 'desktop' });
	hosts.push(host);
	host.register(lspRegistration);
	await host.activate('lsp');
	const store = host.getService<LspDiagnosticsStore>(LSP_DIAGNOSTICS_STORE_SERVICE_KEY);
	if (!store) throw new Error('the plugin published no diagnostics store');
	return store;
}

const ALPHA = 'file:///repo/src/alpha.ts';
const BETA = 'file:///repo/src/beta.ts';

const ALPHA_TEXT = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n');
const BETA_TEXT = ['alpha', 'beta', 'gamma'].join('\n');

function finding(
	severity: LspDiagnostic['severity'],
	line: number,
	message: string
): LspDiagnostic {
	return {
		server: 'ts@/repo',
		range: {
			start: { line, character: 0 },
			end: { line, character: 4 }
		},
		severity,
		message,
		source: 'ts',
		code: null
	};
}

async function seededStore(): Promise<LspDiagnosticsStore> {
	const store = await startStore();
	store.publish({
		uri: ALPHA,
		server: 'ts@/repo',
		diagnostics: [finding('error', 2, "Type 'x' is missing."), finding('warning', 0, 'Unused variable.')]
	});
	store.pull({
		uri: BETA,
		server: 'ts@/repo',
		diagnostics: [finding('info', 1, 'Prefer const.')]
	});
	return store;
}

function readText(path: string): string | undefined {
	if (path === '/repo/src/alpha.ts') return ALPHA_TEXT;
	if (path === '/repo/src/beta.ts') return BETA_TEXT;
	return undefined;
}

function view(store: LspDiagnosticsStore, sort: 'severity' | 'path' = 'severity'): DiagnosticsView {
	return diagnosticsView(store, {
		filter: 'all',
		sort,
		readText,
		rootPath: '/repo'
	});
}

function messages(v: DiagnosticsView): string[] {
	return v.entries.map((entry) => entry.message);
}

describe('the diagnostics tab over the merged store', () => {
	it('shows every finding the store holds, the most serious first', async () => {
		const store = await seededStore();

		expect(messages(view(store))).toEqual([
			"Type 'x' is missing.",
			'Unused variable.',
			'Prefer const.'
		]);
	});

	it('groups the findings of one file under that file', async () => {
		const store = await seededStore();

		const sections = view(store).sections;
		expect(sections.map((section) => section.filepath)).toEqual(['src/alpha.ts', 'src/beta.ts']);
		expect(sections[0]!.entries.map((entry) => entry.message)).toEqual([
			"Type 'x' is missing.",
			'Unused variable.'
		]);
	});

	it('narrows the findings to one severity', async () => {
		const store = await seededStore();

		const errors = diagnosticsView(store, { filter: 'error', sort: 'severity', readText });

		expect(messages(errors)).toEqual(["Type 'x' is missing."]);
	});

	it('reads the files in order when the sort is by path', async () => {
		const store = await seededStore();

		expect(messages(view(store, 'path'))).toEqual([
			'Unused variable.',
			"Type 'x' is missing.",
			'Prefer const.'
		]);
	});

	it('carries the lines around each finding', async () => {
		const store = await seededStore();

		const excerpt = view(store).entries[0]!.excerpt;
		expect(excerpt?.map((line) => line.number)).toEqual([1, 2, 3, 4, 5]);
		expect(excerpt?.map((line) => line.text)).toEqual([
			'line one',
			'line two',
			'line three',
			'line four',
			'line five'
		]);
		expect(excerpt?.map((line) => line.flagged)).toEqual([false, false, true, false, false]);
	});

	it('still lists a finding whose file has no text to show', async () => {
		const store = await seededStore();

		const withoutText = diagnosticsView(store, { filter: 'all', sort: 'severity' });

		expect(messages(withoutText)).toHaveLength(3);
		const beta = withoutText.entries.find((entry) => entry.message === 'Prefer const.')!;
		expect(beta.excerpt).toBeNull();
	});

	it('reads nothing but the store\'s public surface', async () => {
		const store = await seededStore();
		// A reader with the store's shape and nothing else: no client, no
		// protocol, no runtime.
		const reader = {
			read: (uri: string) => (uri === ALPHA ? store.read(uri) : []),
			uris: () => [ALPHA]
		};

		const fromReader = diagnosticsView(reader, { filter: 'all', sort: 'severity' });

		expect(messages(fromReader)).toEqual(["Type 'x' is missing.", 'Unused variable.']);
	});
});
