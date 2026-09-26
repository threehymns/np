import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkManifestFile, platformImportViolations } from './boundary-check';

/**
 * Platform separation static boundary (spec companion to the manifest
 * cleanliness check).
 *
 * Platform differences belong behind the manifest `platforms` field
 * (static) plus `UnsupportedPlatformError` (runtime activation gate),
 * never behind an import. Manifests and the platform-neutral generic host
 * path must therefore stay free of platform-only runtime imports
 * (`electron`, `node:*`, bare Node builtins); the only sanctioned
 * platform probe is the guarded `(window as any).electronAPI` property
 * read in `host.svelte.ts`, which is not a module import.
 *
 * The rule itself lives in `boundary-check` alongside the manifest import
 * boundary, so every boundary check reads from one place.
 */

describe('Platform separation static boundary', () => {
	it('accepts a universal manifest declaring platforms for web and desktop', () => {
		const source = `
			import type { PluginManifest } from '../types';

			export const manifest: PluginManifest = {
				id: 'universal-plugin',
				name: 'Universal Plugin',
				version: 0,
				platforms: ['web', 'desktop']
			};
		`;
		expect(platformImportViolations(source)).toEqual([]);
	});

	it('rejects an electron runtime import in a manifest', () => {
		const source = `
			import type { PluginManifest } from '../types';
			import { app } from 'electron';

			export const manifest: PluginManifest = { id: 'native', name: 'Native', version: 0 };
		`;
		expect(platformImportViolations(source)).toEqual(['electron']);
	});

	it('rejects a node: runtime import in platform-neutral code', () => {
		const source = `
			import fs from 'node:fs';
			export function setup() {}
		`;
		expect(platformImportViolations(source)).toEqual(['node:fs']);
	});

	it('rejects dynamic platform imports', () => {
		const source = `
			const electron = import('electron');
			export const manifest = { id: 'lazy', name: 'Lazy', version: 0 };
		`;
		expect(platformImportViolations(source)).toEqual(['electron']);
	});

	it('keeps the bundled manifests platform-neutral on disk', () => {
		for (const file of ['git/manifest.ts']) {
			const filePath = join(import.meta.dir, file);
			const result = checkManifestFile(filePath);
			expect(result.valid).toBe(true);
			const source = readFileSync(filePath, 'utf-8');
			expect(platformImportViolations(source)).toEqual([]);
		}
	});

	it('keeps bundled implementations behind dynamic imports', () => {
		const coreEntry = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8');
		const uiBridge = readFileSync(
			join(import.meta.dir, '../../../../packages/ui/src/plugins/index.ts'),
			'utf-8'
		);

		expect(coreEntry).not.toMatch(/from ['"]\.\/git\/(?:index|gutter|ui)['"]/);
		expect(uiBridge).not.toMatch(/from ['"]\.\/git(?:\/index)?['"]/);
		expect(uiBridge).toMatch(/import\(['"]\.\/git['"]\)/);
	});

	it('keeps async context detection platform-neutral in the host', () => {
		const source = readFileSync(join(import.meta.dir, 'host.svelte.ts'), 'utf-8');
		expect(source).not.toMatch(/getBuiltinModule|node:async_hooks|process/);
	});

	it('keeps public UI contribution contracts free of any types', () => {
		const coreSource = readFileSync(join(import.meta.dir, 'ui-contributions.ts'), 'utf-8');
		const publicTypes = coreSource
			.slice(0, coreSource.indexOf('export interface MountedContribution'))
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|\s)\/\/.*$/gm, '$1');
		const gitSource = readFileSync(join(import.meta.dir, 'git', 'ui.ts'), 'utf-8');
		const editorSource = readFileSync(join(import.meta.dir, '../../../../packages/ui/src/editor/index.ts'), 'utf-8');

		expect(publicTypes).not.toMatch(/\bany\b/);
		expect(gitSource).not.toMatch(/\bany\b/);
		expect(editorSource).not.toMatch(/pluginExtensions\?: any\[\]|initialLanguageExtensions: any\[\]/);
	});

	it('keeps the generic host path free of platform-only runtime imports', () => {
		const neutralModules = [
			'host.svelte.ts',
			'services.ts',
			'types.ts',
			'hooks.ts',
			'commands.ts',
			'settings.ts',
			'ui-contributions.ts',
			'editor.ts',
			'events.ts',
			'errors.ts',
			'git/index.ts',
			'git/commands.ts',
			'git/lifecycle.ts',
			'git/gutter.ts',
			'git/ui.ts',
			'git/registration.ts',
			'git/manifest.ts'
		];
		const offenders: string[] = [];
		for (const file of neutralModules) {
			const source = readFileSync(join(import.meta.dir, file), 'utf-8');
			for (const spec of platformImportViolations(source)) {
				offenders.push(`${file}: ${spec}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
