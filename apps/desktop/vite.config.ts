import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

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

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
	root: __dirname,
	plugins: [phosphorOptimizePlugin(), tailwindcss(), svelte()],
	base: './',
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
	build: {
		outDir: 'dist',
		emptyOutDir: true
	},
	server: {
		watch: {
			ignored: [
				'**/node_modules/**',
				'**/.git/**',
				'**/dist/**',
				'**/dist-main/**',
				'**/.svelte-kit/**',
				'!**/packages/ui/src/**',
				'!**/node_modules/@np/ui/**'
			]
		}
	},
	optimizeDeps: {
		exclude: ['phosphor-svelte']
	}
});
