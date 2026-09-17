import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';

test.describe('Header project picker', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');
		await expect(page.locator('.cm-content').first()).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
		await page.waitForFunction(() => typeof (window as any).appState !== 'undefined' && typeof (window as any).browserHandleRegistry !== 'undefined');
		await page.evaluate(installMockFS);
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			appState.workspace.storage.verifyPermission = async () => true;
			appState.workspace.storage.pickDirectory = async () => null;
		});
	});

	async function registerProject(page: import('@playwright/test').Page, name: string, path = name) {
		await page.evaluate(async ({ name, path }) => {
			const appState = (window as any).appState;
			const folder = new (window as any).MockDirectoryHandle(name);
			await (window as any).browserHandleRegistry.register(`browser://${path}`, folder);
		}, { name, path });
	}

	async function registerGitProject(page: import('@playwright/test').Page, name: string, path = name) {
		await page.evaluate(async ({ name, path }) => {
			const appState = (window as any).appState;
			const git = (window as any).git;
			const RepositoryClass = (window as any).Repository;
			const root = new (window as any).MockDirectoryHandle(name);
			await (window as any).browserHandleRegistry.register(`browser://${path}`, root);
			const origin = { scheme: 'browser', path, name };
			const repository = new RepositoryClass(origin, appState.workspace.vcsFactory);
			await root.getDirectoryHandle('.git', { create: true });
			await repository.refresh();
			const gitFs = (repository.adapter as any).fs;
			await git.init({ fs: gitFs, dir: '/repo', defaultBranch: 'main' });
			await gitFs.promises.writeFile('/repo/README.md', 'Hello World');
			await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
			await git.commit({
				fs: gitFs,
				dir: '/repo',
				message: 'Initial commit',
				author: { name: 'Test User', email: 'test@example.com' }
			});
		}, { name, path });
	}

	async function openProject(page: import('@playwright/test').Page, path: string, name = path) {
		await page.evaluate(async ({ path, name }) => {
			const appState = (window as any).appState;
			await appState.workspace.openDirectory({ scheme: 'browser', path, name });
		}, { path, name });
	}

	async function pickRecent(page: import('@playwright/test').Page, current: string, target: string) {
		await triggerFor(page, current).click();
		await page.getByPlaceholder('Search recent projects').fill(target);
		await page.keyboard.press('Enter');
	}

	const header = (page: import('@playwright/test').Page) => page.getByRole('banner', { name: 'Workspace' });
	const triggerFor = (page: import('@playwright/test').Page, name: string) =>
		header(page).getByRole('button', { name: `Switch project: ${name}` });

	test('shows Open Folder with no project and opens a project through the picker', async ({ page }) => {
		const noRoot = header(page).getByRole('button', { name: 'Open Folder' });
		await expect(noRoot).toBeVisible();

		await registerProject(page, 'project-b');
		await page.evaluate(() => {
			const appState = (window as any).appState;
			appState.workspace.storage.pickDirectory = async () => ({ scheme: 'browser', path: 'project-b', name: 'project-b' });
		});
		await noRoot.click();
		const trigger = triggerFor(page, 'project-b');
		await expect(trigger).toBeVisible();

		await trigger.click();
		const search = page.getByPlaceholder('Search recent projects');
		await expect(search).toBeVisible();
		await expect(search).toBeFocused();
		await expect(header(page).getByText('project-b', { exact: true })).toBeVisible();
		await expect(page.getByText('Current', { exact: true })).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(search).toBeHidden();
		await expect(trigger).toBeVisible();
	});

	test('searches recents by name and path and distinguishes duplicate basenames', async ({ page }) => {
		await registerProject(page, 'np', 'projects/np');
		await registerProject(page, 'np', 'elsewhere/np');
		await openProject(page, 'projects/np', 'np');
		await openProject(page, 'elsewhere/np', 'np');
		await expect(header(page).getByRole('button', { name: 'Switch project: np' })).toBeVisible();

		await triggerFor(page, 'np').click();
		const search = page.getByPlaceholder('Search recent projects');
		await expect(search).toBeVisible();
		await expect(page.getByText('browser://elsewhere/np')).toBeVisible();
		await expect(page.getByText('browser://projects/np')).toBeVisible();
		await expect(page.getByText('Current', { exact: true })).toBeVisible();

		await search.fill('elsewhere');
		await expect(page.getByText('browser://elsewhere/np')).toBeVisible();
		await expect(page.getByText('browser://projects/np')).toBeHidden();

		await search.fill('');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(header(page).getByRole('button', { name: 'Switch project: np' })).toBeVisible();
		await expect.poll(() =>
			page.evaluate(() => (window as any).appState.workspace.rootOrigin.path)
		).toBe('projects/np');
	});

	test('cancelled picker and denied permission leave the session intact', async ({ page }) => {
		await registerProject(page, 'project-a');
		await openProject(page, 'project-a');
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			const doc = appState.workspace.documents[0];
			appState.workspace.updateDocumentContent(doc, 'Unsaved keep');
			appState.workspace.storage.pickDirectory = async () => null;
		});

		await triggerFor(page, 'project-a').click();
		await page.getByRole('button', { name: 'Open Folder' }).last().click();
		await expect(triggerFor(page, 'project-a')).toBeVisible();
		await expect(page.locator('.cm-content').first()).toContainText('Unsaved keep');
		await expect(page.getByRole('alert')).toHaveCount(0);

		await page.evaluate(() => {
			const appState = (window as any).appState;
			appState.workspace.storage.verifyPermission = async () => false;
			appState.workspace.storage.pickDirectory = async () => ({ scheme: 'browser', path: 'project-b', name: 'project-b' });
		});
		await triggerFor(page, 'project-a').click();
		await page.getByRole('button', { name: 'Open Folder' }).last().click();
		await expect(page.getByRole('alert')).toContainText('Permission denied');
		await expect(triggerFor(page, 'project-a')).toBeVisible();
		await expect(page.locator('.cm-content').first()).toContainText('Unsaved keep');
	});

	test('failed opening surfaces an alert and clears loading', async ({ page }) => {
		await registerProject(page, 'project-a');
		await openProject(page, 'project-a');
		await page.evaluate(() => {
			const appState = (window as any).appState;
			const realLoad = appState.workspace.persistence.loadOpenFiles.bind(appState.workspace.persistence);
			appState.workspace.persistence.loadOpenFiles = async (uri: string) => {
				if (uri === 'browser://project-b') throw new Error('disk smoke');
				return await realLoad(uri);
			};
			appState.workspace.storage.pickDirectory = async () => ({ scheme: 'browser', path: 'project-b', name: 'project-b' });
		});

		await triggerFor(page, 'project-a').click();
		await page.getByRole('button', { name: 'Open Folder' }).last().click();
		await expect(page.getByRole('alert')).toContainText('Failed to open folder: disk smoke');
		await expect(triggerFor(page, 'project-a')).toBeVisible();
		const state = await page.evaluate(() => ({
			opening: (window as any).appState.workspace.projectOpening,
			root: (window as any).appState.workspace.rootOrigin.path
		}));
		expect(state.opening).toBe(false);
		expect(state.root).toBe('project-a');
	});

	test('works with the sidebar hidden and with Source Control active', async ({ page }) => {
		await registerProject(page, 'project-a');
		await registerProject(page, 'project-b');
		await openProject(page, 'project-a');
		await openProject(page, 'project-b');

		await page.evaluate(() => { (window as any).appState.prefs.sidebarVisible = false; });
		await expect(page.locator('aside')).toBeHidden();

		await pickRecent(page, 'project-b', 'project-a');
		await expect(triggerFor(page, 'project-a')).toBeVisible();

		await page.evaluate(() => {
			const a = (window as any).appState;
			a.activeSidebarTab = 'git';
			a.prefs.sidebarVisible = true;
		});
		await expect(page.locator('aside')).toContainText('No Git Repository');
		await pickRecent(page, 'project-a', 'project-b');
		await expect(triggerFor(page, 'project-b')).toBeVisible();
		await expect(page.locator('aside')).toContainText('No Git Repository');
	});

	test('hides while the application menu is open and restores after dismissal', async ({ page }) => {
		await registerProject(page, 'project-a');
		await openProject(page, 'project-a');

		const hamburger = page.getByRole('button', { name: 'Application menu', exact: true });
		await hamburger.click();
		await expect(header(page).getByRole('button', { name: 'Switch project: project-a' })).toBeHidden();
		await expect(header(page).getByRole('button', { name: 'Open Folder' })).toHaveCount(0);

		await page.keyboard.press('Escape');
		await expect(header(page).getByRole('button', { name: 'Switch project: project-a' })).toBeVisible();
		await expect(hamburger).toBeVisible();

		await hamburger.click();
		await expect(header(page).getByRole('button', { name: 'Switch project: project-a' })).toBeHidden();
		await page.getByRole('menuitem', { name: 'File', exact: true }).click();
		await expect(header(page).getByRole('button', { name: 'Switch project: project-a' })).toBeVisible();

		await hamburger.click();
		await page.mouse.click(640, 400);
		await expect(header(page).getByRole('button', { name: 'Switch project: project-a' })).toBeVisible();
	});

	test('header height stays stable and controls truncate at narrow widths', async ({ page }) => {
		await registerProject(page, 'project-a');
		await openProject(page, 'project-a');

		await page.setViewportSize({ width: 1024, height: 700 });
		const heightBefore = (await header(page).boundingBox())!.height;
		await page.setViewportSize({ width: 380, height: 700 });
		const heightAfter = (await header(page).boundingBox())!.height;
		expect(heightAfter).toBe(heightBefore);

		const trigger = triggerFor(page, 'project-a');
		await expect(trigger).toBeVisible();
		const box = (await trigger.boundingBox())!;
		expect(box.width).toBeLessThan(370);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
		expect(overflow).toBe(false);

		await trigger.click();
		const content = page.getByRole('dialog').filter({ hasText: 'Search recent projects' }).or(page.locator('[data-slot="popover-content"]')).first();
		await expect(content).toBeVisible();
		const contentBox = (await content.boundingBox())!;
		expect(contentBox.x).toBeGreaterThanOrEqual(0);
	});

	test('restores tabs and drafts after switching and switching back', async ({ page }) => {
		await registerProject(page, 'project-a');
		await registerProject(page, 'project-b');
		await openProject(page, 'project-a');
		await openProject(page, 'project-b');
		await openProject(page, 'project-a');
		await page.evaluate(async () => {
			const appState = (window as any).appState;
			const docA = await appState.workspace.newFile();
			appState.workspace.updateDocumentContent(docA, 'Draft for project A');
			await appState.workspace.flushSaveOpenFiles();
		});

		await pickRecent(page, 'project-a', 'project-b');
		await expect(triggerFor(page, 'project-b')).toBeVisible();
		await expect(page.locator('.cm-content').first()).not.toContainText('Draft for project A');

		await pickRecent(page, 'project-b', 'project-a');
		await expect(triggerFor(page, 'project-a')).toBeVisible();
		await expect(page.locator('.cm-content').first()).toContainText('Draft for project A');
	});

	test('per-project commit drafts do not cross projects', async ({ page }) => {
		await registerGitProject(page, 'project-a');
		await registerGitProject(page, 'project-b');
		await openProject(page, 'project-a');
		await openProject(page, 'project-b');
		await openProject(page, 'project-a');
		await page.evaluate(() => { (window as any).appState.activeSidebarTab = 'git'; });

		const textarea = page.locator('aside textarea').first();
		await expect(textarea).toBeVisible();
		await textarea.fill('Draft for A only');
		await page.locator('aside textarea').first().blur();

		await pickRecent(page, 'project-a', 'project-b');
		await expect(triggerFor(page, 'project-b')).toBeVisible();
		await expect(page.locator('aside textarea').first()).toHaveValue('');

		await pickRecent(page, 'project-b', 'project-a');
		await expect(triggerFor(page, 'project-a')).toBeVisible();
		await expect(page.locator('aside textarea').first()).toHaveValue('Draft for A only');
	});
});
