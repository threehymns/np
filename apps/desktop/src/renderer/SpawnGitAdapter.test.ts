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

	it('loads on-demand diff content via getFileDiff for staged deleted files', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === 'HEAD:staged-deleted.ts') {
				return { code: 0, stdout: 'content in head', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':staged-deleted.ts') {
				return { code: 128, stdout: '', stderr: 'fatal: path not in index' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('staged-deleted.ts', { staged: true });

		expect(diff.originalContent).toBe('content in head');
		expect(diff.modifiedContent).toBe('');
		expect(diff.stagedContent).toBe('');
	});

	it('loads on-demand diff content via getFileDiff for staged deleted files recreated in worktree', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === 'HEAD:staged-deleted.ts') {
				return { code: 0, stdout: 'content in head', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':staged-deleted.ts') {
				return { code: 128, stdout: '', stderr: 'fatal: path not in index' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async (path: string) => {
			if (path === '/test/repo/staged-deleted.ts') {
				return 'recreated content';
			}
			return '';
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('staged-deleted.ts', { staged: false });

		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe('recreated content');
		expect(diff.stagedContent).toBe('');
		expect(mockReadFile).toHaveBeenCalledWith('/test/repo/staged-deleted.ts');
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

	it('does not treat an untracked file as a rename even when a deleted file has identical content', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: ' D old.txt\0?? new.txt\0', stderr: '' };
			}
			if (args[0] === 'show' && (args[1] === 'HEAD:new.txt' || args[1] === ':new.txt')) {
				return { code: 128, stdout: '', stderr: 'fatal: path not in index' };
			}
			if (args[0] === 'show' && (args[1] === 'HEAD:old.txt' || args[1] === ':old.txt')) {
				return { code: 0, stdout: 'identical content\n', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async (path: string) => {
			if (path === '/test/repo/new.txt') {
				return 'identical content\n';
			}
			return '';
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const unstagedDiff = await adapter.getFileDiff('new.txt', { staged: false });
		expect(unstagedDiff.originalContent).toBe('');
		expect(unstagedDiff.modifiedContent).toBe('identical content\n');
		expect(unstagedDiff.stagedContent).toBe('');

		const combinedDiff = await adapter.getFileDiff('new.txt');
		expect(combinedDiff.originalContent).toBe('');
		expect(combinedDiff.modifiedContent).toBe('identical content\n');
		expect(combinedDiff.stagedContent).toBe('');
	});

	it('does not treat an untracked file as a rename when a deleted file has similar content', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: ' D old.txt\0?? new.txt\0', stderr: '' };
			}
			if (args[0] === 'show' && (args[1] === 'HEAD:new.txt' || args[1] === ':new.txt')) {
				return { code: 128, stdout: '', stderr: 'fatal: path not in index' };
			}
			if (args[0] === 'show' && (args[1] === 'HEAD:old.txt' || args[1] === ':old.txt')) {
				return { code: 0, stdout: 'alpha\nbeta\ngamma\ndelta\n', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async (path: string) => {
			if (path === '/test/repo/new.txt') {
				return 'alpha\nbeta\ngamma\nchanged delta\n';
			}
			return '';
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('new.txt', { staged: false });

		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe('alpha\nbeta\ngamma\nchanged delta\n');
		expect(diff.stagedContent).toBe('');
	});

	it('does not treat a genuinely untracked file as a worktree rename', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: '?? brand_new.txt\0', stderr: '' };
			}
			if (args[0] === 'show') {
				return { code: 128, stdout: '', stderr: 'fatal: path not in index' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async (path: string) => {
			if (path === '/test/repo/brand_new.txt') {
				return 'new file content';
			}
			return '';
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('brand_new.txt', { staged: false });

		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe('new file content');
		expect(diff.stagedContent).toBe('');
	});

	it('discardChanges reverts a staged rename by restoring the original path and removing the new path', async () => {
		const calls: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			calls.push(args);
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: 'R  new.txt\0old.txt\0', stderr: '' };
			}
			if (args[0] === 'reset' || args[0] === 'checkout' || args[0] === 'clean') {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardChanges('new.txt');

		// Reset must target both the original and the new path so the index reverts the rename.
		const reset = calls.find(c => c[0] === 'reset');
		expect(reset).toEqual(['reset', 'HEAD', '--', 'old.txt', 'new.txt']);
		// The original path is restored from HEAD rather than the (absent) new path.
		const checkout = calls.find(c => c[0] === 'checkout');
		expect(checkout).toEqual(['checkout', 'HEAD', '--', 'old.txt']);
		// Only the new path is cleaned from the worktree; the original is never removed.
		const clean = calls.filter(c => c[0] === 'clean');
		expect(clean).toEqual([['clean', '-fd', '--', 'new.txt']]);
	});

	it('discardChanges reverts a staged rename even without a prior getChanges call', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: 'R  new.txt\0old.txt\0', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardChanges('new.txt');

		// No getChanges() was called, so origPath must be resolved on-demand from status.
		expect(mockGitRun.mock.calls.some((call: [string, string[]]) =>
			call[1][0] === 'reset' && call[1].includes('old.txt'))).toBe(true);
	});

	it('discardChanges throws when git reset fails instead of silently swallowing it', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'checkout') {
				return { code: 1, stdout: '', stderr: 'checkout failed' };
			}
			if (args[0] === 'reset') {
				return { code: 128, stdout: '', stderr: 'fatal: index file corrupt' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.discardChanges('file.txt')).rejects.toThrow(/index file corrupt/);
	});

	it('discardChanges with an unstaged scope resets only the worktree copy of a rename destination', async () => {
		const calls: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			calls.push(args);
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardChanges('new.txt', { staged: false });

		// The staged rename stays intact: only the worktree copy is reset from the index,
		// and the original path is never touched.
		expect(calls).toEqual([['restore', '--worktree', '--', 'new.txt']]);
	});

	it('discardChanges with an unstaged scope leaves a git-reported staged rename with unstaged edits intact', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				// staged rename plus unstaged edits at the destination: "RM new.txt"
				return { code: 0, stdout: 'RM new.txt\0old.txt\0', stderr: '' };
			}
			if (cmd.startsWith('diff')) {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		// getChanges records the porcelain rename source for new.txt and emits both entries.
		const changes = await adapter.getChanges();
		expect(changes.filter(c => c.filepath === 'new.txt').length).toBe(2);
		expect(changes.find(c => c.filepath === 'new.txt' && c.staged)?.staged).toBe(true);
		expect(changes.find(c => c.filepath === 'new.txt' && !c.staged)?.staged).toBe(false);

		await adapter.discardChanges('new.txt', { staged: false });

		// Unstaged discard resets only the worktree copy; the staged rename is untouched.
		const badCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) =>
			call[1][0] === 'reset' || call[1][0] === 'checkout' || call[1].includes('old.txt'));
		expect(badCalls.length).toBe(0);
		const restore = mockGitRun.mock.calls.find((call: [string, string[]]) => call[1][0] === 'restore');
		expect(restore?.[1]).toEqual(['restore', '--worktree', '--', 'new.txt']);
	});

	it('discardChanges with an unstaged scope keeps staged changes while resetting the worktree copy', async () => {
		const calls: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			calls.push(args);
			if (args[0] === 'restore') {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardChanges('both.ts', { staged: false });

		expect(calls).toEqual([['restore', '--worktree', '--', 'both.ts']]);
	});

	it('discardChanges with an unstaged scope cleans an untracked file without touching deleted paths', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: ' D old.txt\0?? new.txt\0', stderr: '' };
			}
			if (cmd === 'restore --worktree -- new.txt') {
				return { code: 1, stdout: '', stderr: "error: pathspec 'new.txt' did not match any file(s) known to git" };
			}
			if (cmd === 'clean -fd -- new.txt') {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardChanges('new.txt', { staged: false });

		// Only the untracked file is cleaned; the unrelated deleted path is never restored.
		const renameRestore = mockGitRun.mock.calls.find((call: [string, string[]]) =>
			(call[1][0] === 'restore' || call[1][0] === 'checkout' || call[1][0] === 'reset') && call[1].includes('old.txt'));
		expect(renameRestore).toBeUndefined();
		const clean = mockGitRun.mock.calls.find((call: [string, string[]]) =>
			call[1][0] === 'clean' && call[1].includes('new.txt'));
		expect(clean).toBeDefined();
	});

	it('discardChanges without a scope cleans an untracked file without touching deleted paths', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: ' D old.txt\0?? new.txt\0', stderr: '' };
			}
			if (cmd === 'checkout HEAD -- new.txt' || cmd === 'reset HEAD -- new.txt') {
				return { code: 1, stdout: '', stderr: "error: pathspec 'new.txt' did not match any file(s) known to git" };
			}
			if (cmd === 'clean -fd -- new.txt') {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardChanges('new.txt');

		// The unrelated deleted path is never restored, and the untracked file is cleaned.
		const touchesOldPath = mockGitRun.mock.calls.find((call: [string, string[]]) =>
			(call[1][0] === 'restore' || call[1][0] === 'checkout' || call[1][0] === 'reset' || call[1][0] === 'clean') && call[1].includes('old.txt'));
		expect(touchesOldPath).toBeUndefined();
		const clean = mockGitRun.mock.calls.find((call: [string, string[]]) =>
			call[1][0] === 'clean' && call[1].includes('new.txt'));
		expect(clean).toBeDefined();
	});

	it('getFileDiff throws (not an empty diff) when the repo is corrupt', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show') {
				return { code: 128, stdout: '', stderr: 'fatal: bad index file sha1 signature' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.getFileDiff('file.txt', { staged: true })).rejects.toThrow(/bad index file/);
	});

	it('getFileDiff propagates worktree read failures instead of returning an empty diff', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === 'HEAD:file.txt') {
				return { code: 0, stdout: 'head content', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':file.txt') {
				return { code: 0, stdout: 'staged content', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		mockReadFile.mockImplementation(async () => {
			throw new Error('EACCES: permission denied, open file.txt');
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.getFileDiff('file.txt', { staged: false })).rejects.toThrow(/permission denied/);
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

	it('stageAll issues a single native git add -A command', async () => {
		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.stageAll();

		const addCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'add');
		expect(addCalls.length).toBe(1);
		expect(addCalls[0][1]).toEqual(['add', '-A']);
	});

	it('unstageAll issues a single native git restore --staged command', async () => {
		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.unstageAll();

		const restoreCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'restore');
		expect(restoreCalls.length).toBe(1);
		expect(restoreCalls[0][1]).toEqual(['restore', '--staged', '.']);
	});

	it('discardAll issues native git restore and git clean commands', async () => {
		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardAll();

		const restoreCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'restore');
		expect(restoreCalls.length).toBe(1);
		expect(restoreCalls[0][1]).toEqual(['restore', '--staged', '--worktree', '.']);

		const cleanCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'clean');
		expect(cleanCalls.length).toBe(1);
		expect(cleanCalls[0][1]).toEqual(['clean', '-fd', '.']);
	});

	it('stageAll throws when git add fails', async () => {
		mockGitRun.mockImplementation(async () => ({ code: 128, stdout: '', stderr: 'fatal: index file corrupt' }));
		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.stageAll()).rejects.toThrow(/index file corrupt/);
	});

	it('detect returns true when inside a work tree', async () => {
		mockGitRun.mockImplementation(async (_wd: string, args: string[]) => {
			if (args.includes('--is-inside-work-tree')) {
				return { code: 0, stdout: 'true', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		const adapter = new SpawnGitAdapter(rootOrigin);
		const result = await adapter.detect('/test/repo');
		expect(result).toBe(true);
	});

	it('detect returns false when not inside a work tree', async () => {
		mockGitRun.mockImplementation(async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }));
		const adapter = new SpawnGitAdapter(rootOrigin);
		const result = await adapter.detect('/test/repo');
		expect(result).toBe(false);
	});
});

