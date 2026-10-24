import { test, expect } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';
import { installDiffTestRepo } from './helpers/mock-diff-repo';
import { installDiffLoadCounter, settledDiffCallCount, waitForDiffReload } from './helpers/diff-load';

/**
 * The Diff Viewer specs wait for the repository refresh to reload the diff
 * before they read the pane. That wait has to mean "the fresh diff data
 * has landed": a wait that returns while the reload is still in flight
 * lets the spec read the PREVIOUS snapshot, and the spec then passes or
 * fails for the wrong reason.
 */
test.describe('DiffViewer reload synchronization', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await page.evaluate(installMockFS);
		// The app boots lazily: the editor bundle, then the Git plugin
		// (its module is imported on demand). Under parallel load the
		// cold boot needs more than the usual editor timeout, so these
		// waits use Playwright's default timeout.
		await page.waitForFunction(() => (window as any).appState !== undefined);
		await page.waitForFunction(() => !!(window as any).appState?.commands?.get('git.openDiff'));
	});

	test('waits for the fresh diff data before the pane is read', async ({ page }) => {
		await page.evaluate(installDiffTestRepo);

		// Make every diff load slow. A wait that only watches the call
		// START returns long before the data arrives, and the spec would
		// read the previous snapshot. The delay goes UNDER the counter, so
		// the counter measures the whole load.
		await page.evaluate(() => {
			const adapter = (window as any).appState.workspace.project.repository.adapter;
			const original = adapter.getFileDiff.bind(adapter);
			adapter.getFileDiff = async (...args: any[]) => {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				return original(...args);
			};
		});
		await installDiffLoadCounter(page);

		await page.evaluate(() => {
			(window as any).appState.commands.execute('git.openDiff');
		});
		await expect(page.locator('button[role="tab"]:has-text("Uncommitted Changes")')).toBeVisible({ timeout: 20_000 });
		// Split view: the working file's section mounts two CodeMirror
		// editors (Original + Working-copy pane). The editors mount with
		// the diff, so they are there once the first load has landed.
		await expect(page.locator('#diff-file-README\\.md .cm-editor')).toHaveCount(2, { timeout: 20_000 });

		const callsBefore = await settledDiffCallCount(page);

		// Change the working tree and refresh the repository: the viewer
		// reloads the diff for the new content.
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			const repository = appState.workspace.project.repository;
			const gitFs = (repository.adapter as any).fs;
			await gitFs.promises.writeFile(
				'/repo/README.md',
				'Line 1\nLine 2 refreshed\nLine 3\nLine 4 added\n'
			);
			await repository.refresh();
		});

		await waitForDiffReload(page, callsBefore);

		// The Working-copy pane shows the fresh snapshot, not the previous
		// one.
		const paneText = await page.locator('#diff-file-README\\.md .cm-editor').nth(1).innerText();
		expect(paneText).toContain('Line 2 refreshed');
	});
});
