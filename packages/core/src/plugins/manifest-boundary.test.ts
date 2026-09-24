import { describe, it, expect } from 'bun:test';
import { checkManifestSource, assertManifestBoundary } from './boundary-check';

describe('Manifest Import Boundary Checker', () => {
	it('accepts clean manifest modules that only use type imports', () => {
		const source = `
			import type { PluginManifest } from '../types';

			export const manifest: PluginManifest = {
				id: 'clean-plugin',
				name: 'Clean Plugin',
				version: 0,
				description: 'Pure dependency-free manifest',
				platforms: ['web', 'desktop']
			};
		`;

		const result = checkManifestSource(source, 'clean/manifest.ts');
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it('fails when a manifest module imports heavy libraries like CodeMirror or Svelte', () => {
		const source = `
			import type { PluginManifest } from '../types';
			import { EditorView } from '@codemirror/view';
			import { mount } from 'svelte';

			export const manifest: PluginManifest = {
				id: 'heavy-plugin',
				name: 'Heavy Plugin',
				version: 0
			};
		`;

		const result = checkManifestSource(source, 'heavy/manifest.ts');
		expect(result.valid).toBe(false);
		expect(result.violations.length).toBeGreaterThanOrEqual(2);
		expect(result.violations.some((v) => v.moduleSpecifier === '@codemirror/view')).toBe(true);
		expect(result.violations.some((v) => v.moduleSpecifier === 'svelte')).toBe(true);
	});

	it('fails when a manifest module imports local implementation code', () => {
		const source = `
			import type { PluginManifest } from '../types';
			import { setup } from './index';

			export const manifest: PluginManifest = {
				id: 'imp-plugin',
				name: 'Imp Plugin',
				version: 0
			};
		`;

		const result = checkManifestSource(source, 'imp/manifest.ts');
		expect(result.valid).toBe(false);
		expect(result.violations.some((v) => v.moduleSpecifier === './index')).toBe(true);
	});

	it('fails when a manifest module has side-effect imports', () => {
		const source = `
			import './side-effect';
			export const manifest = { id: 'test', name: 'Test', version: 0 };
		`;

		const result = checkManifestSource(source, 'test/manifest.ts');
		expect(result.valid).toBe(false);
		expect(result.violations.some((v) => v.moduleSpecifier === './side-effect')).toBe(true);
	});

	it('fails when a manifest module uses dynamic import', () => {
		const source = `
			const heavy = import('isomorphic-git');
			export const manifest = { id: 'test', name: 'Test', version: 0 };
		`;

		const result = checkManifestSource(source, 'test/manifest.ts');
		expect(result.valid).toBe(false);
		expect(result.violations.some((v) => v.moduleSpecifier === 'isomorphic-git')).toBe(true);
	});

	it('assertManifestBoundary throws an actionable error on violation', () => {
		const source = `
			import { EditorView } from '@codemirror/view';
			export const manifest = { id: 'test', name: 'Test', version: 0 };
		`;

		expect(() => assertManifestBoundary(source, false)).toThrow(/Manifest module boundary violation/);
	});
});
