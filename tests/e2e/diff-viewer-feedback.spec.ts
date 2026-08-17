import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';

test.describe('DiffViewer CodeMirror Instances Loading Loop', () => {
	test.beforeEach(async ({ page }) => {
		await mockIconThemes(page);
		await page.goto('/');

		// Inject mock repo setup
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
					return entry as MockFileHandle;
				}
				async *keys() { for (const k of this.entriesMap.keys()) yield k; }
				async *values() { for (const v of this.entriesMap.values()) yield v; }
				async *entries() { for (const entry of this.entriesMap.entries()) yield entry; }
				async removeEntry(name: string) {
					this.entriesMap.delete(name);
				}
				async resolve(): Promise<string[] | null> { return []; }
				async queryPermission() { return 'granted' as const; }
			}

			(window as any).setupDiffTestRepo = async () => {
				const appState = (window as any).appState;
				const git = (window as any).git;
				const RepositoryClass = (window as any).Repository;

				const root = new MockDirectoryHandle('diff-test-project');
				const origin = { scheme: 'browser', path: root.name, name: root.name };
				await (window as any).browserHandleRegistry.register(`browser://${root.name}`, root);
				const repository = new RepositoryClass(origin, appState.workspace.vcsFactory);
				const adapter = repository.adapter;

				await root.getDirectoryHandle('.git', { create: true });
				await repository.refresh();
				const gitFs = (adapter as any).fs;

				await git.init({ fs: gitFs, dir: '/repo', defaultBranch: 'main' });
				await gitFs.promises.writeFile('/repo/README.md', 'Line 1\nLine 2\nLine 3\n');
				await gitFs.promises.writeFile('/repo/hello.ts', 'const a = 1;\nconst b = 2;\n');
				await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
				await git.add({ fs: gitFs, dir: '/repo', filepath: 'hello.ts' });
				await git.commit({
					fs: gitFs,
					dir: '/repo',
					message: 'Initial commit',
					author: { name: 'Test User', email: 'test@example.com' }
				});

				// Modify files to generate diffs
				await gitFs.promises.writeFile('/repo/README.md', 'Line 1\nLine 2 modified\nLine 3\nLine 4 added\n');
				await gitFs.promises.writeFile('/repo/hello.ts', 'const a = 100;\nconst b = 2;\n');

				await repository.refresh();

				appState.workspace.rootOrigin = origin;
				appState.workspace.rootHandle = root;
				appState.workspace.hasRootPermission = true;
				appState.workspace.repository = repository;

				return { repository, changes: repository.changes };
			};
		});
	});

	test('CodeMirror diff viewer instances should mount and load when opening diff tab', async ({ page }) => {
		// Wait for app to be ready
		await page.waitForFunction(() => (window as any).appState !== undefined);

		// Initialize repo with modified files
		const setupResult = await page.evaluate(async () => {
			return await (window as any).setupDiffTestRepo();
		});

		expect(setupResult.changes.length).toBeGreaterThan(0);

		// Open uncommitted changes diff tab
		await page.evaluate(() => {
			const appState = (window as any).appState;
			appState.commands.execute('git.openDiff');
		});

		// Verify diff tab is active
		await expect(page.locator('button[role="tab"]:has-text("Uncommitted Changes")')).toBeVisible({ timeout: 5000 });

		// Verify file diff containers exist
		const fileHeaders = page.locator('[id^="diff-header-"]');
		await expect(fileHeaders.first()).toBeVisible({ timeout: 5000 });
		const count = await fileHeaders.count();
		expect(count).toBe(2);

		// Verify CodeMirror instances (.cm-editor) are loaded and visible for expanded files
		const cmEditors = page.locator('.cm-editor');
		const cmCount = await cmEditors.count();
		expect(cmCount).toBeGreaterThan(0);
	});

	test('loads diffs on demand: collapsed files skip loading until expanded', async ({ page }) => {
		await page.waitForFunction(() => (window as any).appState !== undefined);

		await page.evaluate(async () => {
			await (window as any).setupDiffTestRepo();
			const adapter = (window as any).appState.workspace.repository.adapter;
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

		await expect(page.locator('button[role="tab"]:has-text("Uncommitted Changes")')).toBeVisible({ timeout: 5000 });
		const fileHeaders = page.locator('[id^="diff-header-"]');
		await expect(fileHeaders.first()).toBeVisible({ timeout: 5000 });
		await expect(fileHeaders).toHaveCount(2);

		// Only the active (expanded) file should have triggered a diff load
		await page.waitForFunction(() => (window as any).__getFileDiffCalls === 1, undefined, { timeout: 5000 });
		// One expanded file in split view mounts two CodeMirror editors
		await expect(page.locator('.cm-editor')).toHaveCount(2);

		// Expanding the collapsed file triggers a second on-demand load
		await fileHeaders.nth(1).locator('button[title="Expand"]').click();
		await page.waitForFunction(() => (window as any).__getFileDiffCalls === 2, undefined, { timeout: 5000 });
		await expect(page.locator('.cm-editor')).toHaveCount(4);

		// Collapsing it again unmounts editors without triggering another load
		await fileHeaders.nth(1).locator('button[title="Collapse"]').click();
		await expect(page.locator('.cm-editor')).toHaveCount(2);
		expect(await page.evaluate(() => (window as any).__getFileDiffCalls)).toBe(2);

		// Re-expanding reuses the cached diff (no extra adapter call)
		await fileHeaders.nth(1).locator('button[title="Expand"]').click();
		await expect(page.locator('.cm-editor')).toHaveCount(4);
		expect(await page.evaluate(() => (window as any).__getFileDiffCalls)).toBe(2);
	});
});
