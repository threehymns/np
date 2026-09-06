import { test, expect } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

// The Explorer / Source Control buttons must swap the *visible* sidebar
// panel. A previous failure mode (a `$state` rune in a plain `.ts` module
// crashing GitPanel's lazy import) left `activeSidebarTab` updating while
// MainLayout kept rendering the stale panel, so this asserts on visible
// content, not just state. See tests/runes-file-placement.test.ts for the
// fast static guard covering the underlying cause.

test.describe('Sidebar panel switching', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
	});

	test('explorer and git buttons swap the visible sidebar panel', async ({ page }) => {
		const svelteErrors: string[] = [];
		page.on('pageerror', (e) => {
			if (String(e).includes('Svelte error')) svelteErrors.push(String(e).slice(0, 300));
		});

		await page.goto('/');
		// Cold dev-server boot can take a while (module transforms happen on
		// first load); appState is the true readiness signal, not any
		// particular element.
		await page.waitForFunction(() => (window as any).appState, { timeout: 60000 });
		await expect(page.locator('footer')).toBeVisible();
		await expect(page.locator('aside')).toBeVisible();

		const sidebarText = () =>
			page.evaluate(() => document.querySelector('aside')?.innerText ?? '');
		const activeTab = () =>
			page.evaluate(() => (window as any).appState.activeSidebarTab as string);

		// Footer icon-button order is defined by AppShell.svelte's
		// statusButton block: toggle sidebar, explorer, git, ...
		const buttons = page.locator('footer button');
		const explorerBtn = buttons.nth(1);
		const gitBtn = buttons.nth(2);

		await page.evaluate(() => {
			const a = (window as any).appState;
			a.activeSidebarTab = 'explorer';
			a.prefs.sidebarVisible = true;
		});

		await gitBtn.click();
		expect(await activeTab()).toBe('git');
		await expect.poll(sidebarText, { timeout: 5000 }).toContain('No Git Repository');

		await explorerBtn.click();
		expect(await activeTab()).toBe('explorer');
		await expect.poll(sidebarText, { timeout: 5000 }).toContain('No folder opened');

		await gitBtn.click();
		expect(await activeTab()).toBe('git');
		await expect.poll(sidebarText, { timeout: 5000 }).toContain('No Git Repository');

		expect(svelteErrors).toEqual([]);
	});
});
