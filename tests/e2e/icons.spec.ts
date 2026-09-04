import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

test.describe('Icon Registry and Manifest Provider', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
	});

	test('should resolve file icon using ManifestIconProvider', async ({ page }) => {
		const result = await page.evaluate(() => {
			const theme = {
				name: 'Mock Theme',
				themes: [{
					name: 'Mock Theme',
					appearance: 'dark' as const,
					file_stems: {
						'package.json': 'npm'
					},
					file_suffixes: {
						'ts': 'typescript',
						'svelte': 'svelte'
					},
					file_icons: {
						npm: { path: 'npm.svg' },
						typescript: { path: 'typescript.svg' },
						svelte: { path: 'svelte.svg' },
						file: { path: 'file.svg' }
					}
				}]
			};
			
			if (typeof (window as any).ManifestIconProvider === 'undefined') {
				throw new Error('ManifestIconProvider is not defined.');
			}
			
			const provider = new (window as any).ManifestIconProvider('mock-theme', 'Mock Theme', theme, 'https://cdn.example.com/icons/');
			return {
				packageJson: provider.getFileIcon('package.json'),
				typescriptTs: provider.getFileIcon('test.ts'),
				svelteFile: provider.getFileIcon('App.svelte'),
				defaultFile: provider.getFileIcon('unknown.xyz')
			};
		});
		
		expect(result.packageJson).toBe('https://cdn.example.com/icons/npm.svg');
		expect(result.typescriptTs).toBe('https://cdn.example.com/icons/typescript.svg');
		expect(result.svelteFile).toBe('https://cdn.example.com/icons/svelte.svg');
		expect(result.defaultFile).toBe('https://cdn.example.com/icons/file.svg');
	});

	test('should resolve file icons with priorities', async ({ page }) => {
		const result = await page.evaluate(() => {
			const theme = {
				name: 'Priority Theme',
				themes: [{
					name: 'Priority Theme',
					appearance: 'dark' as const,
					file_stems: {
						'package.json': 'npm-exact',
						'svelte.config.js': 'svelte-config'
					},
					file_suffixes: {
						'json': 'json-ext',
						'js': 'js-ext'
					},
					file_icons: {
						'npm-exact': { path: 'npm-exact.svg' },
						'svelte-config': { path: 'svelte-config.svg' },
						'json-ext': { path: 'json-ext.svg' },
						'js-ext': { path: 'js-ext.svg' },
						'js-lang': { path: 'js-lang.svg' },
						'fallback': { path: 'fallback.svg' }
					}
				}]
			};
			
			const registry = (window as any).appState.icons;
			const provider = new (window as any).ManifestIconProvider('priority-theme', 'Priority Theme', theme, 'https://cdn.example.com/icons/');
			
			if (typeof registry.registerFileTheme === 'undefined') {
				throw new Error('registerFileTheme is not defined.');
			}
			
			registry.registerFileTheme('priority-theme', provider);
			registry.activeFileThemeId = 'priority-theme';
			
			return {
				exactMatch: registry.resolveFileIcon('package.json', 'JSON'),
				extensionMatch: registry.resolveFileIcon('tsconfig.json', 'JSON'),
				defaultMatch: registry.resolveFileIcon('README', 'Markdown')
			};
		});
		
		expect(result.exactMatch).toBe('https://cdn.example.com/icons/npm-exact.svg');
		expect(result.extensionMatch).toBe('https://cdn.example.com/icons/json-ext.svg');
		expect(result.defaultMatch).toBe('https://cdn.example.com/icons/fallback.svg');
	});
});
