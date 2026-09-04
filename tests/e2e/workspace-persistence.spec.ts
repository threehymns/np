import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';

test.describe('Workspace State & Draft Persistence Integration Tests', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
		await page.waitForFunction(() => typeof (window as any).appState !== 'undefined' && typeof (window as any).browserHandleRegistry !== 'undefined');

		// Install mock filesystem classes inside the browser context
		await page.evaluate(installMockFS);
	});

	test('should persist and restore drafts for Untitled and modified documents', async ({ page }) => {
		const restoredData = await page.evaluate(async () => {
			const appState = (window as any).appState;
			
			// 1. Modify the initial Untitled file content
			const doc1 = appState.workspace.documents[0];
			doc1.content = 'Draft content for Untitled file';
			
			// 2. Open/Mock a file, modify it so it has unsaved changes (draft)
			const mockFile = new (window as any).MockFileHandle('notes.md', new TextEncoder().encode('Original content'));
			await (window as any).browserHandleRegistry.register('browser://notes.md', mockFile);
			
			const doc2 = await appState.workspace.openFile({ scheme: 'browser', path: 'notes.md', name: 'notes.md' });
			doc2.content = 'Unsaved modified draft content';

			// 3. Flush the saves immediately to mock persistence save
			await appState.workspace.flushSaveOpenFiles();

			// 4. Force a reload by clearing documents state and calling restoreSession
			appState.workspace.documents = [];
			await appState.workspace.restoreSession(true);

			// Wait for background draft loading/resolving
			await new Promise(resolve => setTimeout(resolve, 100));

			const docs = appState.workspace.documents.map((d: any) => ({
				id: d.id,
				fileName: d.fileName,
				content: d.content,
				isModified: d.isModified,
				origin: d.origin
			}));

			return { docs, activeDocumentId: appState.workspace.activeDocumentId };
		});

		// Expect two documents to be restored: notes.md and Untitled 1
		expect(restoredData.docs.length).toBe(2);
		
		const untitledDoc = restoredData.docs.find(d => d.origin === null);
		expect(untitledDoc).toBeDefined();
		expect(untitledDoc?.content).toBe('Draft content for Untitled file');
		expect(untitledDoc?.isModified).toBe(true);

		const notesDoc = restoredData.docs.find(d => d.origin !== null);
		expect(notesDoc).toBeDefined();
		expect(notesDoc?.fileName).toBe('notes.md');
		expect(notesDoc?.content).toBe('Unsaved modified draft content');
		expect(notesDoc?.isModified).toBe(true);
	});

	test('should maintain separate folder-specific tab states', async ({ page }) => {
		const results = await page.evaluate(async () => {
			const appState = (window as any).appState;

			// Setup two folders
			const folderA = new (window as any).MockDirectoryHandle('project-a');
			const folderB = new (window as any).MockDirectoryHandle('project-b');
			
			const originA = { scheme: 'browser', path: 'project-a', name: 'project-a' };
			const originB = { scheme: 'browser', path: 'project-b', name: 'project-b' };

			await (window as any).browserHandleRegistry.register('browser://project-a', folderA);
			await (window as any).browserHandleRegistry.register('browser://project-b', folderB);

			// Register permission mock to return granted
			const verifyPermission = appState.workspace.storage.verifyPermission;
			appState.workspace.storage.verifyPermission = async () => true;

			// Switch to Folder A, create a tab and Untitled tab
			await appState.workspace.openDirectory(originA);
			
			const docA1 = await appState.workspace.newFile();
			docA1.content = 'Folder A Draft';
			
			const activeIdA = appState.workspace.activeDocumentId;
			await appState.workspace.flushSaveOpenFiles();

			// Switch to Folder B, create different tabs
			await appState.workspace.openDirectory(originB);
			
			const docB1 = await appState.workspace.newFile();
			docB1.content = 'Folder B Draft';
			
			const activeIdB = appState.workspace.activeDocumentId;
			await appState.workspace.flushSaveOpenFiles();

			// Read Folder B current state
			const docsB = appState.workspace.documents.map((d: any) => d.content);

			// Switch back to Folder A
			await appState.workspace.openDirectory(originA);
			const docsA = appState.workspace.documents.map((d: any) => d.content);

			// Restore verifyPermission
			appState.workspace.storage.verifyPermission = verifyPermission;

			return {
				docsB,
				docsA,
				activeIdA,
				activeIdB
			};
		});

		// Folder B should contain its own draft
		expect(results.docsB).toContain('Folder B Draft');
		expect(results.docsB).not.toContain('Folder A Draft');

		// Folder A should contain its own draft when restored
		expect(results.docsA).toContain('Folder A Draft');
		expect(results.docsA).not.toContain('Folder B Draft');
	});

	test('should flush open-file persistence on visibilitychange hidden event', async ({ page }) => {
		const restoredData = await page.evaluate(async () => {
			const appState = (window as any).appState;

			// 1. Create a draft in an Untitled file
			const doc = appState.workspace.documents[0];
			doc.content = 'Auto-persisted via visibilitychange hidden';

			// 2. Mock document.visibilityState to 'hidden' and dispatch visibilitychange
			Object.defineProperty(document, 'visibilityState', {
				value: 'hidden',
				writable: true,
				configurable: true
			});
			document.dispatchEvent(new Event('visibilitychange'));

			// Wait deterministically for the persistence flush to complete before restoring
			const startTime = Date.now();
			let flushed = false;
			while (Date.now() - startTime < 5000) {
				const persisted = await appState.workspace.persistence.loadOpenFiles('');
				if (persisted.some((d: any) => d.draftContent === 'Auto-persisted via visibilitychange hidden')) {
					flushed = true;
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			if (!flushed) {
				throw new Error('Timed out waiting for visibilitychange persistence flush');
			}

			// 3. Clear workspace documents and restore
			appState.workspace.documents = [];
			await appState.workspace.restoreSession(true);

			const docs = appState.workspace.documents.map((d: any) => ({
				content: d.content,
				isModified: d.isModified
			}));

			return docs;
		});

		expect(restoredData.length).toBe(1);
		expect(restoredData[0].content).toBe('Auto-persisted via visibilitychange hidden');
		expect(restoredData[0].isModified).toBe(true);
	});

	test('draft typed within the debounce window survives an immediate reload', async ({ page }) => {
		const editor = page.locator('.cm-content').first();
		await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
		await editor.click();
		await page.keyboard.press('Control+A');
		await page.keyboard.press('Backspace');
		await page.keyboard.type('Unload-race draft content');

		// Reload immediately: the 500ms debounced save cannot have fired,
		// so only the unload flush can persist this draft.
		await page.reload();
		const reloadedEditor = page.locator('.cm-content').first();
		await expect(reloadedEditor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
		await expect(reloadedEditor).toContainText('Unload-race draft content');
	});
});
