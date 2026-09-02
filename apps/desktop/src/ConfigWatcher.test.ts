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
	});
});
