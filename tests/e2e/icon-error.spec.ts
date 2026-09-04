import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';
import { EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';

test.describe('Icon Loading Error Handling', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		try {
			const session = await page.context().newCDPSession(page);
			await session.send('Network.setCacheDisabled', { cacheDisabled: true });
		} catch (e) {
			console.warn('Could not disable cache via CDP:', e);
		}

		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
	});

	test('should fallback to theme default icon before Phosphor when image fails (404)', async ({ page }) => {
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			appState.prefs.fileIconThemeId = 'material';
			await new Promise(r => setTimeout(r, 100));
		});

		await page.evaluate(async () => {
			const appState = (window as any).appState;
			await appState.workspace.newFile();
			appState.activeDocument.untitledTitle = 'test.ts';
			await new Promise(r => setTimeout(r, 200));
		});
		
		const activeTab = page.locator('button[role="tab"][data-state="active"]');
		await expect(activeTab).toBeVisible();
		
		const iconImg = activeTab.locator('img');
		await expect(iconImg).toBeVisible();
		const iconSrc = await iconImg.getAttribute('src');
		
		expect(iconSrc).toContain('typescript.svg');
		
		if (iconSrc) {
			await page.route(iconSrc, route => route.fulfill({ status: 404 }));
			
			const themeDefaultUrl = await page.evaluate(() => (window as any).appState.icons.getThemeDefaultFileIcon());
			expect(themeDefaultUrl).toContain('.svg');

			await page.evaluate(() => {
				(window as any).appState.prefs.fileIconThemeId = 'phosphor';
			});
			await page.waitForTimeout(200);
			await page.evaluate(() => {
				(window as any).appState.prefs.fileIconThemeId = 'material';
			});
			await page.waitForTimeout(200);
			const themeFallback = activeTab.locator('img[data-icon-theme-fallback="true"]');
			await expect(themeFallback).toBeVisible({ timeout: 10000 });

			const fallbackSrc = await themeFallback.getAttribute('src');
			if (fallbackSrc) {
				await page.route(fallbackSrc, route => route.fulfill({ status: 404 }));

				await page.evaluate(() => {
					(window as any).appState.prefs.fileIconThemeId = 'phosphor';
				});
				await page.waitForTimeout(200);
				await page.evaluate(() => {
					(window as any).appState.prefs.fileIconThemeId = 'material';
				});

				const phosphorFallback = activeTab.locator('[data-icon-error="true"]');
				await expect(phosphorFallback).toBeVisible({ timeout: 10000 });
			}
		}
	});
});
