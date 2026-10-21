import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock, beforeAll } from 'bun:test';
import { DesktopWatcherSnapshotStrategy } from './DesktopWatcherSnapshotStrategy';
import type { FileOrigin } from '@np/core/storage';

let WorktreeClass: typeof import('@np/core').Worktree;

beforeAll(async () => {
	const core = await import('@np/core');
	WorktreeClass = core.Worktree;
});

function createMockStorage(files: Record<string, string> = {}) {
	return {
		readFile: mock(async (origin: FileOrigin) => {
			if (origin.path in files) return files[origin.path];
			throw { name: 'NotFoundError' };
		}),
		readDirectory: mock(async (origin: FileOrigin) => {
			const prefix = origin.path;
			const dirEntries: any[] = [];
			const seen = new Set<string>();

			for (const p of Object.keys(files)) {
				if (p.startsWith(prefix + '/')) {
					const rest = p.slice(prefix.length + 1);
					const parts = rest.split('/');
					const name = parts[0];
					if (!seen.has(name)) {
						seen.add(name);
						const isDir = parts.length > 1;
						dirEntries.push({
							name,
							kind: isDir ? 'directory' : 'file',
							origin: { scheme: 'file', path: `${prefix}/${name}`, name }
						});
					}
				}
			}
			return dirEntries;
		}),
		createFile: mock(async () => {}),
		createDirectory: mock(async () => {}),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (o: FileOrigin) => o)
	};
}

describe('DesktopWatcherSnapshotStrategy', () => {
	const rootOrigin: FileOrigin = {
		scheme: 'file',
		path: '/test-project',
		name: 'test-project'
	};

	it('has strategy name desktop-watcher', () => {
		const strategy = new DesktopWatcherSnapshotStrategy();
		expect(strategy.name).toBe('desktop-watcher');
	});

	it('subscribes watcher client on start and unsubscribes on stop', async () => {
		let unsubscribed = false;
		let watchedPath = '';
		let eventCallback: any = null;

		const mockClient = mock((dirPath: string, cb: any) => {
			watchedPath = dirPath;
			eventCallback = cb;
			return () => {
				unsubscribed = true;
			};
		});

		const strategy = new DesktopWatcherSnapshotStrategy({
			watcherClient: mockClient
		});

		const storage = createMockStorage();
		const wt = new WorktreeClass(rootOrigin, { storage, strategy });
		// The Project starts the strategy when it sets the project root.
		strategy.start(wt);

		expect(mockClient).toHaveBeenCalled();
		expect(watchedPath).toBe('/test-project');
		expect(typeof eventCallback).toBe('function');

		wt.dispose();
		expect(unsubscribed).toBe(true);
	});

	it('updates worktree snapshot when external file events arrive', async () => {
		let emitEvents: (events: any[]) => void = () => {};
		const mockClient = mock((_dirPath: string, cb: any) => {
			emitEvents = cb;
			return () => {};
		});

		const files: Record<string, string> = {
			'/test-project/initial.txt': 'initial'
		};
		const storage = createMockStorage(files);

		const strategy = new DesktopWatcherSnapshotStrategy({
			watcherClient: mockClient,
			debounceMs: 10
		});

		const wt = new WorktreeClass(rootOrigin, { storage, strategy });
		strategy.start(wt);
		await wt.scan();

		expect(wt.entries.length).toBe(1);
		expect(wt.entries[0].name).toBe('initial.txt');
		const initialVersion = wt.version;

		// Simulate external file creation: add to storage and emit event
		files['/test-project/external.txt'] = 'new file';
		emitEvents([{ path: '/test-project/external.txt', type: 'create' }]);

		// Wait for debounce + scan
		await new Promise((r) => setTimeout(r, 60));

		expect(wt.version).toBeGreaterThan(initialVersion);
		expect(wt.entries.length).toBe(2);
		const names = wt.entries.map((e) => e.name);
		expect(names).toContain('initial.txt');
		expect(names).toContain('external.txt');

		wt.dispose();
	});

	it('coalesces save-storm events into a single scan', async () => {
		let emitEvents: (events: any[]) => void = () => {};
		const mockClient = mock((_dirPath: string, cb: any) => {
			emitEvents = cb;
			return () => {};
		});

		const files: Record<string, string> = {};
		const storage = createMockStorage(files);

		const strategy = new DesktopWatcherSnapshotStrategy({
			watcherClient: mockClient,
			debounceMs: 30
		});

		const wt = new WorktreeClass(rootOrigin, { storage, strategy });
		strategy.start(wt);
		let scanCount = 0;
		const originalScan = wt.scan.bind(wt);
		wt.scan = async (...args) => {
			scanCount++;
			return originalScan(...args);
		};

		// Initial scan
		await wt.scan();
		expect(scanCount).toBe(1);

		// Fire 10 rapid events simulating a save-storm
		for (let i = 0; i < 10; i++) {
			files[`/test-project/file-${i}.txt`] = `${i}`;
			emitEvents([{ path: `/test-project/file-${i}.txt`, type: 'create' }]);
		}

		await new Promise((r) => setTimeout(r, 100));

		// Scan count should only increment by 1 for the entire debounced batch
		expect(scanCount).toBe(2);
		expect(wt.entries.length).toBe(10);

		wt.dispose();
	});

	it('schedules a follow-up scan if events arrive while a scan is in-flight', async () => {
		let emitEvents: (events: any[]) => void = () => {};
		const mockClient = mock((_dirPath: string, cb: any) => {
			emitEvents = cb;
			return () => {};
		});

		const files: Record<string, string> = {
			'/test-project/a.txt': 'a'
		};
		const storage = createMockStorage(files);

		const strategy = new DesktopWatcherSnapshotStrategy({
			watcherClient: mockClient,
			debounceMs: 10
		});

		const wt = new WorktreeClass(rootOrigin, { storage, strategy });
		strategy.start(wt);

		// Make scan take time
		let slowScan = true;
		const originalScan = wt.scan.bind(wt);
		let scansDone = 0;
		wt.scan = async (...args) => {
			if (slowScan) {
				await new Promise((r) => setTimeout(r, 40));
			}
			scansDone++;
			return originalScan(...args);
		};

		await wt.scan(); // Initial scan
		expect(scansDone).toBe(1);

		// Trigger first external change
		files['/test-project/b.txt'] = 'b';
		emitEvents([{ path: '/test-project/b.txt', type: 'create' }]);

		// Wait for debounce to start scan
		await new Promise((r) => setTimeout(r, 15));

		// While first scan is in flight, fire another event
		files['/test-project/c.txt'] = 'c';
		emitEvents([{ path: '/test-project/c.txt', type: 'create' }]);

		slowScan = false;
		await new Promise((r) => setTimeout(r, 100));

		// Follow-up scan must have occurred, discovering c.txt
		expect(scansDone).toBe(3); // initial + change 1 + follow-up
		const names = wt.entries.map((e) => e.name);
		expect(names).toContain('a.txt');
		expect(names).toContain('b.txt');
		expect(names).toContain('c.txt');

		wt.dispose();
	});

	it('delegates manual refresh() to worktree.scan()', async () => {
		const storage = createMockStorage({
			'/test-project/hello.txt': 'world'
		});
		const strategy = new DesktopWatcherSnapshotStrategy({
			watcherClient: () => () => {}
		});
		const wt = new WorktreeClass(rootOrigin, { storage, strategy });

		await strategy.refresh(wt);
		expect(wt.entries.length).toBe(1);
		expect(wt.entries[0].name).toBe('hello.txt');

		wt.dispose();
	});
});
