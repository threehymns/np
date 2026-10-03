import type { PluginCleanup, PluginHostInterface } from '../types';
import { manifest } from './manifest';
import { SVELTE_SNIPPETS } from './snippets';

/**
 * Setup for the Svelte Language Core Plugin.
 *
 * Registers metadata plus a zero-argument loader and performs no grammar
 * import of its own: the grammar package is reachable only through the
 * dynamic `import()` inside the loader, keeping it in its own lazy chunk.
 * Enabling costs nothing at startup (metadata only); the host calls the
 * loader on first tab mount, language switch, or fenced-block render, and
 * the module cache makes later loads free.
 *
 * The snippet pack registers in the same `setup` as the language it joins
 * on, so the triggers cannot outlive the language that gives them a
 * completion source to attach to.
 */
export function setup(host: PluginHostInterface): PluginCleanup | void {
	host.registerLanguages(manifest.id, [
		{
			name: 'svelte',
			aliases: ['sv', 'svelte'],
			extensions: ['svelte'],
			load: async () => {
				const mod = await import('@replit/codemirror-lang-svelte');
				return mod.svelte();
			}
		}
	]);
	host.registerSnippets(manifest.id, SVELTE_SNIPPETS);
}
