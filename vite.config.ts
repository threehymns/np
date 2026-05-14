import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

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
	ssr: {
		noExternal: ['@mobily/ts-belt', 'codemirror-markdown-tables']
	}
});
