import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';

test.describe('Workspace State & Draft Persistence Integration Tests', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: 30000 });
		await page.waitForFunction(() => typeof (window as any).appState !== 'undefined' && typeof (window as any).browserHandleRegistry !== 'undefined');

		// Define mock filesystem classes inside the browser context
		await page.evaluate(() => {
			class MockFileHandle {
				kind = 'file' as const;
				deleted = false;
				constructor(public name: string, public data: Uint8Array = new Uint8Array(), public mtime = Date.now()) {}
				async isSameEntry(other: any) { return this === other; }
				async queryPermission() { return 'granted' as const; }
				async getFile() {
					if (this.deleted) {
						const err = new Error('File not found');
						err.name = 'NotFoundError';
						throw err;
					}
					return new File([this.data as any], this.name, { lastModified: this.mtime });
				}
				async createWritable() {
					const self = this;
					const chunks: Uint8Array[] = [];
					return {
						write: async (chunk: any) => {
							if (typeof chunk === 'string') {
								chunks.push(new TextEncoder().encode(chunk));
							} else if (chunk instanceof ArrayBuffer) {
								chunks.push(new Uint8Array(chunk));
							} else if (ArrayBuffer.isView(chunk)) {
								chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
							} else if (chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'write' && chunk.data) {
								let data = chunk.data;
								if (typeof data === 'string') {
									chunks.push(new TextEncoder().encode(data));
								} else if (data instanceof ArrayBuffer) {
									chunks.push(new Uint8Array(data));
								} else if (ArrayBuffer.isView(data)) {
									chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
								} else {
									chunks.push(new Uint8Array(data));
								}
							} else {
								chunks.push(new Uint8Array(chunk));
							}
						},
						close: async () => {
							const size = chunks.reduce((acc, c) => acc + c.byteLength, 0);
							const buf = new Uint8Array(size);
							let offset = 0;
							for (const c of chunks) {
								buf.set(c, offset);
								offset += c.byteLength;
							}
							self.data = buf;
							self.mtime = Date.now();
						}
					};
				}
			}

			class MockDirectoryHandle {
				kind = 'directory' as const;
				entriesMap = new Map<string, MockDirectoryHandle | MockFileHandle>();
				constructor(public name: string) {}
				async isSameEntry(other: any) { return this === other; }
				async getDirectoryHandle(name: string, options?: { create?: boolean }) {
					let entry = this.entriesMap.get(name);
					if (!entry) {
						if (options?.create) {
							entry = new MockDirectoryHandle(name);
							this.entriesMap.set(name, entry);
						} else {
							const err = new Error('Not found');
							err.name = 'NotFoundError';
							throw err;
						}
					}
					if (entry.kind !== 'directory') {
						const err = new Error('Type mismatch');
						err.name = 'TypeMismatchError';
						throw err;
					}
					return entry as MockDirectoryHandle;
				}
				async getFileHandle(name: string, options?: { create?: boolean }) {
					let entry = this.entriesMap.get(name);
					if (!entry) {
						if (options?.create) {
							entry = new MockFileHandle(name);
							this.entriesMap.set(name, entry);
						} else {
							const err = new Error('Not found');
							err.name = 'NotFoundError';
							throw err;
						}
					}
					if (entry.kind !== 'file') {
						const err = new Error('Type mismatch');
						err.name = 'TypeMismatchError';
						throw err;
					}
					return entry as MockFileHandle;
				}
				async *keys() { for (const k of this.entriesMap.keys()) yield k; }
				async *values() { for (const v of this.entriesMap.values()) yield v; }
				async *entries() { for (const entry of this.entriesMap.entries()) yield entry; }
				async removeEntry(name: string, options?: { recursive?: boolean }) {
					const entry = this.entriesMap.get(name);
					if (entry && 'deleted' in entry) {
						(entry as any).deleted = true;
					}
					this.entriesMap.delete(name);
				}
				async resolve(possibleDescendant: any): Promise<string[] | null> {
					if (possibleDescendant === this) return [];
					for (const [name, entry] of this.entriesMap.entries()) {
						if (entry === possibleDescendant) return [name];
						if (entry.kind === 'directory') {
							const res = await (entry as MockDirectoryHandle).resolve(possibleDescendant);
							if (res !== null) return [name, ...res];
						}
					}
					return null;
				}
				async queryPermission() { return 'granted' as const; }
			}

			(window as any).MockFileHandle = MockFileHandle;
			(window as any).MockDirectoryHandle = MockDirectoryHandle;
		});
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

			// 3. Clear workspace documents and restore
			appState.workspace.documents = [];
			await appState.workspace.restoreSession(true);

			// Wait for background draft loading/resolving
			await new Promise(resolve => setTimeout(resolve, 100));

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
});
