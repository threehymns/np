import { test, expect } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';
import { installDiffTestRepo } from './helpers/mock-diff-repo';

/**
 * The Diff Viewer's Working-copy pane must survive a save with the cursor
 * where the user left it.
 *
 * Saving refreshes the repository, which replaces the change list. The
 * refresh can also change a file's diff SCOPE: a staged file that also has
 * working-tree changes is reported as one combined change, so the scope -
 * and with it the diff cache key - changes under the file. A pane keyed by
 * the scope lost its snapshot, fell back to "Loading diff...", and was torn
 * down and rebuilt: the cursor jumped to the top of the file and the focus
 * was lost.
 */
test.describe('DiffViewer cursor across a save', () => {
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

	/** Install the diff test repo and open the Uncommitted Changes tab. */
	async function openDiff(page: any) {
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
	}

	/**
	 * Focus the Working-copy pane, pin the cursor to `line`/`col`, and mark
	 * the live CodeMirror DOM nodes. A remount replaces them.
	 *
	 * `pane` is the index of the Working-copy pane among the section's
	 * editors: 1 in split mode (Original pane first), 0 in inline mode
	 * (a single unified editor).
	 */
	async function pinCursor(page: any, line: number, col: number, pane = 1) {
		await page.locator('#diff-file-README\\.md .cm-editor').nth(pane).locator('.cm-content').click();
		return page.evaluate(
			({ line, col }) => {
				const view = (window as any).appState.activeEditorView;
				if (!view) return { error: 'no active editor view' };
				const l = view.state.doc.line(line);
				view.dispatch({ selection: { anchor: l.from + col, head: l.from + col } });
				const section = document.getElementById('diff-file-README.md');
				const editors = Array.from(section?.querySelectorAll('.cm-editor') ?? []) as HTMLElement[];
				(window as any).__editors = editors;
				return {
					head: view.state.selection.main.head,
					doc: view.state.doc.toString(),
					hasFocus: view.hasFocus
				};
			},
			{ line, col }
		);
	}

	/** Save the bound Document and wait for the post-save diff reload. */
	async function saveAndSettle(page: any) {
		const callsBefore = await page.evaluate(() => (window as any).__getFileDiffCalls);
		const saveResult = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const bound = appState.workspace.diffBoundDocIds;
			const docId = bound.get('README.md');
			const doc =
				appState.workspace.documents.find((d: any) => d.id === docId) ?? appState.activeDiffDocument;
			if (!doc) return { saved: false, reason: 'no bound diff document' };
			const saved = await appState.workspace.saveDocument(doc);
			return { saved, reason: null };
		});
		expect(saveResult.reason).toBeNull();
		expect(saveResult.saved).toBe(true);
		await page.waitForFunction(
			(n: number) => (window as any).__getFileDiffCalls > n,
			callsBefore,
			{ timeout: 20_000 }
		);
		// Let the fresh snapshot land and be applied to the pane.
		await page.waitForTimeout(500);
	}

	/** The live state of the Working-copy pane after the save. */
	async function paneState(page: any) {
		return page.evaluate(() => {
			const view = (window as any).appState.activeEditorView;
			const section = document.getElementById('diff-file-README.md');
			const editors = Array.from(section?.querySelectorAll('.cm-editor') ?? []) as HTMLElement[];
			const old = ((window as any).__editors ?? []) as HTMLElement[];
			const appState = (window as any).appState;
			const docId = appState.workspace.diffBoundDocIds.get('README.md');
			const doc = appState.workspace.documents.find((d: any) => d.id === docId);
			return {
				head: view ? view.state.selection.main.head : null,
				doc: view ? view.state.doc.toString() : null,
				hasFocus: view ? view.hasFocus : null,
				remounted: old.length !== editors.length || old.some((el, i) => el !== editors[i]),
				editorCount: editors.length,
				boundDocContent: doc ? doc.content : null
			};
		});
	}

	test('keeps the cursor and the pane instance when a save changes the diff scope', async ({ page }) => {
		await openDiff(page);

		// Stage the file: the change list holds a staged entry for it.
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			const repository = appState.workspace.project.repository;
			const git = (window as any).git;
			const gitFs = (repository.adapter as any).fs;
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await repository.refresh();
		});
		await page.waitForTimeout(500);

		// Edit the working copy so the file ends up staged AND modified.
		await pinCursor(page, 2, 5);
		await page.keyboard.type('XY');
		await page.waitForTimeout(300);
		const before = await pinCursor(page, 2, 5);

		await saveAndSettle(page);
		const after = await paneState(page);

		// The pane must not be rebuilt: a rebuild drops the cursor to the
		// top of the file and the focus.
		expect(after.remounted).toBe(false);
		expect(after.editorCount).toBe(2);
		expect(after.hasFocus).toBe(true);
		// The cursor stays where the user left it, and the content is
		// untouched.
		expect(after.head).toBe(before.head);
		expect(after.doc).toBe(before.doc);
	});

	test('keeps the cursor when a plain save refreshes the repository', async ({ page }) => {
		await openDiff(page);

		const before = await pinCursor(page, 2, 5);
		await saveAndSettle(page);
		const after = await paneState(page);

		expect(after.remounted).toBe(false);
		expect(after.hasFocus).toBe(true);
		expect(after.head).toBe(before.head);
		expect(after.doc).toBe(before.doc);
	});

	test('keeps the cursor when a save changes the diff scope in inline view', async ({ page }) => {
		await openDiff(page);

		// Inline view: one unified editor per file section.
		await page.locator('button[title="Inline View"]').click();
		await expect(page.locator('#diff-file-README\\.md .cm-editor')).toHaveCount(1);

		await page.evaluate(async () => {
			const appState = (window as any).appState;
			const repository = appState.workspace.project.repository;
			const git = (window as any).git;
			const gitFs = (repository.adapter as any).fs;
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await repository.refresh();
		});
		await page.waitForTimeout(500);

		await pinCursor(page, 2, 5, 0);
		await page.keyboard.type('XY');
		await page.waitForTimeout(300);
		const before = await pinCursor(page, 2, 5, 0);

		await saveAndSettle(page);
		const after = await paneState(page);

		expect(after.remounted).toBe(false);
		expect(after.editorCount).toBe(1);
		expect(after.hasFocus).toBe(true);
		expect(after.head).toBe(before.head);
		expect(after.doc).toBe(before.doc);
	});

	test('keeps the cursor at the end of a typed line when the file is saved', async ({ page }) => {
		await openDiff(page);

		// Type at the END of a line: the cursor sits after the new
		// characters, and a save must leave it there.
		await page.locator('#diff-file-README\\.md .cm-editor').nth(1).locator('.cm-content').click();
		const endOfLine = await page.evaluate(() => {
			const view = (window as any).appState.activeEditorView;
			const line = view.state.doc.line(3);
			view.dispatch({ selection: { anchor: line.to, head: line.to } });
			const section = document.getElementById('diff-file-README.md');
			(window as any).__editors = Array.from(
				section?.querySelectorAll('.cm-editor') ?? []
			) as HTMLElement[];
			return line.to;
		});

		await page.keyboard.type('XYZ');
		await page.waitForTimeout(300);
		const before = await paneState(page);
		expect(before.head).toBe(endOfLine + 3);

		await saveAndSettle(page);
		const after = await paneState(page);

		// The save must not revert the just-saved Document to the
		// pre-typing snapshot: the pane's content would jump back, and the
		// cursor with it.
		expect(after.boundDocContent).toBe(before.boundDocContent);
		expect(after.doc).toBe(before.doc);
		expect(after.head).toBe(before.head);
		expect(after.remounted).toBe(false);
		expect(after.hasFocus).toBe(true);
	});

	test('keeps the cursor at the end of a typed line when a staged file is saved', async ({ page }) => {
		await openDiff(page);

		// Partially staged: the file has a staged change and further
		// working-tree edits, so the save reports it as a combined change.
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			const repository = appState.workspace.project.repository;
			const git = (window as any).git;
			const gitFs = (repository.adapter as any).fs;
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await repository.refresh();
		});
		await page.waitForTimeout(500);

		await page.locator('#diff-file-README\\.md .cm-editor').nth(1).locator('.cm-content').click();
		const endOfLine = await page.evaluate(() => {
			const view = (window as any).appState.activeEditorView;
			const line = view.state.doc.line(3);
			view.dispatch({ selection: { anchor: line.to, head: line.to } });
			const section = document.getElementById('diff-file-README.md');
			(window as any).__editors = Array.from(
				section?.querySelectorAll('.cm-editor') ?? []
			) as HTMLElement[];
			return line.to;
		});

		await page.keyboard.type('XYZ');
		await page.waitForTimeout(300);
		const before = await paneState(page);
		expect(before.head).toBe(endOfLine + 3);

		await saveAndSettle(page);
		const after = await paneState(page);

		expect(after.boundDocContent).toBe(before.boundDocContent);
		expect(after.doc).toBe(before.doc);
		expect(after.head).toBe(before.head);
		expect(after.remounted).toBe(false);
		expect(after.hasFocus).toBe(true);
	});
});
