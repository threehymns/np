import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { PluginHost } from '../host.svelte';
import { LSP_DIAGNOSTICS_STORE_SERVICE_KEY, type LspDiagnosticsStore } from './diagnostics';
import { lspRegistration } from './registration';

/**
 * The merged store the diagnostics tab reads (spec #309, ADR 0022, ADR 0029).
 *
 * The tab is a view over the store, so the store has to be reachable without
 * the tab importing plugin internals: it is published under a service key, the
 * way the log store is published for the Logs tab (ADR 0008). What is pinned
 * here is that the published store is the one the editor's marks read — a tab
 * pointed at a second store would show findings the editor does not paint.
 */

const hosts: PluginHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) {
		if (host.isPluginActive('lsp')) await host.deactivate('lsp');
	}
});

async function startLsp(): Promise<LspDiagnosticsStore> {
	const host = new PluginHost({ platform: 'desktop' });
	hosts.push(host);
	host.register(lspRegistration);
	await host.activate('lsp');
	const store = host.getService<LspDiagnosticsStore>(LSP_DIAGNOSTICS_STORE_SERVICE_KEY);
	if (!store) throw new Error('the plugin published no diagnostics store');
	return store;
}

describe('the diagnostics store the tab reads', () => {
	it('is the store a server report lands in', async () => {
		const store = await startLsp();

		store.publish({
			uri: 'file:///repo/a.ts',
			server: 'ts@/repo',
			diagnostics: [
				{
					server: 'ts@/repo',
					range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
					severity: 'error',
					message: 'Cannot find name.',
					source: 'ts',
					code: '2304'
				}
			]
		});

		expect(store.read('file:///repo/a.ts').map((d) => d.message)).toEqual(['Cannot find name.']);
	});

	it('carries a pulled report as well as a pushed one', async () => {
		const store = await startLsp();

		store.pull({
			uri: 'file:///repo/b.ts',
			server: 'ts@/repo',
			diagnostics: [
				{
					server: 'ts@/repo',
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					severity: 'warning',
					message: 'Unused.',
					source: null,
					code: null
				}
			]
		});

		expect(store.read('file:///repo/b.ts').map((d) => d.severity)).toEqual(['warning']);
	});
});
