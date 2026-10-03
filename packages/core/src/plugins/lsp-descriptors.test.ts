import '../../../../tests/contract/rune-setup';
import { describe, it, expect } from 'bun:test';
import { PluginHost } from './host.svelte';
import { svelteLanguageRegistration } from './svelte-language/registration';
import { lspRegistration } from './lsp/registration';
import { LSP_DESCRIPTORS } from './lsp/descriptors';
import { DuplicateLspDescriptorIdError, PluginActivationError } from './errors';
import type { PluginHostInterface } from './types';
import type { LspDescriptorContribution } from './lsp-descriptors';

function typescriptDescriptor(): LspDescriptorContribution {
	return {
		id: 'ts',
		command: 'vtsls',
		args: ['--stdio'],
		rootMarkers: ['tsconfig.json', 'package.json'],
		languages: ['typescript', 'tsx']
	};
}

function rubyDescriptor(): LspDescriptorContribution {
	return {
		id: 'ruby',
		command: 'solargraph',
		args: ['stdio'],
		rootMarkers: ['Gemfile'],
		languages: ['ruby']
	};
}

/**
 * The LSP manifest limits itself to desktop, and a headless test host has no
 * Electron bridge, so the default host here resolves to `web`. Asking for the
 * platform explicitly is the same thing the desktop app does.
 */
function desktopHost(): PluginHost {
	return new PluginHost({ platform: 'desktop' });
}

/** Every field a descriptor carries, in registry order. */
function shape(host: PluginHost): string[] {
	return host
		.getLspDescriptors()
		.map((d) => `${d.id}|${d.command}|${d.args.join(' ')}|${d.rootMarkers.join(',')}|${d.languages.join(',')}`);
}

