import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';

test.describe('Icon Resolution for Folders and Files', () => {
	test.beforeEach(async ({ page }) => {
		page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible({ timeout: 30000 });
	});

	const themes = [
		{ id: 'material', prefix: 'folder-', suffix: '.svg' },
		{ id: 'catppuccin', prefix: 'folder_', suffix: '.svg' },
		{ id: 'vscode', prefix: 'folder_type_', suffix: '.svg' }
	];

	for (const theme of themes) {
		test(`should resolve common folders for ${theme.id} theme`, async ({ page }) => {
			const result = await page.evaluate(async ({ themeId }) => {
				const appState = (window as any).appState;
				const icons = appState.icons;
				
				appState.prefs.fileIconThemeId = themeId;
				console.log('Setting fileIconThemeId to:', themeId);
				
				// Wait for the theme to load
				for (let i = 0; i < 50; i++) {
					if (icons.getFileThemes().some((t: any) => t.id === themeId)) {
						break;
					}
					await new Promise(r => setTimeout(r, 50));
				}
				
				console.log('Loaded themes:', icons.getFileThemes().map((t: any) => t.id));
				console.log('Active theme id:', icons.activeFileThemeId);
				
				const provider = icons.fileThemes[themeId];
				console.log('Provider for theme exists:', !!provider);
				if (provider) {
					console.log('Provider resolved structure:', !!provider.resolved);
					if (provider.resolved) {
						console.log('Provider namedDirectories keys count:', Object.keys(provider.resolved.namedDirectories).length);
						console.log('node_modules in namedDirectories:', 'node_modules' in provider.resolved.namedDirectories);
						console.log('node_modules value:', provider.resolved.namedDirectories['node_modules']);
						console.log('resolveFolderIcon node_modules:', provider.resolveFolderIcon('node_modules'));
					}
				}
				
				const getFolderIconVal = (folder: string) => {
					const val = icons.getFolderIcon(folder);
					console.log(`getFolderIcon(${folder}) raw:`, val);
					return typeof val === 'string' ? val : 'component';
				};
				
				return {
					node: getFolderIconVal('node_modules'),
					src: getFolderIconVal('src'),
					dist: getFolderIconVal('dist'),
					git: getFolderIconVal('.git'),
					public: getFolderIconVal('public'),
					lib: getFolderIconVal('lib'),
					static: getFolderIconVal('static')
				};
			}, { themeId: theme.id });
			
			expect(result.node).toContain(`${theme.prefix}node${theme.suffix}`);
			expect(result.src).toContain(`${theme.prefix}src${theme.suffix}`);
			expect(result.dist).toContain(`${theme.prefix}dist${theme.suffix}`);
			expect(result.git).toContain(`${theme.prefix}git${theme.suffix}`);
			expect(result.public).toContain(`${theme.prefix}public${theme.suffix}`);

			if (theme.id === 'material') {
				expect(result.lib).toContain('folder-lib.svg');
				expect(result.static).toContain('folder-resource.svg');
			} else if (theme.id === 'catppuccin') {
				expect(result.lib).toContain('folder_lib.svg');
				expect(result.static).toContain('folder_assets.svg');
			} else if (theme.id === 'vscode') {
				expect(result.lib).toContain('folder_type_library.svg');
				expect(result.static).toContain('folder_type_asset.svg');
			}
		});
	}

	test('should resolve common files across themes', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			appState.prefs.fileIconThemeId = 'material';
			
			// Wait for the theme to load
			for (let i = 0; i < 50; i++) {
				if (icons.getFileThemes().some((t: any) => t.id === 'material')) {
					break;
				}
				await new Promise(r => setTimeout(r, 50));
			}
			
			const val = icons.getFileIcon('README.md');
			const materialReadme = typeof val === 'string' ? val : 'component';
			
			return {
				materialReadme
			};
		});
		
		expect(result.materialReadme).toContain('readme.svg');
	});

	test('should fallback to theme default folder icon for unknown folders', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			appState.prefs.fileIconThemeId = 'material';
			
			// Wait for the theme to load
			for (let i = 0; i < 50; i++) {
				if (icons.getFileThemes().some((t: any) => t.id === 'material')) {
					break;
				}
				await new Promise(r => setTimeout(r, 50));
			}
			
			const val = icons.getFolderIcon('some-unlikely-folder-name');
			const materialUnknown = typeof val === 'string' ? val : 'component';
			
			return {
				materialUnknown
			};
		});
		
		expect(result.materialUnknown).toMatch(/folder-base\.svg|folder\.svg/);
	});

	test('should resolve language icons for VS Code theme', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			appState.prefs.fileIconThemeId = 'vscode';
			
			// Wait for the theme to load
			for (let i = 0; i < 50; i++) {
				if (icons.getFileThemes().some((t: any) => t.id === 'vscode')) {
					break;
				}
				await new Promise(r => setTimeout(r, 50));
			}
			
			const tsVal = icons.getLanguageIcon('typescript');
			const jsVal = icons.getLanguageIcon('javascript');
			const htmlVal = icons.getLanguageIcon('html');
			const svelteVal = icons.getLanguageIcon('svelte');
			
			return {
				ts: typeof tsVal === 'string' ? tsVal : 'component',
				js: typeof jsVal === 'string' ? jsVal : 'component',
				html: typeof htmlVal === 'string' ? htmlVal : 'component',
				svelte: typeof svelteVal === 'string' ? svelteVal : 'component'
			};
		});
		
		expect(result.ts).toContain('typescript.svg');
		expect(result.js).toContain('js.svg');
		expect(result.html).toContain('html.svg');
		expect(result.svelte).toContain('svelte.svg');
	});
});
