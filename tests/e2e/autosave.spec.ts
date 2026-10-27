import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';

test.describe('Auto-save setting', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
		await page.waitForFunction(
			() =>
				typeof (window as any).appState !== 'undefined' &&
				typeof (window as any).browserHandleRegistry !== 'undefined'
		);
		await page.evaluate(installMockFS);
	});

	async function openMockFile(page: import('@playwright/test').Page, name: string, content: string) {
		await page.evaluate(
			async ({ name, content }) => {
				const file = new (window as any).MockFileHandle(
					name,
					new TextEncoder().encode(content)
				);
				(window as any).__autosaveFiles = (window as any).__autosaveFiles ?? {};
				(window as any).__autosaveFiles[name] = file;
				await (window as any).browserHandleRegistry.register(`browser://${name}`, file);
				const doc = await (window as any).appState.workspace.openFile({
					scheme: 'browser',
					path: name,
					name
				});
				(window as any).__autosaveDocId = doc.id;
			},
			{ name, content }
		);
		await expect(page.locator('[data-testid="editor-input"]').first()).toBeVisible();
		await expect(page.locator('.permission-overlay')).toHaveCount(0);
	}

	async function typeAtEnd(page: import('@playwright/test').Page, text: string) {
		await page.locator('.cm-content').first().click();
		await page.keyboard.press('Control+End');
		await page.keyboard.type(text);
	}

	async function fileText(page: import('@playwright/test').Page, name: string) {
		return page.evaluate(
			(name) =>
				new TextDecoder().decode((window as any).__autosaveFiles[name].data),
			name
		);
	}

	async function waitForFileText(
		page: import('@playwright/test').Page,
		name: string,
		expected: string,
		timeoutMs = 30_000
	) {
		await page.waitForFunction(
			({ name, expected }) =>
				new TextDecoder().decode((window as any).__autosaveFiles[name].data) === expected,
			{ name, expected },
			{ timeout: timeoutMs }
		);
	}

	async function setAutosave(
		page: import('@playwright/test').Page,
		setting: string | { after_delay: { milliseconds: number } }
	) {
		await page.evaluate((setting) => {
			(window as any).appState.prefs.autosave = setting;
		}, setting);
	}

	test('configures after-delay in settings and saves once typing pauses', async ({ page }) => {
		await page.evaluate(() => (window as any).appState.commands.execute('settings.open'));
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await dialog.locator('aside').getByRole('button', { name: 'Editor' }).click();

		const mode = page.locator('#autosave-mode');
		await expect(mode).toBeVisible();
		await mode.selectOption('after_delay');
		const delay = page.locator('#autosave-delay');
		await expect(delay).toBeVisible();
		await delay.fill('150');
		await delay.press('Tab');

		await expect
			.poll(() => page.evaluate(() => (window as any).appState.prefs.autosave))
			.toEqual({ after_delay: { milliseconds: 150 } });

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();

		await openMockFile(page, 'notes.md', 'original notes');
		await typeAtEnd(page, ' edited');

		await waitForFileText(page, 'notes.md', 'original notes edited');
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as any).appState.activeDocument?.isModified ?? true
				)
			)
			.toBe(false);
	});

	test('applies a shorter delay to a pending edit', async ({ page }) => {
		await setAutosave(page, { after_delay: { milliseconds: 5_000 } });
		await openMockFile(page, 'retime.md', 'retime base');
		await typeAtEnd(page, ' retimed');

		await setAutosave(page, { after_delay: { milliseconds: 100 } });
		await waitForFileText(page, 'retime.md', 'retime base retimed', 1_500);
	});

	test('saves on focus change when that trigger is selected', async ({ page }) => {
		await setAutosave(page, 'on_focus_change');
		await openMockFile(page, 'focus.md', 'focus base');
		await typeAtEnd(page, ' focus edit');

		expect(await fileText(page, 'focus.md')).toBe('focus base');

		await page.locator('[data-testid="editor-input"]').first().evaluate((element) => {
			element.dispatchEvent(
				new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })
			);
		});

		await waitForFileText(page, 'focus.md', 'focus base focus edit');
	});

	test('saves every dirty file on window change when that trigger is selected', async ({ page }) => {
		await setAutosave(page, 'on_window_change');
		await openMockFile(page, 'window.md', 'window base');
		await typeAtEnd(page, ' window edit');

		expect(await fileText(page, 'window.md')).toBe('window base');

		await page.evaluate(() => window.dispatchEvent(new Event('blur')));

		await waitForFileText(page, 'window.md', 'window base window edit');
	});

	test('saves a dirty file before closing while auto-save is on', async ({ page }) => {
		await setAutosave(page, 'on_window_change');
		await openMockFile(page, 'close.md', 'close base');
		await typeAtEnd(page, ' close edit');

		await page.evaluate(() => {
			const appState = (window as any).appState;
			return appState.workspace.closeTab(appState.workspace.activeDocument.id);
		});

		await waitForFileText(page, 'close.md', 'close base close edit');
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(window as any).appState.workspace.documents.some(
							(doc: any) => doc.id === (window as any).__autosaveDocId
						)
				)
			)
			.toBe(false);
	});

	test('still asks about an untitled dirty file while auto-save is on', async ({ page }) => {
		await setAutosave(page, 'on_focus_change');
		const untitledId = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const doc = await appState.workspace.newFile();
			appState.workspace.updateDocumentContent(doc, 'untitled draft');
			await appState.workspace.closeTab(doc.id);
			return doc.id;
		});

		const pendingCloseId = await page.evaluate(
			() => (window as any).appState.workspace.pendingCloseId
		);
		expect(pendingCloseId).toBe(untitledId);

		await page.evaluate(() => (window as any).appState.workspace.cancelPendingClose());
	});
});