describe('Server descriptor interface (#264)', () => {
	it('ships no descriptors until a plugin registers one', () => {
		const host = new PluginHost();
		expect(host.getLspDescriptors()).toEqual([]);
	});

	it('carries command, arguments, ordered root markers and served languages through registration', async () => {
		const host = desktopHost();
		host.register(svelteLanguageRegistration);
		host.register(lspRegistration);
		await host.activate(svelteLanguageRegistration.manifest.id);
		expect(host.getLspDescriptors()).toEqual([]);

		await host.activate(lspRegistration.manifest.id);

		const [descriptor] = host.getLspDescriptors();
		expect(descriptor.id).toBe('typescript');
		expect(descriptor.owner).toBe(lspRegistration.manifest.id);
		expect(descriptor.command).toBe('vtsls');
		expect(descriptor.args).toEqual(['--stdio']);
		// Order is data, not a set: the first declared marker outranks the rest.
		expect(descriptor.rootMarkers).toEqual(LSP_DESCRIPTORS[0].rootMarkers);
		expect(descriptor.languages).toEqual(LSP_DESCRIPTORS[0].languages);

		await host.deactivate(lspRegistration.manifest.id);
		await host.deactivate(svelteLanguageRegistration.manifest.id);
	});

	it('rebuilds through the standard transform replay', () => {
		// A descriptor is not stored where it was registered: it is materialized
		// by replaying transforms from empty, which is what makes a refresh and a
		// disable lossless (ADR 0012).
		const host = desktopHost();
		host.registerLspDescriptors('plug-a', [typescriptDescriptor()]);
		const before = shape(host);
		host.rebuildLspDescriptors();
		expect(shape(host)).toEqual(before);
		host.refreshLspDescriptors();
		expect(shape(host)).toEqual(before);
		expect(host.lspRevision).toBeGreaterThan(0);
	});

	it('joins on language identity case-insensitively, like snippets and editor contributions', () => {
		const host = desktopHost();
		host.registerLspDescriptors('plug-a', [typescriptDescriptor(), rubyDescriptor()]);

		expect(host.getLspDescriptorsForLanguage('TypeScript').map((d) => d.id)).toEqual(['ts']);
		expect(host.getLspDescriptorsForLanguage('TSX').map((d) => d.id)).toEqual(['ts']);
		// Two descriptors matching is a conflict for the caller to report, never a
		// silent preference; the registry hands back both, in registration order.
		host.registerLspDescriptors('plug-b', [
			{ ...rubyDescriptor(), id: 'ruby-alt', languages: ['RUBY'] }
		]);
		expect(host.getLspDescriptorsForLanguage('ruby').map((d) => d.id)).toEqual(['ruby', 'ruby-alt']);
		// A language no descriptor serves resolves to nothing at all.
		expect(host.getLspDescriptorsForLanguage('markdown')).toEqual([]);
	});

	it('reaches plugin code through the host proxy, not just through the host', async () => {
		// The proxy allow-list is hand-written: a member missing from it makes
		// plugin code throw UnknownPluginHostMethodError at activation.
		const host = desktopHost();
		let viaProxy: PluginHostInterface | null = null;
		host.register({
			manifest: { id: 'probe', name: 'Probe', version: 0 },
			setup: (received) => {
				viaProxy = received;
				received.registerLspDescriptor('probe', typescriptDescriptor());
			}
		});
		await host.activate('probe');

		const pluginHost = viaProxy!;
		expect(pluginHost.getLspDescriptors()).toHaveLength(1);
		expect(pluginHost.getLspDescriptorsForLanguage('TypeScript')).toHaveLength(1);
		expect(pluginHost.lspRevision).toBeGreaterThan(0);
		pluginHost.removePluginLspDescriptors('probe');
		expect(pluginHost.getLspDescriptors()).toEqual([]);
		await host.deactivate('probe');
	});

	it('reloads the same records without duplicate errors, even when a refresh transform re-emits them', () => {
		// The failure mode this guards: a refresh transform that rebuilds every
		// record with a fresh object identity looks like a fresh claim. Ownership
		// must follow the record, not the transform that ran last — otherwise a
		// reload either mis-attributes the record or raises a duplicate error
		// against the plugin that actually wrote it.
		const host = desktopHost();
		host.registerLspDescriptors('plug-a', [typescriptDescriptor()]);
		const before = host.getLspDescriptors();

		host.registerLspDescriptorTransform('refresh', (previous) =>
			new Map([...previous].map(([id, descriptor]) => [id, { ...descriptor }]))
		);
		expect(() => host.refreshLspDescriptors()).not.toThrow();

		const after = host.getLspDescriptors();
		expect(after).toEqual(before);
		expect(after.map((d) => d.owner)).toEqual(['plug-a']);

		// And it stays stable across repeated refreshes.
		host.rebuildLspDescriptors();
		expect(host.getLspDescriptors()).toEqual(before);
		expect(() => host.refreshLspDescriptors()).not.toThrow();
		expect(host.getLspDescriptors().map((d) => d.owner)).toEqual(['plug-a']);
	});

	it('refuses to activate on a platform the manifest does not claim', async () => {
		// ADR 0006 allows an explicit platform limit and requires it to be stated;
		// the manifest states it, and the runtime gate is what enforces it. Web has
		// no transport story (spec #263), so activating there is refused rather than
		// half-working.
		expect(lspRegistration.manifest.platforms).toEqual(['desktop']);
		const host = new PluginHost({ platform: 'web' });
		host.register(lspRegistration);

		await expect(host.activate(lspRegistration.manifest.id)).rejects.toThrow(
			/cannot run on platform "web"/
		);
		expect(host.getLspDescriptors()).toEqual([]);
	});

	it('binds the owner to the registering plugin, not to the contribution', () => {
		const host = desktopHost();
		host.registerLspDescriptors('plug-a', [typescriptDescriptor()]);

		expect(host.getLspDescriptors().map((d) => d.owner)).toEqual(['plug-a']);
	});

	it('bumps a revision counter on every rebuild', async () => {
		const host = desktopHost();
		const base = host.lspRevision;
		host.registerLspDescriptorTransform('core.descriptors', (prev) => new Map(prev));
		expect(host.lspRevision).toBeGreaterThan(base);
		const afterTransform = host.lspRevision;

		host.register(lspRegistration);
		await host.activate(lspRegistration.manifest.id);
		expect(host.lspRevision).toBeGreaterThan(afterTransform);
		const afterActivate = host.lspRevision;

		await host.deactivate(lspRegistration.manifest.id);
		expect(host.lspRevision).toBeGreaterThan(afterActivate);
	});

	it('rejects one descriptor id claimed by two owners and rolls the plugin back', async () => {
		const host = desktopHost();
		host.register({
			manifest: { id: 'plug-a', name: 'A', version: 0 },
			setup: (h) => {
				h.registerLspDescriptor('plug-a', typescriptDescriptor());
			}
		});
		host.register({
			manifest: { id: 'plug-b', name: 'B', version: 0 },
			setup: (h) => {
				h.registerLspDescriptor('plug-b', { ...typescriptDescriptor(), command: 'other' });
			}
		});
		await host.activate('plug-a');
		const before = shape(host);

		// The failing plugin's transform is removed on the rollback path, so the
		// surviving descriptor is the one that was there before it ran.
		const failure = await host.activate('plug-b').then(() => null, (e: unknown) => e);
		expect(failure).toBeInstanceOf(PluginActivationError);
		expect((failure as { cause?: unknown }).cause).toBeInstanceOf(DuplicateLspDescriptorIdError);
		expect(host.getPluginState('plug-b')).toBe('error');
		expect(shape(host)).toEqual(before);

		let message = '';
		try {
			host.registerLspDescriptor('plug-c', typescriptDescriptor());
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('plug-a');
		expect(message).toContain('plug-c');
		expect(message).toContain('Action:');
		await host.deactivate('plug-a');
	});
});

describe('Server descriptor registry replay', () => {
	it('registers the bundled TypeScript descriptor through the plugin, not the host', async () => {
		// The descriptor is configuration: the plugin declares it and the host
		// materializes it like any other contribution, which is what makes a
		// second server configuration rather than new architecture (#263).
		const host = desktopHost();
		host.register(lspRegistration);
		await host.activate(lspRegistration.manifest.id);

		expect(shape(host)).toEqual([
			`${LSP_DESCRIPTORS[0].id}|vtsls|--stdio|${LSP_DESCRIPTORS[0].rootMarkers.join(',')}|${LSP_DESCRIPTORS[0].languages.join(',')}`
		]);
		await host.deactivate(lspRegistration.manifest.id);
	});

	it('replays from empty: remove-one and refresh match a clean build', async () => {
		const build = async () => {
			const h = desktopHost();
			h.register(svelteLanguageRegistration);
			h.register(lspRegistration);
			h.register({
				manifest: { id: 'toy', name: 'Toy', version: 0 },
				setup: (hh) => {
					hh.registerLspDescriptor('toy', rubyDescriptor());
				}
			});
			await h.activate(svelteLanguageRegistration.manifest.id);
			await h.activate(lspRegistration.manifest.id);
			await h.activate('toy');
			return h;
		};

		const full = await build();
		const fullShape = shape(full);
		expect(fullShape).toHaveLength(2);

		await full.deactivate('toy');
		const droppedShape = shape(full);

		const clean = desktopHost();
		clean.register(svelteLanguageRegistration);
		clean.register(lspRegistration);
		await clean.activate(svelteLanguageRegistration.manifest.id);
		await clean.activate(lspRegistration.manifest.id);
		expect(shape(clean)).toEqual(droppedShape);

		// Refresh mid-session loses nothing and duplicates nothing.
		full.refreshLspDescriptors();
		full.rebuildLspDescriptors();
		expect(shape(full)).toEqual(droppedShape);
		expect(new Set(shape(full)).size).toBe(droppedShape.length);

		await full.deactivate(lspRegistration.manifest.id);
		expect(shape(full)).toEqual([]);
		await full.deactivate(svelteLanguageRegistration.manifest.id);
		await clean.deactivate(lspRegistration.manifest.id);
		await clean.deactivate(svelteLanguageRegistration.manifest.id);
	});

	it('deactivate/reactivate returns the pre-activation registry exactly', async () => {
		const host = desktopHost();
		host.register(lspRegistration);
		await host.activate(lspRegistration.manifest.id);
		const before = shape(host);

		await host.deactivate(lspRegistration.manifest.id);
		expect(shape(host)).toEqual([]);

		await host.activate(lspRegistration.manifest.id);
		expect(shape(host)).toEqual(before);
		await host.deactivate(lspRegistration.manifest.id);
	});

	it('drops a plugin descriptor on unregister with no remnant', async () => {
		const host = desktopHost();
		host.register({
			manifest: { id: 'plug-a', name: 'A', version: 0 },
			setup: (h) => {
				h.registerLspDescriptor('plug-a', typescriptDescriptor());
			}
		});
		await host.activate('plug-a');
		expect(shape(host)).toHaveLength(1);

		await host.unregister('plug-a');
		expect(shape(host)).toEqual([]);
	});

	it('releases an id for the next owner once the previous plugin is disabled', async () => {
		const host = desktopHost();
		host.register({
			manifest: { id: 'plug-a', name: 'A', version: 0 },
			setup: (h) => {
				h.registerLspDescriptor('plug-a', typescriptDescriptor());
			}
		});
		await host.activate('plug-a');
		expect(shape(host)).toEqual([
			'ts|vtsls|--stdio|tsconfig.json,package.json|typescript,tsx'
		]);

		// The id is released by the disablement, so the next owner may claim it
		// instead of colliding with a plugin that is no longer active.
		await host.deactivate('plug-a');
		host.registerLspDescriptor('plug-b', {
			...typescriptDescriptor(),
			command: 'other-server'
		});

		expect(host.getLspDescriptors()[0].owner).toBe('plug-b');
		expect(host.getLspDescriptors()[0].command).toBe('other-server');
	});
});
