import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [tailwindcss(), svelte()],
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
	}
});
