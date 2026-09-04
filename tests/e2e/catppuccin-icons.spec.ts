import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

test.describe('Catppuccin Icon Theme', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
	});

	test('should resolve icons for catppuccin theme', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const icons = appState.icons;
			
			appState.prefs.fileIconThemeId = 'catppuccin';
			
			// Wait for the theme to load
			for (let i = 0; i < 50; i++) {
				if (icons.getFileThemes().some((t: any) => t.id === 'catppuccin')) {
					break;
				}
				await new Promise(r => setTimeout(r, 50));
			}
			
			const getIconVal = (file: string) => {
				const val = icons.getFileIcon(file);
				return typeof val === 'string' ? val : 'component';
			};
			
			return {
				defaultFile: getIconVal('random.unknown'),
				packageJson: getIconVal('package.json'),
				tsconfig: getIconVal('tsconfig.json'),
				typescript: getIconVal('test.ts')
			};
		});
		
		expect(result.defaultFile).toMatch(/\.svg|component/);
		expect(result.packageJson).toContain('.svg');
		expect(result.tsconfig).toContain('.svg');
		expect(result.typescript).toContain('.svg');
	});

	test('should resolve icons for material theme', async ({ page }) => {
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
			
			const getIconVal = (file: string) => {
				const val = icons.getFileIcon(file);
				return typeof val === 'string' ? val : 'component';
			};
			
			return {
				defaultFile: getIconVal('random.unknown'),
				packageJson: getIconVal('package.json'),
				tsconfig: getIconVal('tsconfig.json'),
				typescript: getIconVal('test.ts')
			};
		});
		
		expect(result.defaultFile).toContain('.svg');
		expect(result.packageJson).toMatch(/npm\.svg|nodejs\.svg/);
		expect(result.tsconfig).toContain('tsconfig.svg');
		expect(result.typescript).toContain('typescript.svg');
	});
});
