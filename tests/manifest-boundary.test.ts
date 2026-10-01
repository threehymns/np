import { describe, it, expect } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkManifestFile, checkManifestSource, assertManifestBoundary } from '../packages/core/src/plugins/boundary-check';

describe('Repo-wide Manifest Import Boundary Invariants', () => {
	function findManifestFiles(dir: string, out: string[] = []): string[] {
		const skipDirs = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build', 'coverage']);
		for (const entry of readdirSync(dir)) {
			if (skipDirs.has(entry)) continue;
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				findManifestFiles(full, out);
			} else if (entry === 'manifest.ts' || entry.endsWith('.manifest.ts')) {
				out.push(full);
			}
		}
		return out;
	}

	it('confirms every manifest.ts in packages/ is completely import-clean and dependency-free', () => {
		const packagesDir = join(import.meta.dir, '..', 'packages');
		const manifestFiles = findManifestFiles(packagesDir);

		expect(manifestFiles.length).toBeGreaterThanOrEqual(1);

		for (const file of manifestFiles) {
			const result = checkManifestFile(file);
			expect(result.valid).toBe(true);
			expect(result.violations).toHaveLength(0);
		}
	});

	it('fails the boundary check when a manifest module imports heavy dependencies', () => {
		const heavyExamples = [
			{
				name: 'CodeMirror import',
				code: `
					import type { PluginManifest } from '@np/core';
					import { EditorView } from '@codemirror/view';
					export const manifest: PluginManifest = { id: 'bad', name: 'Bad', version: 0 };
				`,
				expectedModule: '@codemirror/view'
			},
			{
				name: 'Svelte runtime import',
				code: `
					import type { PluginManifest } from '@np/core';
					import { mount } from 'svelte';
					export const manifest: PluginManifest = { id: 'bad', name: 'Bad', version: 0 };
				`,
				expectedModule: 'svelte'
			},
			{
				name: 'Isomorphic-git import',
				code: `
					import type { PluginManifest } from '@np/core';
					import git from 'isomorphic-git';
					export const manifest: PluginManifest = { id: 'bad', name: 'Bad', version: 0 };
				`,
				expectedModule: 'isomorphic-git'
			},
			{
				name: 'UI component import',
				code: `
					import type { PluginManifest } from '@np/core';
					import { Button } from '@np/ui';
					export const manifest: PluginManifest = { id: 'bad', name: 'Bad', version: 0 };
				`,
				expectedModule: '@np/ui'
			},
			{
				name: 'Plugin implementation import',
				code: `
					import type { PluginManifest } from '@np/core';
					import { setup } from './index';
					export const manifest: PluginManifest = { id: 'bad', name: 'Bad', version: 0 };
				`,
				expectedModule: './index'
			}
		];

		for (const example of heavyExamples) {
			const result = checkManifestSource(example.code, 'fixture/manifest.ts');
			expect(result.valid).toBe(false);
			expect(result.violations.some((v) => v.moduleSpecifier === example.expectedModule)).toBe(true);
			expect(() => assertManifestBoundary(example.code, false)).toThrow(/Manifest module boundary violation/);
		}
	});
});
