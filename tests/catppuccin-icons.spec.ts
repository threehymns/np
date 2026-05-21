import { test, expect } from '@playwright/test';

test.describe('Catppuccin Icon Theme', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible();
	});

	test('should resolve icons for catppuccin theme', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			appState.prefs.fileIconThemeId = 'catppuccin';
			await new Promise(r => setTimeout(r, 100));
			
			return {
				defaultFile: icons.getFileIcon('random.unknown'),
				packageJson: icons.getFileIcon('package.json'),
				tsconfig: icons.getFileIcon('tsconfig.json'),
				typescript: icons.getFileIcon('test.ts')
			};
		});
		
		expect(result.defaultFile).toContain('.svg');
		expect(result.packageJson).toContain('.svg');
		expect(result.tsconfig).toContain('.svg');
		expect(result.typescript).toContain('.svg');
	});

	test('should resolve icons for material theme', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			appState.prefs.fileIconThemeId = 'material';
			await new Promise(r => setTimeout(r, 100));
			
			return {
				defaultFile: icons.getFileIcon('random.unknown'),
				packageJson: icons.getFileIcon('package.json'),
				tsconfig: icons.getFileIcon('tsconfig.json'),
				typescript: icons.getFileIcon('test.ts')
			};
		});
		
		expect(result.defaultFile).toContain('.svg');
		expect(result.packageJson).toContain('npm.svg');
		expect(result.tsconfig).toContain('tsconfig.svg');
		expect(result.typescript).toContain('typescript.svg');
	});
});
