import { test, expect } from '@playwright/test';

test.describe('Catppuccin Icon Flavor Switching', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for app to mount
		await expect(page.locator('.cm-content')).toBeVisible();
	});

	test('should update catppuccin flavor based on theme', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			// Set theme to catppuccin-latte
			appState.prefs.theme = 'catppuccin-latte';
			// Force file icon theme to catppuccin
			appState.prefs.fileIconThemeId = 'catppuccin';
			
			// Wait for $effect to run (tick)
			await new Promise(r => setTimeout(r, 100));
			
			const latteIcon = icons.getFileIcon('test.ts');
			
			// Switch to mocha
			appState.prefs.theme = 'catppuccin-mocha';
			await new Promise(r => setTimeout(r, 100));
			const mochaIcon = icons.getFileIcon('test.ts');
			
			return {
				latteIcon,
				mochaIcon
			};
		});
		
		expect(result.latteIcon).toContain('/latte/typescript.svg');
		expect(result.mochaIcon).toContain('/mocha/typescript.svg');
	});

	test('should use correct icon names for catppuccin (e.g. _file.svg)', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			appState.prefs.fileIconThemeId = 'catppuccin';
			appState.prefs.theme = 'catppuccin-mocha';
			await new Promise(r => setTimeout(r, 100));
			
			return {
				defaultFile: icons.getFileIcon('random.unknown'),
				packageJson: icons.getFileIcon('package.json'),
				tsconfig: icons.getFileIcon('tsconfig.json')
			};
		});
		
		expect(result.defaultFile).toContain('/mocha/_file.svg');
		expect(result.packageJson).toContain('/mocha/package-json.svg');
		expect(result.tsconfig).toContain('/mocha/typescript-config.svg');
	});
});
