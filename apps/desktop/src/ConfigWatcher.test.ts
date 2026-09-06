import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ConfigWatcher } from './ConfigWatcher';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('ConfigWatcher', () => {
	let testDir: string;
	let configPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-test-config-watcher-'));
		configPath = path.join(testDir, 'config.json');
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it('triggers onConfigChanged when config.json is modified externally with valid JSONC', async () => {
		await fs.writeFile(configPath, '{\n  "zoom": 100\n}', 'utf-8');

		let receivedContent: string | null = null;
		const watcher = new ConfigWatcher({
			configPath,
			debounceMs: 20,
			onConfigChanged: (content) => {
				receivedContent = content;
			}
		});

		watcher.start();

		// Update file externally
		await fs.writeFile(configPath, '{\n  // comment\n  "zoom": 125\n}', 'utf-8');

		// Wait for debounce + processing
		await new Promise((r) => setTimeout(r, 100));

		watcher.close();

		expect(receivedContent).not.toBeNull();
		expect(receivedContent).toContain('"zoom": 125');
		expect(receivedContent).toContain('// comment');
	});

	it('ignores external update if JSONC contains syntax errors and does not broadcast', async () => {
		await fs.writeFile(configPath, '{\n  "zoom": 100\n}', 'utf-8');

		let called = false;
		const watcher = new ConfigWatcher({
			configPath,
			debounceMs: 20,
			onConfigChanged: () => {
				called = true;
			}
		});

		watcher.start();

		// Write invalid JSONC
		await fs.writeFile(configPath, '{\n  "zoom": 125,\n  invalid_syntax\n}', 'utf-8');

		await new Promise((r) => setTimeout(r, 100));

		watcher.close();

		expect(called).toBe(false);
	});

	it('ignores modifications to unrelated files and directories in the watched folder', async () => {
		await fs.writeFile(configPath, '{\n  "zoom": 100\n}', 'utf-8');

		let called = false;
		const watcher = new ConfigWatcher({
			configPath,
			debounceMs: 20,
			onConfigChanged: () => {
				called = true;
			}
		});

		watcher.start();

		// Create and modify unrelated files and subdirectories
		const stateDir = path.join(testDir, 'state');
		await fs.mkdir(stateDir, { recursive: true });
		await fs.writeFile(path.join(stateDir, 'workspace-session.json'), '{"tabs":[]}', 'utf-8');

		const gpuCacheDir = path.join(testDir, 'GPUCache');
		await fs.mkdir(gpuCacheDir, { recursive: true });
		await fs.writeFile(path.join(gpuCacheDir, 'data_0'), 'binary-cache-data', 'utf-8');

		await fs.writeFile(path.join(testDir, 'unrelated.txt'), 'hello world', 'utf-8');

		// Wait for potential watcher events to settle
		await new Promise((r) => setTimeout(r, 100));

		watcher.close();

		expect(called).toBe(false);
	});

	it('discards watch events when filename is null, empty, or mismatched', async () => {
		let watchCallback: ((eventType: string, filename: string | null) => void) | null = null;
		const originalWatch = (await import('fs')).default.watch;

		let handleFileChangeCalled = false;
		const watcher = new ConfigWatcher({
			configPath,
			debounceMs: 20,
			onConfigChanged: () => {}
		});

		// Spy on handleFileChange
		const originalHandle = watcher.handleFileChange.bind(watcher);
		watcher.handleFileChange = () => {
			handleFileChangeCalled = true;
			originalHandle();
		};

		// Start with an intercepted watcher callback to verify precision event filtering directly
		const fsSync = await import('fs');
		const watchSpy = mock((dir: any, cb: any) => {
			watchCallback = cb;
			return { close: () => {} } as any;
		});
		const realWatch = fsSync.default.watch;
		(fsSync.default as any).watch = watchSpy;

		try {
			watcher.start();
			expect(watchCallback).not.toBeNull();

			// Null filename
			handleFileChangeCalled = false;
			watchCallback!('change', null);
			expect(handleFileChangeCalled).toBe(false);

			// Empty string filename
			handleFileChangeCalled = false;
			watchCallback!('change', '');
			expect(handleFileChangeCalled).toBe(false);

			// Unrelated filename
			handleFileChangeCalled = false;
			watchCallback!('change', 'workspace-session.json');
			expect(handleFileChangeCalled).toBe(false);

			handleFileChangeCalled = false;
			watchCallback!('change', 'GPUCache');
			expect(handleFileChangeCalled).toBe(false);

			// Target filename
			handleFileChangeCalled = false;
			watchCallback!('change', 'config.json');
			expect(handleFileChangeCalled).toBe(true);
		} finally {
			(fsSync.default as any).watch = realWatch;
			watcher.close();
		}
	});

	it('debounces rapid successive file changes into a single broadcast', async () => {
		await fs.writeFile(configPath, '{\n  "zoom": 100\n}', 'utf-8');

		const broadcasts: string[] = [];
		const watcher = new ConfigWatcher({
			configPath,
			debounceMs: 50,
			onConfigChanged: (content) => {
				broadcasts.push(content);
			}
		});

		watcher.start();

		// Rapid writes
		await fs.writeFile(configPath, '{\n  "zoom": 110\n}', 'utf-8');
		await new Promise((r) => setTimeout(r, 10));
		await fs.writeFile(configPath, '{\n  "zoom": 120\n}', 'utf-8');
		await new Promise((r) => setTimeout(r, 10));
		await fs.writeFile(configPath, '{\n  "zoom": 130\n}', 'utf-8');

		await new Promise((r) => setTimeout(r, 150));

		watcher.close();

		expect(broadcasts.length).toBe(1);
		expect(broadcasts[0]).toContain('"zoom": 130');
	});

	it('prevents circular loop when content matches lastWrittenContent (programmatic write)', async () => {
		await fs.writeFile(configPath, '{\n  "zoom": 100\n}', 'utf-8');

		let broadcastCount = 0;
		const watcher = new ConfigWatcher({
			configPath,
			debounceMs: 20,
			onConfigChanged: () => {
				broadcastCount++;
			}
		});

		watcher.start();

		const contentToWrite = '{\n  "zoom": 110\n}';
		// Inform watcher of programmatic write
		watcher.setLastWrittenContent(contentToWrite);
		await fs.writeFile(configPath, contentToWrite, 'utf-8');

		await new Promise((r) => setTimeout(r, 100));

		watcher.close();

		// Should NOT have broadcasted because it was np writing to config.json
		expect(broadcastCount).toBe(0);
	});

	it('clears lastWrittenContent when clearLastWrittenIfMatches is called with matching content', async () => {
		await fs.writeFile(configPath, '{\n  "zoom": 100\n}', 'utf-8');

		let receivedContent: string | null = null;
		const watcher = new ConfigWatcher({
			configPath,
			debounceMs: 20,
			onConfigChanged: (content) => {
				receivedContent = content;
			}
		});

		watcher.start();

		const contentToWrite = '{\n  "zoom": 115\n}';
		watcher.setLastWrittenContent(contentToWrite);
		// Simulate failed write where we clear the marker
		watcher.clearLastWrittenIfMatches(contentToWrite);

		// Now write the file (e.g. external or retry)
		await fs.writeFile(configPath, contentToWrite, 'utf-8');

		await new Promise((r) => setTimeout(r, 100));

		watcher.close();

		// Since marker was cleared, change should be broadcasted
		expect(receivedContent).not.toBeNull();
		expect(receivedContent).toContain('"zoom": 115');
	});

	it('discards stale content from an older read when a newer change supersedes it', async () => {
		// Prepare initial file using the untouched fs/promises binding.
		await fs.writeFile(configPath, '{\n  "zoom": 100\n}', 'utf-8');

		type Resolver = (content: string) => void;
		const pendingReads: Resolver[] = [];
		const readFileMock = mock((_path: unknown, _enc: unknown) => {
			return new Promise<string>((resolve) => pendingReads.push(resolve));
		});

		// Replace readFile with a controllable promise, preserving the rest of fs/promises.
		mock.module('fs/promises', () => ({ default: { ...fs, readFile: readFileMock } }));

		try {
			const broadcast: string[] = [];
			const watcher = new ConfigWatcher({
				configPath,
				debounceMs: 20,
				onConfigChanged: (content) => broadcast.push(content)
			});

			// Overlapping reloads: the first (older) read completes after the second starts.
			const older = watcher.processChange();
			const newer = watcher.processChange();

			pendingReads[0]('{\n  "zoom": 125\n}');
			pendingReads[1]('{\n  "zoom": 150\n}');

			await Promise.all([older, newer]);

			// Only the latest content may be broadcast; stale content is discarded.
			expect(broadcast).toEqual(['{\n  "zoom": 150\n}']);
		} finally {
			// mock.module() overrides persist past mock.restore() in Bun, so
			// explicitly re-register the real fs/promises to prevent later tests
			// (and afterEach cleanup) from hanging on the controllable mock.
			mock.module('fs/promises', () => ({
				default: {
					writeFile: fs.writeFile,
					readFile: fs.readFile,
					mkdtemp: fs.mkdtemp,
					rm: fs.rm
				}
			}));
			mock.restore();
		}
	});
});
