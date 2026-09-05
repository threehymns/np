import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';

test.describe('Wikilink autocomplete', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
		await page.waitForFunction(() => typeof (window as any).appState !== 'undefined' && typeof (window as any).browserHandleRegistry !== 'undefined');

		// Install mock filesystem classes inside the browser context
		await page.evaluate(installMockFS);
	});

	test('typing [[ pops up note completions', async ({ page }) => {
		// Seed two notes as open documents so the note-search source has options
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			const enc = new TextEncoder();
			const noteA = new (window as any).MockFileHandle('Note A.md', enc.encode('# Note A\n'));
			const research = new (window as any).MockFileHandle('Research.md', enc.encode('# Research\n'));
			await (window as any).browserHandleRegistry.register('browser://Note A.md', noteA);
			await (window as any).browserHandleRegistry.register('browser://Research.md', research);
			await appState.workspace.openFile({ scheme: 'browser', path: 'Note A.md', name: 'Note A.md' });
			await appState.workspace.openFile({ scheme: 'browser', path: 'Research.md', name: 'Research.md' });
		});

		const editor = page.locator('.cm-content').first();
		await editor.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.press('Backspace');
		await page.keyboard.type('See [[');

		const tooltip = page.locator('.cm-tooltip-autocomplete').first();
		await expect(tooltip).toBeVisible({ timeout: 5000 });
		const text = await tooltip.innerText();
		expect(text).toContain('Note A');
		expect(text).toContain('Research');
	});
});
