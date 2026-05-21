import { test, expect } from '@playwright/test';

test.describe('Icon Loading Error Handling', () => {
	test.beforeEach(async ({ page }) => {
		try {
			const session = await page.context().newCDPSession(page);
			await session.send('Network.setCacheDisabled', { cacheDisabled: true });
		} catch (e) {
			console.warn('Could not disable cache via CDP:', e);
		}

		// Force no-cache headers on all SVG requests to prevent browser caching during the test
		await page.route('**/*.svg', async (route) => {
			try {
				const response = await route.fetch();
				await route.fulfill({
					response,
					headers: {
						...response.headers(),
						'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
						'pragma': 'no-cache',
						'expires': '0'
					}
				});
			} catch (e) {
				// If the request fails or is already intercepted/aborted, do nothing
				if (!page.isClosed()) {
					try {
						await route.continue();
					} catch (err) {}
				}
			}
		});

		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible();
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

			await page.evaluate(async () => {
				const appState = (window as any).appState;
				appState.prefs.fileIconThemeId = 'phosphor';
				await new Promise(r => setTimeout(r, 100));
				appState.prefs.fileIconThemeId = 'material';
			});
			const themeFallback = activeTab.locator('img[data-icon-theme-fallback="true"]');
			await expect(themeFallback).toBeVisible({ timeout: 10000 });

			const fallbackSrc = await themeFallback.getAttribute('src');
			if (fallbackSrc) {
				await page.route(fallbackSrc, route => route.fulfill({ status: 404 }));

				await page.evaluate(async () => {
					const appState = (window as any).appState;
					appState.prefs.fileIconThemeId = 'phosphor';
					await new Promise(r => setTimeout(r, 100));
					appState.prefs.fileIconThemeId = 'material';
				});

				const phosphorFallback = activeTab.locator('[data-icon-error="true"]');
				await expect(phosphorFallback).toBeVisible({ timeout: 10000 });
			}
		}
	});
});
