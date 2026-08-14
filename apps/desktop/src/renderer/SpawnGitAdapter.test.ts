import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SpawnGitAdapter } from './SpawnGitAdapter';
import type { FileOrigin } from '@np/core';

describe('SpawnGitAdapter', () => {
	const rootOrigin: FileOrigin = { scheme: 'file', path: '/test/repo', name: 'repo' };
	let mockGitRun: ReturnType<typeof mock>;
	let mockReadFile: ReturnType<typeof mock>;
	let mockWriteFile: ReturnType<typeof mock>;
	let mockDeleteEntry: ReturnType<typeof mock>;

	beforeEach(() => {
		mockGitRun = mock(async (_workingDir: string, _args: string[]) => ({
			code: 0,
			stdout: '',
			stderr: ''
		}));
		mockReadFile = mock(async (_path: string) => new TextEncoder().encode('file content'));
		mockWriteFile = mock(async (_path: string, _content: string) => {});
		mockDeleteEntry = mock(async (_path: string) => {});

		(globalThis as any).window = {
			electronAPI: {
				gitRun: mockGitRun,
				readFile: mockReadFile,
				writeFile: mockWriteFile,
				deleteEntry: mockDeleteEntry
			}
		};
	});

	it('passes -uall to git status and does not invoke readFile on untracked directories', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				// Simulating output with an untracked directory (ending in /) and an untracked file
				return {
					code: 0,
					stdout: '?? .agents/\0?? file.txt\0',
					stderr: ''
				};
			}
			if (cmd.startsWith('diff --cached')) {
				return { code: 0, stdout: '', stderr: '' };
			}
			if (cmd.startsWith('diff')) {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const changes = await adapter.getChanges();

		// Should pass -uall to status
		const statusCall = mockGitRun.mock.calls.find((call: [string, string[]]) => call[1].includes('status'));
		expect(statusCall).toBeDefined();
		expect(statusCall![1]).toContain('-uall');

		// Should not have called readFile for the directory '.agents/'
		const readFilePaths = mockReadFile.mock.calls.map((call: [string]) => call[0]);
		expect(readFilePaths).not.toContain('/test/repo/.agents/');
		expect(readFilePaths).toContain('/test/repo/file.txt');

		// Only file.txt should be in changes
		expect(changes.length).toBe(1);
		expect(changes[0].filepath).toBe('file.txt');
	});

	it('does not invoke readFile on deleted files', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return {
					code: 0,
					stdout: ' D deleted.txt\0D  staged_deleted.txt\0',
					stderr: ''
				};
			}
			if (cmd.startsWith('diff')) {
				return { code: 0, stdout: '', stderr: '' };
			}
			if (cmd.startsWith('show')) {
				return { code: 0, stdout: 'old content', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const changes = await adapter.getChanges();

		// Should not call readFile for deleted files
		expect(mockReadFile).not.toHaveBeenCalled();
		expect(changes.length).toBe(2);
		const unstagedDeleted = changes.find(c => c.filepath === 'deleted.txt');
		expect(unstagedDeleted?.status).toBe('D');
		expect(unstagedDeleted?.modifiedContent).toBe('');

		const stagedDeleted = changes.find(c => c.filepath === 'staged_deleted.txt');
		expect(stagedDeleted?.status).toBe('D');
		expect(stagedDeleted?.modifiedContent).toBe('');
	});
});
