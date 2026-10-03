import '../../../../../tests/contract/rune-setup';
import { describe, expect, it } from 'bun:test';
import { PluginHost } from '../host.svelte';
import { lspRegistration } from './registration';
import { LSP_DESCRIPTORS } from './descriptors';
import { getLspDescriptorsForLanguage } from '../lsp-descriptors';

/**
 * The bundled TypeScript descriptor (spec #263, #265).
 *
 * The claim under test is that TypeScript and TSX are served by *one* descriptor
 * declared by the bundled plugin, with nothing installed on the machine: the
 * executable is a name the desktop app resolves against its own dependency
 * first, and the marker list is the TypeScript server's own configuration files.
 * Two descriptors would mean two processes indexing the same file, which ADR
 * 0019 reports as a conflict rather than resolves.
 */
describe('the bundled TypeScript descriptor', () => {
	it('declares one entry naming a command, not a path', () => {
		expect(LSP_DESCRIPTORS).toHaveLength(1);

		const [descriptor] = LSP_DESCRIPTORS;
		expect(descriptor.id).toBe('typescript');
		// The registry's names, because that is the identity descriptors join on.
		// The protocol's own ids are a different vocabulary and are derived where
		// the document is synced; see `LspRuntime.languageIdFor`.
		expect(descriptor.languages).toContain('TypeScript');
		expect(descriptor.languages).toContain('TSX');

		// A bare command name, not a path: the host downloads and manages nothing,
		// so the desktop app resolves it against its own dependency first and a
		// developer who installed vtsls themselves resolves it on PATH.
		expect(descriptor.command).toBe('vtsls');
		expect(descriptor.args).toEqual(['--stdio']);
		expect(descriptor.rootMarkers).toEqual([
			'tsconfig.json',
			'jsconfig.json',
			'package.json'
		]);
	});

	it('reaches TypeScript and TSX through the registry as one claim', async () => {
		const host = new PluginHost({ platform: 'desktop' });
		host.register(lspRegistration);
		await host.activate(lspRegistration.manifest.id);

		const descriptors = host.getLspDescriptors();
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0].owner).toBe(lspRegistration.manifest.id);

		// The join is case-insensitive, like every other language join in the host.
		for (const language of ['TypeScript', 'typescript', 'TSX', 'TSX']) {
			expect(getLspDescriptorsForLanguage(descriptors, language).map((d) => d.id)).toEqual([
				'typescript'
			]);
			expect(host.getLspDescriptorsForLanguage(language)).toHaveLength(1);
		}
		// And the way it actually arrives: a filename. One descriptor for the two
		// extensions, which is the acceptance criterion in one assertion.
		for (const file of ['a.ts', 'a.tsx']) {
			const language = host.getLanguageForFile(file);
			expect(language).not.toBeNull();
			expect(host.getLspDescriptorsForLanguage(language!.name).map((d) => d.id)).toEqual([
				'typescript'
			]);
		}

		await host.deactivate(lspRegistration.manifest.id);
	});
});