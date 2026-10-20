import { test, expect } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';
import { installDiffTestRepo } from './helpers/mock-diff-repo';

test.describe('DiffViewer CodeMirror instances across a save', () => {
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

	test('keeps the same CodeMirror instances when the diffed file is saved', async ({ page }) => {
		await page.evaluate(installDiffTestRepo);

		// Count diff loads so the test can wait for the post-save reload
		// instead of racing it.
		await page.evaluate(() => {
			const adapter = (window as any).appState.workspace.project.repository.adapter;
			(window as any).__getFileDiffCalls = 0;
			const original = adapter.getFileDiff.bind(adapter);
			adapter.getFileDiff = async (...args: any[]) => {
				(window as any).__getFileDiffCalls += 1;
				return original(...args);
			};
		});

		await page.evaluate(() => {
			(window as any).appState.commands.execute('git.openDiff');
		});

		await expect(page.locator('button[role="tab"]:has-text("Uncommitted Changes")')).toBeVisible({ timeout: 20_000 });
		// Split view: the working file's section mounts two CodeMirror
		// editors (Original + Working-copy pane).
		await expect(page.locator('#diff-file-README\\.md .cm-editor')).toHaveCount(2, { timeout: 20_000 });

		// Mark the live CodeMirror DOM nodes. A remount replaces them.
		await page.evaluate(() => {
			const section = document.getElementById('diff-file-README.md');
			section?.querySelectorAll('.cm-editor').forEach((el, i) => {
				el.setAttribute('data-probe', `editor-${i}`);
			});
		});

		const callsBefore = await page.evaluate(() => (window as any).__getFileDiffCalls);

		// Save the Document the Working-copy pane is bound to.
		const saveResult = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const bound = appState.workspace.diffBoundDocIds;
			const docId = bound.get('README.md');
			const doc =
				appState.workspace.documents.find((d: any) => d.id === docId) ?? appState.activeDiffDocument;
			if (!doc) return { saved: false, reason: `no bound diff document (${JSON.stringify([...bound])})` };
			const saved = await appState.workspace.saveDocument(doc);
			return { saved, reason: null };
		});
		expect(saveResult.reason).toBeNull();
		expect(saveResult.saved).toBe(true);

		// The save refreshes the repository, which reloads the diff.
		await page.waitForFunction(
			(n: number) => (window as any).__getFileDiffCalls > n,
			callsBefore,
			{ timeout: 20_000 }
		);
		await expect(page.locator('#diff-file-README\\.md .cm-editor')).toHaveCount(2, { timeout: 20_000 });

		// The save must not remount the CodeMirror instances: the repository
		// refresh replaces the change list, which used to clear the whole
		// snapshot cache, so the pane's diff went missing for a moment and
		// the pane was torn down and rebuilt from scratch.
		const probes = await page.evaluate(() => {
			const section = document.getElementById('diff-file-README.md');
			return Array.from(section?.querySelectorAll('.cm-editor') ?? []).map((el) =>
				el.getAttribute('data-probe')
			);
		});
		expect(probes).toEqual(['editor-0', 'editor-1']);
	});
});
