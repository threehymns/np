import { test, expect } from '@playwright/test';

test.describe('Icon Registry and Manifest Provider', () => {
	test.beforeEach(async ({ page }) => {
		page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
		await page.goto('/');
		// Wait for app to mount
		await expect(page.locator('.cm-content')).toBeVisible();
	});

	test('should resolve file icon using ManifestIconProvider', async ({ page }) => {
		const result = await page.evaluate(() => {
			const manifest = {
				id: 'mock-theme',
				name: 'Mock Theme',
				type: 'file' as const,
				baseUrl: 'https://cdn.example.com/icons/',
				fileNames: {
					'package.json': 'npm.svg'
				},
				fileExtensions: {
					'ts': 'typescript.svg',
					'svelte': 'svelte.svg'
				},
				languageIds: {
					'svelte': 'svelte.svg'
				},
				defaultIcon: 'file.svg'
			};
			
			if (typeof (window as any).ManifestIconProvider === 'undefined') {
				throw new Error('ManifestIconProvider is not defined.');
			}
			
			const provider = new (window as any).ManifestIconProvider(manifest);
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
			const manifest = {
				id: 'priority-theme',
				name: 'Priority Theme',
				type: 'file' as const,
				baseUrl: 'https://cdn.example.com/icons/',
				fileNames: {
					'package.json': 'npm-exact.svg',
					'svelte.config.js': 'svelte-config.svg'
				},
				fileExtensions: {
					'json': 'json-ext.svg',
					'js': 'js-ext.svg'
				},
				languageIds: {
					'javascript': 'js-lang.svg'
				},
				defaultIcon: 'fallback.svg'
			};
			
			const registry = (window as any).appState.icons;
			const provider = new (window as any).ManifestIconProvider(manifest);
			
			if (typeof registry.registerFileTheme === 'undefined') {
				throw new Error('registerFileTheme is not defined.');
			}
			
			// Register our provider as active
			registry.registerFileTheme(manifest.id, provider);
			registry.activeFileThemeId = manifest.id;
			
			return {
				exactMatch: registry.resolveFileIcon('package.json', 'JSON'),
				extensionMatch: registry.resolveFileIcon('tsconfig.json', 'JSON'),
				languageMatch: registry.resolveFileIcon('main', 'JavaScript'),
				defaultMatch: registry.resolveFileIcon('README', 'Markdown')
			};
		});
		
		expect(result.exactMatch).toBe('https://cdn.example.com/icons/npm-exact.svg');
		expect(result.extensionMatch).toBe('https://cdn.example.com/icons/json-ext.svg');
		expect(result.languageMatch).toBe('https://cdn.example.com/icons/js-lang.svg');
		expect(result.defaultMatch).toBe('https://cdn.example.com/icons/fallback.svg');
	});
});
