import '../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { IconRegistry } from './icons.svelte';

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubThemeFetch(ok = true) {
	return mock(async (url: string) => {
		if (!ok) return { ok: false, json: async () => ({}) } as Response;
		return {
			ok: true,
			json: async () => ({
				name: 'Fake Theme',
				themes: [{ name: 'Fake', appearance: 'dark', file_icons: { default: { path: 'file.svg' } } }]
			})
		} as unknown as Response;
	});
}

describe('IconRegistry builtin file themes', () => {
	it('does not fetch any theme at init when the active theme is phosphor', async () => {
		const fetchMock = stubThemeFetch();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const registry = new IconRegistry();
		await registry.initialize();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('lists unloaded builtins without fetching them', () => {
		const registry = new IconRegistry();
		const ids = registry.getAvailableFileThemes().map((theme) => theme.id);
		expect(ids).toContain('phosphor');
		expect(ids).toContain('material');
		expect(ids).toContain('catppuccin');
		expect(ids).toContain('vscode');
		expect(registry.getFileThemes().map((theme) => theme.id)).toEqual(['phosphor']);
	});

	it('loads a selected builtin on demand and registers it', async () => {
		const fetchMock = stubThemeFetch();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const registry = new IconRegistry();
		await registry.ensureFileTheme('material');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(registry.getFileThemes().some((theme) => theme.id === 'material')).toBe(true);
	});

	it('does not register a theme when the CDN fails', async () => {
		globalThis.fetch = stubThemeFetch(false) as unknown as typeof fetch;
		const registry = new IconRegistry();
		await registry.ensureFileTheme('material');
		expect(registry.getFileThemes().some((theme) => theme.id === 'material')).toBe(false);
	});

	it('fetches once for concurrent requests', async () => {
		const fetchMock = stubThemeFetch();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const registry = new IconRegistry();
		await Promise.all([
			registry.ensureFileTheme('material'),
			registry.ensureFileTheme('material')
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
