import { test, expect } from '@playwright/test';

test.describe('Icon Resolution for Folders and Files', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible();
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
				
				await new Promise(r => setTimeout(r, 50));
				
				return {
					node: icons.getFolderIcon('node_modules'),
					src: icons.getFolderIcon('src'),
					dist: icons.getFolderIcon('dist'),
					git: icons.getFolderIcon('.git'),
					public: icons.getFolderIcon('public'),
					lib: icons.getFolderIcon('lib'),
					static: icons.getFolderIcon('static')
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
			await new Promise(r => setTimeout(r, 50));
			const materialReadme = icons.getFileIcon('README.md');
			
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
			await new Promise(r => setTimeout(r, 50));
			const materialUnknown = icons.getFolderIcon('some-unlikely-folder-name');
			
			return {
				materialUnknown
			};
		});
		
		expect(result.materialUnknown).toContain('folder-base.svg');
	});
});
