import { expect } from 'bun:test';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { TestRepo, createTrackedRepo, describe, it, runGit, seedCommit } from './harness';

function origin(r: TestRepo): FileOrigin {
	return { scheme: 'file', path: r.path, name: 'repo' };
}

/** The adapter wired to a real process-spawning runner instead of the IPC global. */
function adapter(r: TestRepo): SpawnGitAdapter {
	return new SpawnGitAdapter(origin(r), (workingDir, args) => runGit(workingDir, r.env, args));
}

describe('SpawnGitAdapter with a real git runner', () => {
	it('reports a clean committed repository as not dirty', async () => {
		const r = await createTrackedRepo();
		await seedCommit(r);

		const status = await adapter(r).getStatus();
		expect(status.isDirty).toBe(false);
		expect(status.uncommittedFiles).toEqual([]);
	});

	it('detects worktree changes against the real repository state', async () => {
		const r = await createTrackedRepo();
		await r.write('dirty.txt', 'uncommitted\n');

		const status = await adapter(r).getStatus();
		expect(status.isDirty).toBe(true);
		expect(status.uncommittedFiles).toEqual(['dirty.txt']);
	});
});