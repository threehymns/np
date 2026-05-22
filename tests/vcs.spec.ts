import { test, expect } from '@playwright/test';

test.describe('VCS and Branch Switching Integration Tests', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible();

		// Define mock filesystem classes and setup helper inside the browser context
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
					return new File([this.data], this.name, { lastModified: this.mtime });
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

			(window as any).setupTestGitRepo = async () => {
				const appState = (window as any).appState;
				const git = (window as any).git;
				const RepositoryClass = (window as any).Repository;
				if (!git) throw new Error('isomorphic-git is not exposed on window');
				if (!RepositoryClass) throw new Error('Repository constructor not found');

				const root = new MockDirectoryHandle('test-project');
				const repository = new RepositoryClass(root as any);
				const adapter = repository.adapter;

				// Create dummy .git folder to allow adapter to initialize its fs
				await root.getDirectoryHandle('.git', { create: true });
				await repository.refresh();
				const gitFs = (adapter as any).fs;
				if (!gitFs) throw new Error('Failed to initialize adapter.fs');

				await git.init({ fs: gitFs, dir: '/repo', defaultBranch: 'main' });
				await gitFs.promises.writeFile('/repo/README.md', 'Hello World');
				await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
				await git.commit({
					fs: gitFs,
					dir: '/repo',
					message: 'Initial commit',
					author: { name: 'Test User', email: 'test@example.com' }
				});

				await git.branch({
					fs: gitFs,
					dir: '/repo',
					ref: 'feature-branch'
				});

				await repository.refresh();

				// Expose workspace details
				appState.workspace.rootHandle = root;
				appState.workspace.hasRootPermission = true;
				appState.workspace.repository = repository;

				return { root, repository, gitFs };
			};
		});
	});

	test('should detect git repository and list branches (TRACER BULLET)', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const { repository } = await (window as any).setupTestGitRepo();
			return {
				currentBranch: repository.currentBranch,
				branches: repository.branches
			};
		});

		expect(result.currentBranch).toBe('main');
		expect(result.branches).toContain('main');
		expect(result.branches).toContain('feature-branch');
	});

	test('should detect unsaved editor changes and block branch switching', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			await (window as any).setupTestGitRepo();
			
			// Modify the active document's content (unsaved change)
			const doc = appState.workspace.documents[0];
			doc.content = 'unsaved editor changes';
			
			const report = await appState.workspace.getBranchSafetyReport('feature-branch');
			return {
				isModified: doc.isModified,
				fileName: doc.fileName,
				report
			};
		});

		expect(result.isModified).toBe(true);
		expect(result.report).not.toBeNull();
		expect(result.report.canSwitch).toBe(false);
		expect(result.report.unsavedFiles).toContain(result.fileName);
	});

	test('should block branch switching when there are conflicting unstaged changes', async ({ page }) => {
		const report = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const { gitFs } = await (window as any).setupTestGitRepo();

			// 1. Switch to feature-branch, modify README.md, and commit
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'feature-branch' });
			await gitFs.promises.writeFile('/repo/README.md', 'Feature Branch Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await git.commit({
				fs: gitFs,
				dir: '/repo',
				message: 'Feature branch update',
				author: { name: 'Test User', email: 'test@example.com' }
			});

			// 2. Switch back to main
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'main' });

			// 3. Create a local unstaged change on main
			await gitFs.promises.writeFile('/repo/README.md', 'Local Conflicting Content');

			// 4. Get safety report for feature-branch
			return await appState.workspace.getBranchSafetyReport('feature-branch');
		});

		expect(report).not.toBeNull();
		expect(report.canSwitch).toBe(false);
		expect(report.uncommittedFiles).toContain('README.md');
	});

	test('should block branch switching when there are conflicting staged changes', async ({ page }) => {
		page.on('console', msg => console.log('PAGE LOG:', msg.text()));
		const report = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const { gitFs } = await (window as any).setupTestGitRepo();

			// 1. Switch to feature-branch, modify README.md, and commit
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'feature-branch' });
			await gitFs.promises.writeFile('/repo/README.md', 'Feature Branch Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await git.commit({
				fs: gitFs,
				dir: '/repo',
				message: 'Feature branch update',
				author: { name: 'Test User', email: 'test@example.com' }
			});

			// 2. Switch back to main
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'main' });

			// 3. Create a local staged change on main
			await gitFs.promises.writeFile('/repo/README.md', 'Local Staged Conflicting Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });

			// 4. Get safety report for feature-branch
			return await appState.workspace.getBranchSafetyReport('feature-branch');
		});

		expect(report).not.toBeNull();
		expect(report.canSwitch).toBe(false);
		expect(report.uncommittedFiles).toContain('README.md');
	});

	test('should allow branch switching and carry over changes when there are no conflicts', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const { gitFs } = await (window as any).setupTestGitRepo();

			// Create a local unstaged change on main
			await gitFs.promises.writeFile('/repo/README.md', 'Local Non-Conflicting Content');

			// Get safety report for feature-branch
			const report = await appState.workspace.getBranchSafetyReport('feature-branch');

			// Actually switch branch
			let checkoutError = null;
			try {
				await appState.workspace.switchBranch('feature-branch');
			} catch (e: any) {
				checkoutError = e.message;
			}

			// Verify new content and branch
			const currentBranch = appState.workspace.currentBranch;
			const fileContent = await gitFs.promises.readFile('/repo/README.md', 'utf8');

			return {
				report,
				checkoutError,
				currentBranch,
				fileContent
			};
		});

		expect(result.report).not.toBeNull();
		expect(result.report.canSwitch).toBe(true);
		expect(result.checkoutError).toBeNull();
		expect(result.currentBranch).toBe('feature-branch');
		expect(result.fileContent).toBe('Local Non-Conflicting Content');
	});

	test('should display branch safety modal UI and block switching when triggered via UI', async ({ page }) => {
		// 1. Setup repository and create a conflict
		await page.evaluate(async () => {
			const { gitFs } = await (window as any).setupTestGitRepo();
			const git = (window as any).git;

			// Switch to feature-branch, modify README.md, and commit
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'feature-branch' });
			await gitFs.promises.writeFile('/repo/README.md', 'Feature Branch Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await git.commit({
				fs: gitFs,
				dir: '/repo',
				message: 'Feature branch update',
				author: { name: 'Test User', email: 'test@example.com' }
			});

			// Switch back to main
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'main' });

			// Create conflicting unstaged change on main
			await gitFs.promises.writeFile('/repo/README.md', 'Local Conflicting Content');
		});

		// 2. Click branch button in the file explorer sidebar to open the branch switcher dropdown
		const branchButton = page.locator('button:has-text("main")');
		await expect(branchButton).toBeVisible();
		await branchButton.click();

		// 3. Click the target branch in the command list dropdown
		const targetBranchOption = page.locator('[data-command-item]:has-text("feature-branch")');
		await expect(targetBranchOption).toBeVisible();
		await targetBranchOption.click();

		// 4. Assert that the safety modal is shown
		const modalTitle = page.locator('text=Cannot Switch Branch');
		await expect(modalTitle).toBeVisible();

		// Assert that the warning lists the conflicting file
		const uncommittedSection = page.locator('text=Uncommitted Changes (Disk)');
		await expect(uncommittedSection).toBeVisible();
		const fileItem = page.locator('li:has-text("README.md")');
		await expect(fileItem).toBeVisible();

		// 5. Click Cancel and verify the modal disappears and branch remains unchanged
		const cancelButton = page.locator('button:has-text("Cancel")');
		await expect(cancelButton).toBeVisible();
		await cancelButton.click();

		await expect(modalTitle).not.toBeVisible();
		await expect(branchButton).toHaveText('main');
	});

	test('should keep tabs open and mark them as deleted-on-disk when files are deleted during branch switch', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const { gitFs } = await (window as any).setupTestGitRepo();

			// 1. Create and commit file-to-delete.md on main branch
			await gitFs.promises.writeFile('/repo/file-to-delete.md', 'To be deleted');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'file-to-delete.md' });
			await git.commit({
				fs: gitFs,
				dir: '/repo',
				message: 'Add file to delete',
				author: { name: 'Test User', email: 'test@example.com' }
			});

			// 2. Open this file in the workspace
			const handle = await appState.workspace.rootHandle.getFileHandle('file-to-delete.md');
			await appState.workspace.openFile(handle);

			// 3. Verify it is in the documents list
			const docsBefore = appState.workspace.documents.map((d: any) => d.fileName);

			// 4. Create and checkout a branch called 'delete-branch'
			await git.branch({ fs: gitFs, dir: '/repo', ref: 'delete-branch' });
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'delete-branch' });

			// 5. Delete file-to-delete.md and commit the deletion in 'delete-branch'
			await gitFs.promises.unlink('/repo/file-to-delete.md');
			await git.remove({ fs: gitFs, dir: '/repo', filepath: 'file-to-delete.md' });
			await git.commit({
				fs: gitFs,
				dir: '/repo',
				message: 'Delete file',
				author: { name: 'Test User', email: 'test@example.com' }
			});

			// 6. Switch back to main (where file exists)
			await git.checkout({ fs: gitFs, dir: '/repo', ref: 'main' });
			await appState.workspace.repository?.refresh();

			// 7. Switch branch to delete-branch (where file is deleted)
			await appState.workspace.switchBranch('delete-branch');

			const docsAfter = appState.workspace.documents.map((d: any) => d.fileName);
			const docDeletedOnDisk = appState.workspace.documents.find((d: any) => d.fileName === 'file-to-delete.md')?.deletedOnDisk;

			return {
				docsBefore,
				docsAfter,
				docDeletedOnDisk
			};
		});

		expect(result.docsBefore).toContain('file-to-delete.md');
		expect(result.docsAfter).toContain('file-to-delete.md');
		expect(result.docDeletedOnDisk).toBe(true);

		// Assert visual indicator in the tab UI
		const tab = page.locator('button[role="tab"]:has-text("file-to-delete.md")');
		await expect(tab).toBeVisible();
		await expect(tab).toHaveClass(/line-through/);
		await expect(tab).toHaveAttribute('title', 'file-to-delete.md (deleted on disk)');
	});
});
