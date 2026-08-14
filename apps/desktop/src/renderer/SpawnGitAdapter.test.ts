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

	it('passes -uall to git status and only reads untracked files (no git show) during getChanges', async () => {
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
		mockReadFile.mockImplementation(async (path: string) => {
			if (path === '/test/repo/file.txt') {
				return new TextEncoder().encode('line1\nline2\n');
			}
			throw new Error('ENOENT');
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const changes = await adapter.getChanges();

		// Should pass -uall to status
		const statusCall = mockGitRun.mock.calls.find((call: [string, string[]]) => call[1].includes('status'));
		expect(statusCall).toBeDefined();
		expect(statusCall![1]).toContain('-uall');

		// Should not have called git show at all during getChanges
		const showCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'show');
		expect(showCalls.length).toBe(0);

		// The untracked file is the only thing read (to count lines); tracked files are not read
		expect(mockReadFile).toHaveBeenCalledWith('/test/repo/file.txt');
		expect(mockReadFile.mock.calls.length).toBe(1);

		// Only file.txt should be in changes, with an accurate line count
		expect(changes.length).toBe(1);
		expect(changes[0].filepath).toBe('file.txt');
		expect(changes[0].status).toBe('U');
		expect(changes[0].additions).toBe(2);
		expect(changes[0].deletions).toBe(0);
	});

	it('does not invoke readFile or git show on deleted files during getChanges', async () => {
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

		// Should not call readFile or git show for deleted files during getChanges
		expect(mockReadFile).not.toHaveBeenCalled();
		const showCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'show');
		expect(showCalls.length).toBe(0);
		expect(changes.length).toBe(2);
		const unstagedDeleted = changes.find(c => c.filepath === 'deleted.txt');
		expect(unstagedDeleted?.status).toBe('D');

		const stagedDeleted = changes.find(c => c.filepath === 'staged_deleted.txt');
		expect(stagedDeleted?.status).toBe('D');
	});

	it('uses bulk diff numstat and does not invoke per-file diff or show commands during getChanges', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return {
					code: 0,
					stdout: 'M  staged.ts\0 M unstaged.ts\0MM both.ts\0',
					stderr: ''
				};
			}
			if (cmd === 'diff --cached --numstat') {
				return {
					code: 0,
					stdout: '10\t5\tstaged.ts\n3\t1\tboth.ts\n',
					stderr: ''
				};
			}
			if (cmd === 'diff --numstat') {
				return {
					code: 0,
					stdout: '20\t2\tunstaged.ts\n4\t0\tboth.ts\n',
					stderr: ''
				};
			}
			if (cmd.startsWith('show')) {
				return { code: 0, stdout: 'file content', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const changes = await adapter.getChanges();

		// Check that no per-file diff or show commands were executed
		const perFileDiffCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => {
			const args = call[1];
			return args[0] === 'diff' && args.includes('--') && !args.includes('--numstat');
		});
		expect(perFileDiffCalls.length).toBe(0);
		const showCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'show');
		expect(showCalls.length).toBe(0);
		expect(mockReadFile).not.toHaveBeenCalled();

		// Verify additions and deletions match the bulk numstat
		const stagedChange = changes.find(c => c.filepath === 'staged.ts' && c.staged);
		expect(stagedChange).toBeDefined();
		expect(stagedChange?.additions).toBe(10);
		expect(stagedChange?.deletions).toBe(5);

		const unstagedChange = changes.find(c => c.filepath === 'unstaged.ts' && !c.staged);
		expect(unstagedChange).toBeDefined();
		expect(unstagedChange?.additions).toBe(20);
		expect(unstagedChange?.deletions).toBe(2);

		const bothStaged = changes.find(c => c.filepath === 'both.ts' && c.staged);
		expect(bothStaged?.additions).toBe(3);
		expect(bothStaged?.deletions).toBe(1);

		const bothUnstaged = changes.find(c => c.filepath === 'both.ts' && !c.staged);
		expect(bothUnstaged?.additions).toBe(4);
		expect(bothUnstaged?.deletions).toBe(0);
	});

	it('loads on-demand diff content via getFileDiff for staged changes', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === 'HEAD:staged.ts') {
				return { code: 0, stdout: 'head content', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':staged.ts') {
				return { code: 0, stdout: 'staged content', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('staged.ts', { staged: true });

		expect(diff.originalContent).toBe('head content');
		expect(diff.modifiedContent).toBe('staged content');
		expect(diff.stagedContent).toBe('staged content');
		expect(mockReadFile).not.toHaveBeenCalled();
	});

	it('loads on-demand diff content via getFileDiff for unstaged changes', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === ':unstaged.ts') {
				return { code: 0, stdout: 'staged content', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async (path: string) => {
			if (path === '/test/repo/unstaged.ts') {
				return 'worktree content';
			}
			return '';
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('unstaged.ts', { staged: false });

		expect(diff.originalContent).toBe('staged content');
		expect(diff.modifiedContent).toBe('worktree content');
		expect(diff.stagedContent).toBe('staged content');
		expect(mockReadFile).toHaveBeenCalledWith('/test/repo/unstaged.ts');
	});

	it('loads on-demand diff content via getFileDiff for untracked files', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show') {
				return { code: 128, stdout: '', stderr: 'fatal: path not in index' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async (path: string) => {
			if (path === '/test/repo/untracked.ts') {
				return 'new file content';
			}
			return '';
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('untracked.ts');

		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe('new file content');
		expect(mockReadFile).toHaveBeenCalledWith('/test/repo/untracked.ts');
	});

	it('loads on-demand diff content via getFileDiff for deleted files without disk reads', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === 'HEAD:deleted.ts') {
				return { code: 0, stdout: 'deleted content from head', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':deleted.ts') {
				return { code: 0, stdout: 'deleted content from head', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async () => {
			throw new Error('ENOENT: no such file');
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('deleted.ts', { staged: false });

		expect(diff.originalContent).toBe('deleted content from head');
		expect(diff.modifiedContent).toBe('');
	});

	it('resolves the original content of a renamed file from its previous path', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				// porcelain -z rename entry: "R  new.txt\0old.txt\0"
				return { code: 0, stdout: 'R  new.txt\0old.txt\0', stderr: '' };
			}
			if (cmd === 'diff --cached --numstat') {
				return { code: 0, stdout: '0\t0\told.txt => new.txt\n', stderr: '' };
			}
			if (cmd === 'diff --numstat') {
				return { code: 0, stdout: '', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === 'HEAD:old.txt') {
				return { code: 0, stdout: 'renamed from old', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':new.txt') {
				return { code: 0, stdout: 'renamed to new', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const changes = await adapter.getChanges();
		const renamed = changes.find(c => c.filepath === 'new.txt');
		expect(renamed).toBeDefined();
		expect(renamed?.staged).toBe(true);

		const diff = await adapter.getFileDiff('new.txt', { staged: true });
		expect(diff.originalContent).toBe('renamed from old');
		expect(diff.modifiedContent).toBe('renamed to new');
		expect(mockReadFile).not.toHaveBeenCalled();
	});

	it('resolves renamed file previous path dynamically in getFileDiff even without prior getChanges call', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: 'R  new.txt\0old.txt\0', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === 'HEAD:old.txt') {
				return { code: 0, stdout: 'renamed from old on-demand', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':new.txt') {
				return { code: 0, stdout: 'renamed to new on-demand', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		// Note: getChanges() is NOT called here
		const diff = await adapter.getFileDiff('new.txt', { staged: true });
		expect(diff.originalContent).toBe('renamed from old on-demand');
		expect(diff.modifiedContent).toBe('renamed to new on-demand');
	});
});

