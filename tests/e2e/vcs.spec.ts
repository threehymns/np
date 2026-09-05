import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';

test.describe('VCS and Branch Switching Integration Tests', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content')).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

		// Install mock filesystem classes and the repo setup helper inside the browser context
		await page.evaluate(installMockFS);
		await page.evaluate(() => {

			(window as any).setupTestGitRepo = async () => {
				const appState = (window as any).appState;
				const git = (window as any).git;
				const RepositoryClass = (window as any).Repository;
				if (!git) throw new Error('isomorphic-git is not exposed on window');
				if (!RepositoryClass) throw new Error('Repository constructor not found');

				const root = new (window as any).MockDirectoryHandle('test-project');
				const origin = { scheme: 'browser', path: root.name, name: root.name };
				await (window as any).browserHandleRegistry.register(`browser://${root.name}`, root);
				const repository = new RepositoryClass(origin, appState.workspace.vcsFactory);
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
				appState.workspace.rootOrigin = origin;
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
			const fileOrigin = {
				scheme: 'browser',
				path: 'test-project/file-to-delete.md',
				name: 'file-to-delete.md'
			};
			await appState.workspace.openFile(fileOrigin);

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

	test('should carry forward staged modifications and keep them staged', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const { gitFs } = await (window as any).setupTestGitRepo();

			// 1. Create a staged modification
			await gitFs.promises.writeFile('/repo/README.md', 'Staged Change Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });

			// 2. Create a staged new file
			await gitFs.promises.writeFile('/repo/new-file.md', 'New File Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'new-file.md' });

			// 3. Switch branch
			const res = await appState.workspace.switchBranch('feature-branch');

			// 4. Check status matrix on feature-branch
			const matrix = await git.statusMatrix({ fs: gitFs, dir: '/repo' });
			const readmeStatus = matrix.find((row: any) => row[0] === 'README.md');
			const newFileStatus = matrix.find((row: any) => row[0] === 'new-file.md');

			return {
				res,
				currentBranch: appState.workspace.currentBranch,
				readmeStatus,
				newFileStatus
			};
		});

		expect(result.res.status).toBe('switched');
		expect(result.currentBranch).toBe('feature-branch');
		// README.md: [1, 2, 2] -> present in HEAD, modified in workdir, identical in STAGE to WORKDIR (staged)
		expect(result.readmeStatus).toEqual(['README.md', 1, 2, 2]);
		// new-file.md: [0, 2, 2] -> absent in HEAD, present in WORKDIR, identical in STAGE to WORKDIR (staged)
		expect(result.newFileStatus).toEqual(['new-file.md', 0, 2, 2]);
	});

	test('should carry forward partially staged modifications and preserve the three-way split', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const { gitFs } = await (window as any).setupTestGitRepo();

			// 1. Write staged content and add
			await gitFs.promises.writeFile('/repo/README.md', 'Staged Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });

			// 2. Write workdir content (differs from staged content)
			await gitFs.promises.writeFile('/repo/README.md', 'Workdir Content');

			// 3. Switch branch
			const res = await appState.workspace.switchBranch('feature-branch');

			// 4. Check status matrix
			const matrix = await git.statusMatrix({ fs: gitFs, dir: '/repo' });
			const readmeStatus = matrix.find((row: any) => row[0] === 'README.md');

			// 5. Read workdir content
			const workdirContent = await gitFs.promises.readFile('/repo/README.md', 'utf8');

			// 6. Read staged content from OID
			let stagedContent = null;
			if (readmeStatus) {
				const stagedOids: Record<string, string> = {};
				await git.walk({
					fs: gitFs,
					dir: '/repo',
					trees: [git.STAGE()],
					map: async (filepath: string, [entry]: [any]) => {
						if (filepath === '.' || !entry) return;
						const type = await entry.type();
						if (type === 'blob') {
							stagedOids[filepath] = await entry.oid();
						}
					}
				});
				const oid = stagedOids['README.md'];
				if (oid) {
					const { blob } = await git.readBlob({ fs: gitFs, dir: '/repo', oid });
					stagedContent = new TextDecoder().decode(blob);
				}
			}

			return {
				res,
				readmeStatus,
				workdirContent,
				stagedContent
			};
		});

		expect(result.res.status).toBe('switched');
		// README.md: [1, 2, 3] -> present in HEAD, modified in workdir, stage differs from workdir (partially staged)
		expect(result.readmeStatus).toEqual(['README.md', 1, 2, 3]);
		expect(result.workdirContent).toBe('Workdir Content');
		expect(result.stagedContent).toBe('Staged Content');
	});

	test('should roll back atomically to original branch and restore changes if checkout fails', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const { gitFs } = await (window as any).setupTestGitRepo();

			// Create a feature branch to switch to
			await git.branch({ fs: gitFs, dir: '/repo', ref: 'fail-branch' });

			// 1. Create a staged modification
			await gitFs.promises.writeFile('/repo/README.md', 'Uncommitted Content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });

			// 2. Mock git.checkout to fail when doing the actual checkout of fail-branch
			const originalCheckout = git.checkout;
			git.checkout = async (opts: any) => {
				if (opts.ref === 'fail-branch' && !opts.dryRun) {
					throw new Error('Mock checkout failed');
				}
				return originalCheckout(opts);
			};

			// 3. Attempt switch
			const res = await appState.workspace.switchBranch('fail-branch');

			// Restore git.checkout mock
			git.checkout = originalCheckout;

			// 4. Check current branch and file status
			const currentBranch = appState.workspace.currentBranch;
			const matrix = await git.statusMatrix({ fs: gitFs, dir: '/repo' });
			const readmeStatus = matrix.find((row: any) => row[0] === 'README.md');
			const readmeContent = await gitFs.promises.readFile('/repo/README.md', 'utf8');

			return {
				res,
				currentBranch,
				readmeStatus,
				readmeContent
			};
		});

		expect(result.res.status).toBe('error');
		expect(result.res.message).toBe('Mock checkout failed');
		expect(result.currentBranch).toBe('main');
		expect(result.readmeStatus).toEqual(['README.md', 1, 2, 2]);
		expect(result.readmeContent).toBe('Uncommitted Content');
	});
});
