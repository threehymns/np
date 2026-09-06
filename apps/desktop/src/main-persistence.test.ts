import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionPersistenceEngine } from './SessionPersistenceEngine';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

describe('SessionPersistenceEngine (Main Process Persistence)', () => {
	let testDir: string;
	let sessionFilePath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'np-test-session-persistence-'));
		sessionFilePath = path.join(testDir, 'state', 'workspace-session.json');
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it('updates in-memory cache synchronously and immediately on rapid sequential saves', async () => {
		const engine = new SessionPersistenceEngine({
			getFilePath: () => sessionFilePath,
			debounceMs: 200
		});

		// First save loads initial state (empty) then sets key
		await engine.save('key1', 'value1');
		expect(engine.getInMemoryCache()).toEqual({ key1: 'value1' });

		// Subsequent saves update cache synchronously in-memory
		const p2 = engine.save('key2', 'value2');
		const p3 = engine.save('key3', { nested: true });

		// In-memory cache is immediately reflecting updates
		expect(engine.getInMemoryCache()).toEqual({
			key1: 'value1',
			key2: 'value2',
			key3: { nested: true }
		});

		await Promise.all([p2, p3]);

		// Load reads from in-memory cache
		expect(await engine.load('key1')).toBe('value1');
		expect(await engine.load('key2')).toBe('value2');
		expect(await engine.load('key3')).toEqual({ nested: true });
		expect(await engine.load('nonexistent')).toBeNull();

		// Disk file should NOT exist yet because debounce is 200ms
		expect(fsSync.existsSync(sessionFilePath)).toBe(false);
	});

	it('debounces background disk writes to the configured interval', async () => {
		const engine = new SessionPersistenceEngine({
			getFilePath: () => sessionFilePath,
			debounceMs: 50
		});

		await engine.save('step', 1);
		expect(fsSync.existsSync(sessionFilePath)).toBe(false);
		expect(engine.hasPendingWrite()).toBe(true);

		// Rapid saves before debounce timer fires
		await new Promise((r) => setTimeout(r, 20));
		await engine.save('step', 2);
		expect(fsSync.existsSync(sessionFilePath)).toBe(false);

		await new Promise((r) => setTimeout(r, 20));
		await engine.save('step', 3);
		expect(fsSync.existsSync(sessionFilePath)).toBe(false);

		// Wait for the final debounce window to elapse
		await new Promise((r) => setTimeout(r, 80));

		// Now the file should be written to disk with the final state
		expect(fsSync.existsSync(sessionFilePath)).toBe(true);
		const content = JSON.parse(await fs.readFile(sessionFilePath, 'utf-8'));
		expect(content).toEqual({ step: 3 });
		expect(engine.hasPendingWrite()).toBe(false);
		expect(engine.isDirtyState()).toBe(false);
	});

	it('flushSync immediately writes dirty in-memory data to disk and cancels active debounce timer', async () => {
		const engine = new SessionPersistenceEngine({
			getFilePath: () => sessionFilePath,
			debounceMs: 500
		});

		await engine.save('draft', { id: 'doc-1', title: 'Untitled', content: 'Unsaved draft text' });
		expect(engine.hasPendingWrite()).toBe(true);
		expect(fsSync.existsSync(sessionFilePath)).toBe(false);

		// Synchronous flush (simulating app before-quit event)
		engine.flushSync();

		// Timer cancelled and dirty flag cleared
		expect(engine.hasPendingWrite()).toBe(false);
		expect(engine.isDirtyState()).toBe(false);
		expect(fsSync.existsSync(sessionFilePath)).toBe(true);

		const written = JSON.parse(fsSync.readFileSync(sessionFilePath, 'utf-8'));
		expect(written).toEqual({
			draft: { id: 'doc-1', title: 'Untitled', content: 'Unsaved draft text' }
		});

		// Calling flushSync again when not dirty is a clean no-op
		engine.flushSync();
		expect(fsSync.existsSync(sessionFilePath)).toBe(true);
	});

	it('preserves data with zero promise-chain memory leaks under high-throughput saves', async () => {
		const engine = new SessionPersistenceEngine({
			getFilePath: () => sessionFilePath,
			debounceMs: 100
		});

		// Warm up initial cache
		await engine.getPersistenceData();

		// Simulate 5,000 rapid sequential saves
		const itemCount = 5000;
		for (let i = 0; i < itemCount; i++) {
			await engine.save(`key_${i}`, i);
		}

		// Verify in-memory state has all items
		const allData = await engine.loadAll();
		expect(Object.keys(allData).length).toBe(itemCount);
		expect(allData['key_0']).toBe(0);
		expect(allData[`key_${itemCount - 1}`]).toBe(itemCount - 1);

		// Synchronously flush
		engine.flushSync();
		expect(fsSync.existsSync(sessionFilePath)).toBe(true);

		const diskContent = JSON.parse(fsSync.readFileSync(sessionFilePath, 'utf-8'));
		expect(Object.keys(diskContent).length).toBe(itemCount);
		expect(diskContent['key_4999']).toBe(4999);
	});

	it('loads from disk on cold start and serves subsequent queries from cache', async () => {
		// Pre-populate disk file
		await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
		await fs.writeFile(
			sessionFilePath,
			JSON.stringify(
				{
					rootFolder: { kind: 'native', path: '/home/user/workspace' },
					openFiles: ['/home/user/workspace/README.md'],
					activeDocumentId: 'doc-1'
				},
				null,
				2
			),
			'utf-8'
		);

		const engine = new SessionPersistenceEngine({
			getFilePath: () => sessionFilePath,
			debounceMs: 500
		});

		// Cold start: cache is not initialized yet
		expect(engine.getInMemoryCache()).toBeNull();

		// First load triggers disk read
		const rootFolder = await engine.load('rootFolder');
		expect(rootFolder).toEqual({ kind: 'native', path: '/home/user/workspace' });
		expect(engine.getInMemoryCache()).not.toBeNull();

		// Now remove disk file to prove subsequent loads hit in-memory cache
		await fs.rm(sessionFilePath);

		expect(await engine.load('openFiles')).toEqual(['/home/user/workspace/README.md']);
		expect(await engine.load('activeDocumentId')).toBe('doc-1');
		const all = await engine.loadAll();
		expect(all).toEqual({
			rootFolder: { kind: 'native', path: '/home/user/workspace' },
			openFiles: ['/home/user/workspace/README.md'],
			activeDocumentId: 'doc-1'
		});
	});

	it('gracefully handles missing files or corrupted JSON on cold start', async () => {
		const nonExistentEngine = new SessionPersistenceEngine({
			getFilePath: () => path.join(testDir, 'does-not-exist.json'),
			debounceMs: 500
		});

		expect(await nonExistentEngine.load('anyKey')).toBeNull();
		expect(await nonExistentEngine.loadAll()).toEqual({});

		// Write corrupted JSON
		const corruptFilePath = path.join(testDir, 'corrupt.json');
		await fs.writeFile(corruptFilePath, '{ invalid json syntax ...', 'utf-8');

		const corruptEngine = new SessionPersistenceEngine({
			getFilePath: () => corruptFilePath,
			debounceMs: 500
		});

		expect(await corruptEngine.load('anyKey')).toBeNull();
		expect(await corruptEngine.loadAll()).toEqual({});
	});

	it('ensures async flush() persists pending dirty changes immediately', async () => {
		const engine = new SessionPersistenceEngine({
			getFilePath: () => sessionFilePath,
			debounceMs: 1000
		});

		await engine.save('urgent', 'must-save-now');
		expect(fsSync.existsSync(sessionFilePath)).toBe(false);

		await engine.flush();

		expect(fsSync.existsSync(sessionFilePath)).toBe(true);
		const content = JSON.parse(await fs.readFile(sessionFilePath, 'utf-8'));
		expect(content).toEqual({ urgent: 'must-save-now' });
	});
});
