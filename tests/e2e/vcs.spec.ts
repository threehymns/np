import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';
import type { Page } from '@playwright/test';

const header = (page: Page) => page.getByRole('banner', { name: 'Workspace' });
const branchTrigger = (page: Page) => header(page).getByRole('button', { name: /^Switch branch:/ });
const branchPicker = (page: Page) => page.locator('[data-slot="popover-content"][aria-label="Branches"]');
const safety = (page: Page) => page.getByRole('alertdialog', { name: 'Cannot Switch Branch' });

async function pickBranch(page: Page, name = 'feature-branch') {
	await branchTrigger(page).click();
	await branchPicker(page).getByRole('combobox', { name: 'Search branches' }).fill(name);
	await branchPicker(page).getByRole('option', { name, exact: true }).click();
}

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

	test('header searches branches, marks the current branch and makes current selection a noop', async ({ page }) => {
		await page.evaluate(async () => {
			await (window as any).setupTestGitRepo();
			const w = (window as any).appState.workspace;
			w.updateDocumentContent(w.documents[0], 'Unsaved draft');
			w.repository.adapter.switchBranch = async () => { throw new Error('No checkout expected'); };
		});
		await branchTrigger(page).click();
		await expect(branchPicker(page).getByRole('option', { name: 'main', exact: true })).toHaveAttribute('aria-current', 'true');
		const search = branchPicker(page).getByRole('combobox', { name: 'Search branches' });
		await expect(search).toBeFocused();
		await search.fill('missing');
		await expect(branchPicker(page)).toContainText('No branches found.');
		await search.fill('feature');
		await expect(branchPicker(page).getByRole('option')).toHaveCount(1);
		await search.fill('main');
		await page.keyboard.press('Enter');
		await expect(branchPicker(page)).toBeHidden();
		await expect(safety(page)).toBeHidden();
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: main');
		await expect(page.locator('.cm-content')).toContainText('Unsaved draft');
	});

	test('header eligibility follows permission, loading, non-Git and detached HEAD', async ({ page }) => {
		await expect(branchTrigger(page)).toHaveCount(0);
		await page.evaluate(async () => { await (window as any).setupTestGitRepo(); });
		await expect(branchTrigger(page)).toBeVisible();
		await page.evaluate(() => { (window as any).appState.workspace.hasRootPermission = false; });
		await expect(branchTrigger(page)).toHaveCount(0);
		await page.evaluate(() => {
			const w = (window as any).appState.workspace;
			w.hasRootPermission = true;
			w.repository.currentBranch = null;
		});
		await expect(branchTrigger(page)).toHaveCount(0);
		await page.evaluate(async () => {
			const w = (window as any).appState.workspace;
			const git = (window as any).git;
			const fs = w.repository.adapter.fs;
			const oid = await git.resolveRef({ fs, dir: '/repo', ref: 'main' });
			await git.checkout({ fs, dir: '/repo', ref: oid });
			await w.repository.refresh();
		});
		await expect(branchTrigger(page)).toHaveCount(0);
		await page.evaluate(() => { (window as any).appState.workspace.repository = null; });
		await expect(branchTrigger(page)).toHaveCount(0);
	});

	test('header protects unsaved Documents, cancels and re-checks before switching', async ({ page }) => {
		await page.evaluate(async () => {
			await (window as any).setupTestGitRepo();
			const a = (window as any).appState;
			a.prefs.sidebarVisible = false;
			await a.workspace.openFile({ scheme: 'browser', path: 'test-project/README.md', name: 'README.md' });
			a.workspace.updateDocumentContent(a.workspace.activeDocument, 'Unsaved editor text');
		});
		await pickBranch(page);
		await expect(safety(page)).toContainText('Unsaved Changes (Editor)');
		await expect(safety(page)).toContainText('README.md');
		await safety(page).getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: main');
		await expect(page.locator('.cm-content')).toContainText('Unsaved editor text');
		await pickBranch(page);
		await safety(page).getByRole('button', { name: 'Re-check' }).click();
		await expect(safety(page)).toContainText('Unsaved Changes (Editor)');
		await page.evaluate(async () => {
			const w = (window as any).appState.workspace;
			await w.saveDocument(w.activeDocument);
		});
		await safety(page).getByRole('button', { name: 'Re-check' }).click();
		await expect(safety(page)).toBeHidden();
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: feature-branch');
		await expect(page.locator('.cm-content')).toContainText('Unsaved editor text');
	});

	for (const failure of ['blocked', 'error', 'rejected', 'preflight', 'recheck'] as const) {
		test(`header reports ${failure} without changing the branch`, async ({ page }) => {
			await page.evaluate(async (failure) => {
				await (window as any).setupTestGitRepo();
				const adapter = (window as any).appState.workspace.repository.adapter;
				let checks = 0;
				adapter.switchBranch = async (_branch: string, options?: { dryRun?: boolean }) => {
					if (options?.dryRun) {
						checks++;
						if (failure === 'preflight') return { status: 'error', message: 'Preflight unavailable. Retry.' };
						if (failure === 'recheck') {
							if (checks > 1) throw new Error('Re-check unavailable. Retry.');
							return { status: 'blocked', reason: 'conflict', files: ['README.md'] };
						}
						return { status: 'switched' };
					}
					if (failure === 'blocked') return { status: 'blocked', reason: 'conflict', files: ['late-conflict.md'] };
					if (failure === 'rejected') throw new Error('Checkout rejected. Retry.');
					return { status: 'error', message: 'Checkout failed. Retry.' };
				};
			}, failure);
			await pickBranch(page);
			if (failure === 'recheck') await safety(page).getByRole('button', { name: 'Re-check' }).click();
			const message = { blocked: 'late-conflict.md', error: 'Checkout failed. Retry.', rejected: 'Checkout rejected. Retry.', preflight: 'Preflight unavailable. Retry.', recheck: 'Re-check unavailable. Retry.' }[failure];
			await expect(safety(page)).toContainText(message);
			await expect(safety(page).getByRole('button', { name: 'Re-check' })).toBeEnabled();
			await safety(page).getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: main');
		});
	}

	test('header switches with Source Control active and carries staged and unstaged contents forward', async ({ page }) => {
		await page.evaluate(async () => {
			const { gitFs, repository } = await (window as any).setupTestGitRepo();
			const git = (window as any).git;
			await gitFs.promises.writeFile('/repo/README.md', 'Staged content');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await gitFs.promises.writeFile('/repo/README.md', 'Unstaged content');
			await repository.refresh();
			(window as any).appState.activeSidebarTab = 'git';
		});
		await expect(page.locator('aside').getByRole('button', { name: /^Switch branch:/ })).toHaveCount(0);
		await pickBranch(page);
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: feature-branch');
		const contents = await page.evaluate(async () => {
			const a = (window as any).appState.workspace.repository.adapter;
			const git = (window as any).git;
			const fs = a.fs;
			let index = '';
			await git.walk({ fs, dir: '/repo', trees: [git.STAGE()], map: async (path: string, [entry]: any[]) => {
				if (path === 'README.md' && entry) {
					const { blob } = await git.readBlob({ fs, dir: '/repo', oid: await entry.oid() });
					index = new TextDecoder().decode(blob);
				}
			} });
			return { disk: await fs.promises.readFile('/repo/README.md', 'utf8'), index, branch: await git.currentBranch({ fs, dir: '/repo' }) };
		});
		expect(contents).toEqual({ disk: 'Unstaged content', index: 'Staged content', branch: 'feature-branch' });
	});

	test('retains a working branch selector inside the commit dialog only', async ({ page }) => {
		await page.evaluate(async () => {
			await (window as any).setupTestGitRepo();
			(window as any).appState.activeSidebarTab = 'git';
		});
		await expect(page.locator('aside').getByRole('button', { name: /^Switch branch:/ })).toHaveCount(0);
		await page.locator('aside').getByRole('button', { name: 'Open Commit Modal', exact: true }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('button', { name: 'Switch branch: main', exact: true }).click();
		await branchPicker(page).getByRole('option', { name: 'feature-branch', exact: true }).click();
		await expect(dialog.getByRole('button', { name: 'Switch branch: feature-branch', exact: true })).toBeEnabled();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: feature-branch');
	});

	test('handles an actual noop result without opening failure feedback', async ({ page }) => {
		await page.evaluate(async () => {
			await (window as any).setupTestGitRepo();
			const w = (window as any).appState.workspace;
			w.repository.adapter.switchBranch = async () => ({ status: 'noop' });
		});
		await pickBranch(page);
		await expect(branchTrigger(page)).toBeEnabled();
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: main');
		await expect(safety(page)).toBeHidden();
	});

	test('discards delayed preflight after a project change through the header', async ({ page }) => {
		await page.evaluate(async () => {
			await (window as any).setupTestGitRepo();
			const w = (window as any).appState.workspace;
			const root = new (window as any).MockDirectoryHandle('destination');
			await (window as any).browserHandleRegistry.register('browser://destination', root);
			w.storage.verifyPermission = async () => true;
			w.recentFolders = [{ scheme: 'browser', path: 'destination', name: 'destination' }];
			(window as any).checkoutCalls = 0;
			w.repository.adapter.switchBranch = async (_branch: string, options?: { dryRun?: boolean }) => {
				if (options?.dryRun) return await new Promise(resolve => { (window as any).finishPreflight = resolve; });
				(window as any).checkoutCalls++;
				return { status: 'switched' };
			};
		});
		await pickBranch(page);
		await expect(branchTrigger(page)).toBeDisabled();
		await expect(branchTrigger(page)).toHaveAttribute('aria-busy', 'true');
		await header(page).getByRole('button', { name: 'Switch project: test-project' }).click();
		await page.getByRole('combobox', { name: 'Search recent projects' }).fill('destination');
		await page.getByRole('option').filter({ hasText: 'browser://destination' }).click();
		await expect(header(page).getByRole('button', { name: 'Switch project: destination' })).toBeEnabled();
		await expect(branchTrigger(page)).toHaveCount(0);
		await page.evaluate(async () => {
			(window as any).finishPreflight({ status: 'switched' });
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		expect(await page.evaluate(() => (window as any).checkoutCalls)).toBe(0);
		await expect(safety(page)).toBeHidden();
		await expect(branchTrigger(page)).toHaveCount(0);
	});

	test('excludes project mutations and retains delayed branch errors across menu expansion', async ({ page }) => {
		await page.evaluate(async () => {
			await (window as any).setupTestGitRepo();
			const w = (window as any).appState.workspace;
			w.repository.adapter.switchBranch = async (_branch: string, options?: { dryRun?: boolean }) => {
				if (options?.dryRun) return { status: 'switched' };
				return await new Promise(resolve => { (window as any).finishSwitch = resolve; });
			};
		});
		await pickBranch(page);
		await page.waitForFunction(() => typeof (window as any).finishSwitch === 'function');
		await expect(branchTrigger(page)).toBeDisabled();
		await expect(header(page).getByRole('button', { name: /^Switch project:/ })).toBeDisabled();
		expect(await page.evaluate(async () => await (window as any).appState.workspace.openDirectory({ scheme: 'browser', path: 'other', name: 'other' }))).toBe(false);
		await page.keyboard.press('F10');
		await expect(branchTrigger(page)).toBeHidden();
		await page.evaluate(() => { (window as any).finishSwitch({ status: 'error', message: 'Delayed failure. Retry.' }); });
		await expect(safety(page)).toContainText('Delayed failure. Retry.');
		await safety(page).getByRole('button', { name: 'Cancel', exact: true }).click();
		await page.keyboard.press('Escape');
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: main');
		await expect(branchTrigger(page)).toBeEnabled();
		await expect(header(page).getByRole('button', { name: /^Switch project:/ })).toBeEnabled();
	});

	test('disables branch selection while a project picker mutation is pending', async ({ page }) => {
		await page.evaluate(async () => {
			await (window as any).setupTestGitRepo();
			(window as any).appState.workspace.storage.pickDirectory = async () => await new Promise(resolve => { (window as any).finishFolder = resolve; });
		});
		await header(page).getByRole('button', { name: /^Switch project:/ }).click();
		await page.locator('[data-slot="popover-content"][aria-label="Recent projects"]').getByRole('button', { name: 'Open Folder', exact: true }).click();
		await expect(branchTrigger(page)).toBeDisabled();
		await expect(header(page).getByRole('button', { name: /^Switch project:/ })).toBeDisabled();
		expect(await page.evaluate(async () => (await (window as any).appState.workspace.switchBranch('feature-branch')).status)).toBe('error');
		await page.evaluate(() => { (window as any).finishFolder(null); });
		await expect(branchTrigger(page)).toBeEnabled();
		await expect(branchTrigger(page)).toHaveAccessibleName('Switch branch: main');
	});

	test('combined pickers dismiss without orphaned popovers or lost keyboard focus', async ({ page }) => {
		await page.evaluate(async () => { await (window as any).setupTestGitRepo(); });
		const project = header(page).getByRole('button', { name: /^Switch project:/ });
		const hamburger = header(page).getByRole('button', { name: 'Application menu', exact: true });
		const projectPicker = page.locator('[data-slot="popover-content"][aria-label="Recent projects"]');
		await project.click();
		await branchTrigger(page).click();
		await expect(projectPicker).toBeHidden();
		await expect(branchPicker(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(branchPicker(page)).toBeHidden();
		await expect(branchTrigger(page)).toBeFocused();
		await branchTrigger(page).click();
		await project.click();
		await expect(branchPicker(page)).toBeHidden();
		await expect(projectPicker).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(project).toBeFocused();
		await branchTrigger(page).click();
		await page.locator('.cm-content').click();
		await expect(branchPicker(page)).toBeHidden();
		await expect(page.locator('.cm-content')).toBeFocused();
		for (const dismissal of ['Escape', 'F10', 'Tab', 'outside', 'category', 'command']) {
			await branchTrigger(page).click();
			await page.keyboard.press('F10');
			await expect(branchPicker(page)).toBeHidden();
			await expect(branchTrigger(page)).toBeHidden();
			await expect(project).toBeHidden();
			await page.getByRole('menuitem', { name: 'Edit', exact: true }).hover();
			await page.getByRole('menuitem', { name: 'File', exact: true }).hover();
			if (dismissal === 'outside') await page.locator('.cm-content').click();
			else if (dismissal === 'category') await page.getByRole('menuitem', { name: 'File', exact: true }).click();
			else if (dismissal === 'command') await page.getByRole('menu', { name: 'File', exact: true }).getByRole('menuitem', { name: /^New\b/ }).click();
			else await page.keyboard.press(dismissal);
			await expect(branchTrigger(page)).toBeVisible();
			await expect(project).toBeVisible();
			await expect(branchPicker(page)).toBeHidden();
			if (dismissal === 'Escape' || dismissal === 'F10') await expect(hamburger).toBeFocused();
		}
	});

	test('long names fit a single-row narrow header and both popovers stay in the viewport', async ({ page }) => {
		const name = 'a-very-long-project-name-that-must-remain-accessible';
		const branch = 'feature/a-very-long-branch-name-that-must-remain-accessible';
		await page.evaluate(async ({ name, branch }) => {
			await (window as any).setupTestGitRepo();
			const w = (window as any).appState.workspace;
			w.rootOrigin.name = name;
			await (window as any).git.branch({ fs: w.repository.adapter.fs, dir: '/repo', ref: branch, checkout: true });
			await w.repository.refresh();
		}, { name, branch });
		const height = (await header(page).boundingBox())!.height;
		for (const width of [380, 320]) {
			await page.setViewportSize({ width, height: 700 });
			expect((await header(page).boundingBox())!.height).toBe(height);
			const project = header(page).getByRole('button', { name: `Switch project: ${name}` });
			await expect(branchTrigger(page)).toHaveAccessibleName(`Switch branch: ${branch}`);
			await expect(branchTrigger(page)).toHaveAttribute('title', branch);
			for (const trigger of [project, branchTrigger(page)]) {
				const box = (await trigger.boundingBox())!;
				expect(box.width).toBeGreaterThan(30);
				expect(box.x + box.width).toBeLessThanOrEqual(width);
				await trigger.click();
				const popover = trigger === project ? page.locator('[data-slot="popover-content"][aria-label="Recent projects"]') : branchPicker(page);
				await expect(popover).toBeVisible();
				const popup = (await popover.boundingBox())!;
				expect(popup.x).toBeGreaterThanOrEqual(0);
				expect(popup.x + popup.width).toBeLessThanOrEqual(width);
				await page.keyboard.press('Escape');
				await expect(trigger).toBeFocused();
			}
			await page.keyboard.press('F10');
			for (const category of ['File', 'Edit', 'Format', 'View']) await expect(page.getByRole('menuitem', { name: category, exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
			expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
		}
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
			appState.workspace.updateDocumentContent(doc, 'unsaved editor changes');
			
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

		const branchButton = header(page).getByRole('button', { name: 'Switch branch: main', exact: true });
		await expect(branchButton).toBeVisible();
		await branchButton.click();

		// 3. Click the target branch in the command list dropdown
		const targetBranchOption = page.locator('[data-slot="popover-content"][aria-label="Branches"]').getByRole('option', { name: 'feature-branch', exact: true });
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
		const cancelButton = page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true });
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
