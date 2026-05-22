import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

export default defineConfig({ 
	plugins: [
		tailwindcss(), 
		sveltekit(),
		{
			name: 'fix-ts-belt-directory-imports',
			resolveId(source, importer) {
				if (importer?.includes('@mobily/ts-belt') && source.startsWith('./')) {
					const submodules = ['Function', 'Array', 'Result', 'Guards', 'Option', 'String', 'Dict', 'Bool', 'Number'];
					const submodule = submodules.find(s => source === `./${s}`);
					if (submodule) {
						return path.resolve(path.dirname(importer), submodule, 'index.js');
					}
				}
				return null;
			}
		}
	],
	server: {
		fs: {
			allow: [
				searchForWorkspaceRoot(process.cwd())
			]
		},
		watch: {
			ignored: [
				'!**/packages/ui/src/**',
				'!**/node_modules/@np/ui/**'
			]
		}
	},
	ssr: {
		noExternal: ['@mobily/ts-belt', 'codemirror-markdown-tables', '@np/core', '@np/ui']
	}
});
