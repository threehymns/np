import { describe, expect, it, mock } from 'bun:test';
import { LazyIsomorphicGitAdapter } from './lazy';
import type { FileOrigin } from '@np/core';

const origin: FileOrigin = { scheme: 'browser', path: 'lazy-test', name: 'lazy-test' };

function fakeAdapter() {
	const calls: string[] = [];
	const inner = {
		detect: mock(async () => true),
		getStatus: mock(async () => ({ isDirty: false, uncommittedFiles: [] })),
		getCurrentBranch: mock(async () => 'main')
	};
	const loader = mock(async () => {
		calls.push('load');
		return inner as any;
	});
	return { inner, loader, calls };
}

describe('LazyIsomorphicGitAdapter', () => {
	it('does not load the adapter until a method is called', async () => {
		const { loader } = fakeAdapter();
		new LazyIsomorphicGitAdapter(origin, loader);
		expect(loader).not.toHaveBeenCalled();
	});

	it('delegates every call to the loaded adapter', async () => {
		const { inner, loader } = fakeAdapter();
		const adapter = new LazyIsomorphicGitAdapter(origin, loader);
		expect(await adapter.detect('x')).toBe(true);
		await adapter.getStatus();
		expect(inner.detect).toHaveBeenCalledTimes(1);
		expect(inner.getStatus).toHaveBeenCalledTimes(1);
	});

	it('loads the adapter only once for concurrent calls', async () => {
		const { loader } = fakeAdapter();
		const adapter = new LazyIsomorphicGitAdapter(origin, loader);
		await Promise.all([adapter.detect('x'), adapter.getCurrentBranch(), adapter.getStatus()]);
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('retries the load after a failed attempt', async () => {
		const { inner } = fakeAdapter();
		let attempts = 0;
		const loader = mock(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('load failed');
			return inner as any;
		});
		const adapter = new LazyIsomorphicGitAdapter(origin, loader);

		await expect(adapter.detect('x')).rejects.toThrow('load failed');
		expect(await adapter.detect('x')).toBe(true);

		expect(loader).toHaveBeenCalledTimes(2);
		expect(inner.detect).toHaveBeenCalledTimes(1);
	});
});
