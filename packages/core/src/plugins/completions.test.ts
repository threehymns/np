import '../../../../tests/contract/rune-setup';
import { describe, it, expect } from 'bun:test';
import { PluginHost } from './host.svelte';
import { svelteLanguageRegistration } from './svelte-language/registration';
import { SVELTE_SNIPPETS } from './svelte-language/snippets';
import { DuplicateSnippetIdError, PluginActivationError } from './errors';
import type { PluginHostInterface } from './types';
import type { SnippetRecord } from './completions';

function svelteSnippets(): SnippetRecord[] {
	return [
		{ id: 'each', language: 'svelte', trigger: 'each', body: '{#each}', description: 'Each block' }
	];
}

function tsSnippets(): SnippetRecord[] {
	// Plain body, per `SnippetRecord.body`: no `$1`, no tab stops.
	return [
		{ id: 'log', language: 'typescript', trigger: 'log', body: 'console.log(value);', description: 'Log' }
	];
}

/** Every (id, language, trigger) triple, in registry order. */
function shape(host: PluginHost): string[] {
	return host.getSnippets().map((s) => `${s.id}|${s.language}|${s.trigger}`);
}

describe('Snippet Pack registry interface (#262)', () => {
	it('ships no snippets until a plugin registers a pack', () => {
		const host = new PluginHost();
		expect(host.getSnippets()).toEqual([]);
	});

	it('materializes the Svelte pack through the same setup as its language', async () => {
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		expect(host.getSnippets()).toEqual([]);

		await host.activate(svelteLanguageRegistration.manifest.id);

		const snippets = host.getSnippetsForLanguage('svelte');
		expect(snippets.length).toBe(SVELTE_SNIPPETS.length);
		// Joins on the identity the language registry publishes, and every
		// record carries a body and a description with an owning plugin.
		expect(host.getLanguageForFile('App.svelte')?.name).toBe('svelte');
		for (const snippet of snippets) {
			expect(snippet.owner).toBe(svelteLanguageRegistration.manifest.id);
			expect(snippet.body.length).toBeGreaterThan(0);
			expect(snippet.description.length).toBeGreaterThan(0);
			expect(snippet.trigger.length).toBeGreaterThan(0);
		}
		expect(snippets.map((s) => s.id).sort()).toEqual(SVELTE_SNIPPETS.map((s) => s.id).sort());
		// No other language gets offers out of the pack.
		expect(host.getSnippetsForLanguage('typescript')).toEqual([]);
		await host.deactivate(svelteLanguageRegistration.manifest.id);
	});

	it('joins on language identity case-insensitively, like the editor contributions', async () => {
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		await host.activate(svelteLanguageRegistration.manifest.id);

		expect(host.getSnippetsForLanguage('SVELTE').length).toBe(SVELTE_SNIPPETS.length);
		await host.deactivate(svelteLanguageRegistration.manifest.id);
	});

it('reaches plugin code through the host proxy, not just through the host', async () => {
		// The proxy allow-list is hand-written: a member missing from it makes
		// plugin code throw UnknownPluginHostMethodError at activation.
		const host = new PluginHost();
		let viaProxy: PluginHostInterface | null = null;
		host.register({
			manifest: { id: 'probe', name: 'Probe', version: 0 },
				setup: (received) => {
					viaProxy = received;
					received.registerSnippets('probe', svelteSnippets());
				}
		});
		await host.activate('probe');

		const pluginHost = viaProxy!;
		expect(pluginHost.getSnippets()).toHaveLength(1);
		expect(pluginHost.getSnippetsForLanguage('SVELTE')).toHaveLength(1);
		expect(pluginHost.snippetRevision).toBeGreaterThan(0);
		// A reload must be lossless: same records, same owners, no duplicates,
		// and the revision bumped so the editor rebuilds its chain.
		const before = shape(host);
		const revisionBefore = pluginHost.snippetRevision;
		pluginHost.refreshSnippets();
		expect(shape(host)).toEqual(before);
		expect(host.getSnippets().map((s) => s.owner)).toEqual(['probe']);
		expect(pluginHost.snippetRevision).toBeGreaterThan(revisionBefore);
		pluginHost.removePluginSnippets('probe');
		expect(pluginHost.getSnippets()).toEqual([]);
		await host.deactivate('probe');
	});

	it('reloads the same records without duplicate errors, even when a refresh transform re-emits them', () => {
		// The failure mode this guards: a refresh transform that rebuilds every
		// record with a fresh object identity looks like a fresh claim. Ownership
		// must follow the record, not the transform that ran last — otherwise a
		// reload either mis-attributes the record or raises a duplicate error
		// against the plugin that actually wrote it.
		const host = new PluginHost();
		host.registerSnippets('plug-a', svelteSnippets());
		const before = host.getSnippets();

		host.registerSnippetTransform('refresh', (previous) =>
			new Map([...previous].map(([id, snippet]) => [id, { ...snippet }]))
		);
		expect(() => host.refreshSnippets()).not.toThrow();

		const after = host.getSnippets();
		expect(after).toEqual(before);
		expect(after.map((s) => s.owner)).toEqual(['plug-a']);

		// And it stays stable across repeated refreshes.
		host.rebuildSnippets();
		expect(host.getSnippets()).toEqual(before);
		expect(() => host.refreshSnippets()).not.toThrow();
		expect(host.getSnippets().map((s) => s.owner)).toEqual(['plug-a']);
	});

	it('still reports a genuine second claim of one id', () => {
		const host = new PluginHost();
		host.registerSnippets('plug-a', svelteSnippets());

		expect(() =>
			host.registerSnippets('plug-b', [
				{ id: 'each', language: 'svelte', trigger: 'each', body: 'b', description: 'B' }
			])
		).toThrow(DuplicateSnippetIdError);
	});

	it('leaves the registry usable after a direct duplicate claim is rejected', () => {
		const host = new PluginHost();
		host.registerSnippets('plug-a', svelteSnippets());

		// A direct host call has no plugin activation to roll back, so the
		// rejected transform must never reach `snippetTransforms` in the first
		// place — otherwise it poisons every later rebuild.
		expect(() =>
			host.registerSnippets('plug-b', [
				{ id: 'each', language: 'svelte', trigger: 'each', body: 'b', description: 'B' }
			])
		).toThrow(DuplicateSnippetIdError);

		// An unrelated id, so this can only succeed if the failure above left
		// no residue. It used to throw, naming plug-a and plug-b.
		host.registerSnippets('plug-c', [
			{ id: 'unrelated', language: 'svelte', trigger: 'u', body: 'c', description: 'C' }
		]);
		expect(host.getSnippets().map((s) => s.id).sort()).toEqual(['each', 'unrelated']);
	});

	it('binds the owner to the registering plugin, not to the contribution', () => {
		const host = new PluginHost();
		host.registerSnippets('plug-a', svelteSnippets());

		expect(host.getSnippets().map((s) => s.owner)).toEqual(['plug-a']);
	});

	it('bumps a snippet revision counter on every rebuild', async () => {
		const host = new PluginHost();
		const base = host.snippetRevision;
		host.registerSnippetTransform('core.snippets', (prev) => new Map(prev));
		expect(host.snippetRevision).toBeGreaterThan(base);
		const afterTransform = host.snippetRevision;

		host.register({
			manifest: { id: 'plug-rev', name: 'PlugRev', version: 0 },
			setup: (h) => {
				h.registerSnippets('plug-rev', tsSnippets());
			}
		});
		await host.activate('plug-rev');
		expect(host.snippetRevision).toBeGreaterThan(afterTransform);
		const afterActivate = host.snippetRevision;

		await host.deactivate('plug-rev');
		expect(host.snippetRevision).toBeGreaterThan(afterActivate);
	});

	it('rejects one snippet id claimed by two owners and rolls the plugin back', async () => {
		const host = new PluginHost();
		host.register({
			manifest: { id: 'plug-a', name: 'A', version: 0 },
			setup: (h) => {
				h.registerSnippets('plug-a', svelteSnippets());
			}
		});
		host.register({
			manifest: { id: 'plug-b', name: 'B', version: 0 },
			setup: (h) => {
				h.registerSnippets('plug-b', [
					{ id: 'each', language: 'svelte', trigger: 'each', body: 'other', description: 'Other' }
				]);
			}
		});
		await host.activate('plug-a');
		const before = shape(host);

		// The failing plugin's transform is removed on the rollback path, so
		// the surviving pack is the one that was there before it ran.
		const failure = await host.activate('plug-b').then(() => null, (e: unknown) => e);
		expect(failure).toBeInstanceOf(PluginActivationError);
		expect((failure as { cause?: unknown }).cause).toBeInstanceOf(DuplicateSnippetIdError);
		expect(host.getPluginState('plug-b')).toBe('error');
		expect(shape(host)).toEqual(before);

		let message = '';
		try {
			host.registerSnippets('plug-c', [{ id: 'each', language: 'svelte', trigger: 'c', body: 'c', description: 'c' }]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('plug-a');
		expect(message).toContain('plug-c');
		expect(message).toContain('Action:');
		await host.deactivate('plug-a');
	});
});

describe('Snippet registry replay', () => {
	it('carries the body through the registry verbatim, expanding nothing', () => {
		// `SnippetRecord.body` is plain text: no placeholders, no snippet
		// variables. Nothing expands it today, and this is the assertion that
		// keeps that true — a `$1` reaching the document would be a placeholder
		// the contract never promised to handle.
		const host = new PluginHost();
		host.registerSnippets('plug-a', tsSnippets());

		const [snippet] = host.getSnippets();
		expect(snippet.body).toBe('console.log(value);');
		expect(snippet.body).not.toContain('$1');
	});

	it('replays from empty: remove-one and refresh match a clean build', async () => {
		const build = async () => {
			const h = new PluginHost();
			h.register(svelteLanguageRegistration);
			h.register({
				manifest: { id: 'toy', name: 'Toy', version: 0 },
				setup: (hh) => {
					hh.registerSnippets('toy', tsSnippets());
				}
			});
			await h.activate(svelteLanguageRegistration.manifest.id);
			await h.activate('toy');
			return h;
		};

		const full = await build();
		const fullShape = shape(full);
		expect(fullShape).toContain('svelte-each|svelte|each');
		expect(fullShape).toContain('log|typescript|log');

		await full.deactivate('toy');
		const droppedShape = shape(full);

		const clean = new PluginHost();
		clean.register(svelteLanguageRegistration);
		await clean.activate(svelteLanguageRegistration.manifest.id);
		expect(shape(clean)).toEqual(droppedShape);

		// Refresh mid-session loses nothing and duplicates nothing.
		full.refreshSnippets();
		full.rebuildSnippets();
		expect(shape(full)).toEqual(droppedShape);
		expect(new Set(shape(full)).size).toBe(droppedShape.length);

		await full.deactivate(svelteLanguageRegistration.manifest.id);
		expect(shape(full)).toEqual([]);
		await clean.deactivate(svelteLanguageRegistration.manifest.id);
	});

	it('deactivate/reactivate returns the pre-activation registry exactly', async () => {
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		await host.activate(svelteLanguageRegistration.manifest.id);
		const before = shape(host);

		await host.deactivate(svelteLanguageRegistration.manifest.id);
		expect(shape(host)).toEqual([]);

		await host.activate(svelteLanguageRegistration.manifest.id);
		expect(shape(host)).toEqual(before);
		await host.deactivate(svelteLanguageRegistration.manifest.id);
	});

	it('drops a plugin pack on unregister with no remnant', async () => {
		const host = new PluginHost();
		host.register({
			manifest: { id: 'plug-a', name: 'A', version: 0 },
			setup: (h) => {
				h.registerSnippets('plug-a', svelteSnippets());
			}
		});
		await host.activate('plug-a');
		expect(shape(host)).toHaveLength(1);

		await host.unregister('plug-a');
		expect(shape(host)).toEqual([]);
	});

	it('releases an id for the next owner once the previous plugin is disabled', async () => {
		const host = new PluginHost();
		host.register({
			manifest: { id: 'plug-a', name: 'A', version: 0 },
			setup: (h) => {
				h.registerSnippets('plug-a', svelteSnippets());
			}
		});
		await host.activate('plug-a');
		expect(shape(host)).toEqual(['each|svelte|each']);

		// The id is released by the disablement, so the next owner may claim
		// it instead of colliding with a plugin that is no longer active.
		await host.deactivate('plug-a');
		host.registerSnippets('plug-b', [
			{ id: 'each', language: 'svelte', trigger: 'each', body: 'b', description: 'B' }
		]);

		expect(shape(host)).toEqual(['each|svelte|each']);
		expect(host.getSnippets()[0].owner).toBe('plug-b');
		expect(host.getSnippets()[0].body).toBe('b');
	});
});
