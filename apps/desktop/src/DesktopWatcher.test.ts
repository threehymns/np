import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DesktopWatcher, type WatcherEvent } from './DesktopWatcher';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('DesktopWatcher', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-test-desktop-watcher-'));
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it('notifies on external file creation', async () => {
		const received: WatcherEvent[][] = [];
		const watcher = new DesktopWatcher({
			dirPath: testDir,
			debounceMs: 20,
			onEvents: (events) => {
				received.push(events);
			}
		});

		await watcher.start();

		await fs.writeFile(path.join(testDir, 'created.txt'), 'hello');
		await new Promise((r) => setTimeout(r, 100));

		await watcher.close();

		expect(received.length).toBeGreaterThan(0);
		const allEvents = received.flat();
		const match = allEvents.find((e) => path.basename(e.path) === 'created.txt');
		expect(match).toBeDefined();
		expect(match?.type).toBe('create');
	});

	it('notifies on external file modification', async () => {
		const filePath = path.join(testDir, 'modified.txt');
		await fs.writeFile(filePath, 'initial');

		const received: WatcherEvent[][] = [];
		const watcher = new DesktopWatcher({
			dirPath: testDir,
			debounceMs: 20,
			onEvents: (events) => {
				received.push(events);
			}
		});

		await watcher.start();

		await fs.writeFile(filePath, 'updated content');
		await new Promise((r) => setTimeout(r, 100));

		await watcher.close();

		expect(received.length).toBeGreaterThan(0);
		const allEvents = received.flat();
		const match = allEvents.find((e) => path.basename(e.path) === 'modified.txt');
		expect(match).toBeDefined();
		expect(match?.type).toBe('update');
	});

	it('notifies on external file deletion', async () => {
		const filePath = path.join(testDir, 'deleted.txt');
		await fs.writeFile(filePath, 'to be deleted');

		const received: WatcherEvent[][] = [];
		const watcher = new DesktopWatcher({
			dirPath: testDir,
			debounceMs: 20,
			onEvents: (events) => {
				received.push(events);
			}
		});

		await watcher.start();

		await fs.unlink(filePath);
		await new Promise((r) => setTimeout(r, 100));

		await watcher.close();

		expect(received.length).toBeGreaterThan(0);
		const allEvents = received.flat();
		const match = allEvents.find((e) => path.basename(e.path) === 'deleted.txt');
		expect(match).toBeDefined();
		expect(match?.type).toBe('delete');
	});

	it('notifies on external file rename', async () => {
		const oldPath = path.join(testDir, 'before.txt');
		const newPath = path.join(testDir, 'after.txt');
		await fs.writeFile(oldPath, 'rename me');

		const received: WatcherEvent[][] = [];
		const watcher = new DesktopWatcher({
			dirPath: testDir,
			debounceMs: 20,
			onEvents: (events) => {
				received.push(events);
			}
		});

		await watcher.start();

		await fs.rename(oldPath, newPath);
		await new Promise((r) => setTimeout(r, 100));

		await watcher.close();

		expect(received.length).toBeGreaterThan(0);
		const allEvents = received.flat();
		const deleted = allEvents.find((e) => path.basename(e.path) === 'before.txt');
		const created = allEvents.find((e) => path.basename(e.path) === 'after.txt');
		expect(deleted).toBeDefined();
		expect(deleted?.type).toBe('delete');
		expect(created).toBeDefined();
		expect(created?.type).toBe('create');
	});

	it('debounces and coalesces save-storms into batched notifications', async () => {
		let callCount = 0;
		const received: WatcherEvent[][] = [];
		const watcher = new DesktopWatcher({
			dirPath: testDir,
			debounceMs: 50,
			onEvents: (events) => {
				callCount++;
				received.push(events);
			}
		});

		await watcher.start();

		// Rapidly write 20 files (save-storm)
		for (let i = 0; i < 20; i++) {
			await fs.writeFile(path.join(testDir, `storm-${i}.txt`), `storm ${i}`);
		}

		// Wait for debounce window to fire
		await new Promise((r) => setTimeout(r, 200));

		await watcher.close();

		// Must be coalesced into significantly fewer calls than the 20 writes
		expect(callCount).toBeLessThanOrEqual(3);
		const allEvents = received.flat();
		expect(allEvents.length).toBeGreaterThanOrEqual(20);
	});

	it('ignores node_modules and .git directories', async () => {
		const nodeModulesDir = path.join(testDir, 'node_modules');
		await fs.mkdir(nodeModulesDir);

		const received: WatcherEvent[][] = [];
		const watcher = new DesktopWatcher({
			dirPath: testDir,
			debounceMs: 20,
			onEvents: (events) => {
				received.push(events);
			}
		});

		await watcher.start();

		await fs.writeFile(path.join(nodeModulesDir, 'ignored.txt'), 'ignore me');
		await fs.writeFile(path.join(testDir, 'kept.txt'), 'keep me');
		await new Promise((r) => setTimeout(r, 100));

		await watcher.close();

		const allEvents = received.flat();
		const ignored = allEvents.find((e) => e.path.includes('node_modules'));
		const kept = allEvents.find((e) => path.basename(e.path) === 'kept.txt');
		expect(ignored).toBeUndefined();
		expect(kept).toBeDefined();
	});

	it('stops watching cleanly and does not deliver events after close()', async () => {
		const received: WatcherEvent[][] = [];
		const watcher = new DesktopWatcher({
			dirPath: testDir,
			debounceMs: 20,
			onEvents: (events) => {
				received.push(events);
			}
		});

		await watcher.start();
		await watcher.close();

		await fs.writeFile(path.join(testDir, 'after-close.txt'), 'hello');
		await new Promise((r) => setTimeout(r, 100));

		expect(received.length).toBe(0);
	});
});
