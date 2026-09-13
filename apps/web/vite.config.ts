import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';

function phosphorOptimizePlugin(): Plugin {
	return {
		name: 'np-phosphor-optimize',
		enforce: 'pre',
		transform(code, id) {
			if (!code.includes('phosphor-svelte') || id.includes('node_modules/phosphor-svelte')) return;
			const updated = code.replace(
				/import\s*\{([^}]+)\}\s*from\s*['"]phosphor-svelte['"];?/g,
				(_, imports) => {
					return imports
						.split(',')
						.map((s: string) => s.trim())
						.filter(Boolean)
						.map((s: string) => {
							const parts = s.split(/\s+as\s+/);
							const imported = parts[0].trim();
							const local = parts[1] ? parts[1].trim() : imported;
							return `import ${local} from "phosphor-svelte/lib/${imported}";`;
						})
						.join('\n');
				}
			);
			if (updated !== code) {
				return { code: updated, map: null };
			}
		}
	};
}

export default defineConfig({ 
	plugins: [
		phosphorOptimizePlugin(),
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
	resolve: {
		dedupe: [
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/language',
			'@codemirror/commands',
			'@codemirror/autocomplete',
			'@codemirror/search',
			'@codemirror/merge',
			'@codemirror/lang-markdown',
			'@codemirror/language-data',
			'@lezer/common',
			'@lezer/highlight',
			'@lezer/lr',
			'@lezer/markdown',
			'svelte'
		]
	},
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
	},
	optimizeDeps: {
		exclude: ['phosphor-svelte']
	}
});
