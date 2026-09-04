import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
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

	afterEach(() => {
		delete (globalThis as any).window;
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
			if (cmd.includes('diff --cached --numstat')) {
				return {
					code: 0,
					stdout: '10\t5\tstaged.ts\n3\t1\tboth.ts\n',
					stderr: ''
				};
			}
			if (cmd.includes('diff --numstat')) {
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

		// Check that numstat commands include core.quotepath=false configuration
		const numstatCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1].includes('--numstat'));
		expect(numstatCalls.length).toBe(2);
		expect(numstatCalls[0][1]).toEqual(['-c', 'core.quotepath=false', 'diff', '--cached', '--numstat']);
		expect(numstatCalls[1][1]).toEqual(['-c', 'core.quotepath=false', 'diff', '--numstat']);

		// Check that no per-file diff or show commands were executed
		const perFileDiffCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => {
			const args = call[1];
			return args.includes('diff') && args.includes('--') && !args.includes('--numstat');
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

	it('preserves leading and trailing whitespace in filenames from numstat during getChanges', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return {
					code: 0,
					stdout: 'MM  leading_space.ts\0M  trailing_space.ts \0',
					stderr: ''
				};
			}
			if (cmd.includes('diff --cached --numstat')) {
				return {
					code: 0,
					stdout: '7\t2\t leading_space.ts\n12\t4\ttrailing_space.ts \n',
					stderr: ''
				};
			}
			if (cmd.includes('diff --numstat')) {
				return {
					code: 0,
					stdout: '5\t1\t leading_space.ts\n',
					stderr: ''
				};
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const changes = await adapter.getChanges();

		const leadingStaged = changes.find(c => c.filepath === ' leading_space.ts' && c.staged);
		expect(leadingStaged?.additions).toBe(7);
		expect(leadingStaged?.deletions).toBe(2);

		const leadingUnstaged = changes.find(c => c.filepath === ' leading_space.ts' && !c.staged);
		expect(leadingUnstaged?.additions).toBe(5);
		expect(leadingUnstaged?.deletions).toBe(1);

		const trailingStaged = changes.find(c => c.filepath === 'trailing_space.ts ' && c.staged);
		expect(trailingStaged?.additions).toBe(12);
		expect(trailingStaged?.deletions).toBe(4);
	});

	it('updateIndexContent throws when git apply --cached fails', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
				return { code: 0, stdout: '.git', stderr: '' };
			}
			if (args[0] === 'apply') {
				return { code: 1, stdout: '', stderr: 'error: patch does not apply' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.updateIndexContent('new.sh', '#!/bin/bash\necho new\n')).rejects.toThrow(
			'patch does not apply'
		);
	});

	it('discardChanges throws when git reset fails instead of silently swallowing it', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'checkout') {
				// A staged addition is absent from HEAD, so checkout fails path-not-found
				// and the discard proceeds to the reset recovery.
				return {
					code: 1,
					stdout: '',
					stderr: "error: pathspec 'file.txt' did not match any file(s) known to git"
				};
			}
			if (args[0] === 'reset') {
				return { code: 128, stdout: '', stderr: 'fatal: index file corrupt' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.discardChanges('file.txt')).rejects.toThrow(/index file corrupt/);
	});

	it('discardChanges propagates a generic checkout failure without attempting a reset', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			if (args[0] === 'checkout') {
				return { code: 1, stdout: '', stderr: 'error: unable to unlink old file.txt' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.discardChanges('file.txt')).rejects.toThrow(/unable to unlink/);
		// The recovery reset must not run for a failure that is not path-not-found.
		expect(commands.some(cmd => cmd[0] === 'reset')).toBe(false);
	});

	it('discardChanges recovers a path-not-found checkout with a reset and a clean', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			if (args[0] === 'checkout') {
				return {
					code: 1,
					stdout: '',
					stderr: "error: pathspec 'file.txt' did not match any file(s) known to git"
				};
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.discardChanges('file.txt');

		expect(commands).toContainEqual(['reset', 'HEAD', '--', 'file.txt']);
		expect(commands).toContainEqual(['clean', '-fd', '--', 'file.txt']);
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

	it('getFileDiff skips git show commands and only reads worktree content for untracked files (status: "U")', async () => {
		mockReadFile.mockImplementation(async () => new TextEncoder().encode('untracked disk content'));
		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('untracked.txt', { status: 'U' });

		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe('untracked disk content');
		const showCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'show');
		expect(showCalls.length).toBe(0);
	});

	it('getFileDiff skips HEAD git show query for staged added files (status: "A", staged: true)', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === ':added.txt') {
				return { code: 0, stdout: 'staged index content', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('added.txt', { status: 'A', staged: true });

		expect(diff.originalContent).toBe('');
		expect(diff.modifiedContent).toBe('staged index content');
		const headCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'show' && call[1][1].startsWith('HEAD:'));
		expect(headCalls.length).toBe(0);
	});

	it('getFileDiff skips worktree disk read for deleted files (status: "D", staged: false)', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'show' && args[1] === 'HEAD:deleted.txt') {
				return { code: 0, stdout: 'head content', stderr: '' };
			}
			if (args[0] === 'show' && args[1] === ':deleted.txt') {
				return { code: 0, stdout: 'index content', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		const adapter = new SpawnGitAdapter(rootOrigin);
		const diff = await adapter.getFileDiff('deleted.txt', { status: 'D', staged: false });

		expect(diff.originalContent).toBe('index content');
		expect(diff.modifiedContent).toBe('');
		expect(mockReadFile).not.toHaveBeenCalled();
	});

	it('stageAll issues a single native git add -A command', async () => {
		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.stageAll();

		const addCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'add');
		expect(addCalls.length).toBe(1);
		expect(addCalls[0][1]).toEqual(['add', '-A']);
	});

	it('unstageFile unstages normal file via git reset HEAD', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.unstageFile('file.txt');

		expect(commands).toContainEqual(['reset', 'HEAD', '--', 'file.txt']);
	});

	it('unstageFile resets both origPath and destination path when unstaging a staged rename', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			const cmd = args.join(' ');
			if (cmd.startsWith('status')) {
				return { code: 0, stdout: 'R  new.txt\0old.txt\0', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.unstageFile('new.txt');

		expect(commands).toContainEqual(['reset', 'HEAD', '--', 'old.txt', 'new.txt']);
	});

	it('unstageFile throws when git reset fails', async () => {
		mockGitRun.mockImplementation(async () => ({ code: 1, stdout: '', stderr: 'fatal: reset failed' }));
		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageFile('file.txt')).rejects.toThrow('reset failed');
	});

	it('unstageFile falls back to rm --cached when HEAD is unborn', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			if (args[0] === 'reset') {
				return {
					code: 1,
					stdout: '',
					stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
				};
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.unstageFile('file.txt');

		expect(commands).toContainEqual(['symbolic-ref', '-q', 'HEAD']);
		expect(commands).toContainEqual(['rev-parse', '--verify', 'HEAD']);
		expect(commands).toContainEqual(['for-each-ref', '--format=%(refname)']);
		expect(commands).toContainEqual(['rm', '--cached', '-q', '--', 'file.txt']);
	});

	it('unstageFile propagates an unborn-HEAD rm --cached failure', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'reset') {
				return { code: 1, stdout: '', stderr: "fatal: ambiguous argument 'HEAD'" };
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			if (args[0] === 'rm') {
				return { code: 128, stdout: '', stderr: 'fatal: rm failed' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageFile('file.txt')).rejects.toThrow('rm failed');
	});

	it('unstageFile treats an unstaged path in an unborn repository as a successful no-op', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'reset') {
				return { code: 1, stdout: '', stderr: "fatal: ambiguous argument 'HEAD'" };
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			if (args[0] === 'rm') {
				return { code: 1, stdout: '', stderr: "fatal: pathspec 'file.txt' did not match any files" };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageFile('file.txt')).resolves.toBeUndefined();
	});

	it('unstageFile does not fall back when a broken HEAD hides an existing repository', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			if (args[0] === 'reset') {
				return { code: 1, stdout: '', stderr: "fatal: ambiguous argument 'HEAD'" };
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			if (args[0] === 'for-each-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageFile('file.txt')).rejects.toThrow("ambiguous argument 'HEAD'");

		expect(commands.some(cmd => cmd[0] === 'rm')).toBe(false);
	});

	it('unstageFile does not fall back on a broken detached HEAD even if for-each-ref is empty', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			if (args[0] === 'reset') {
				return { code: 1, stdout: '', stderr: "fatal: ambiguous argument 'HEAD'" };
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 1, stdout: '', stderr: 'fatal: ref HEAD is not a symbolic ref' };
			}
			if (args[0] === 'for-each-ref') {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageFile('file.txt')).rejects.toThrow("ambiguous argument 'HEAD'");

		expect(commands.some(cmd => cmd[0] === 'rm')).toBe(false);
	});

	it('unstageFile falls back when git fails to resolve HEAD as a valid ref', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			if (args[0] === 'reset') {
				return { code: 1, stdout: '', stderr: "fatal: Failed to resolve 'HEAD' as a valid ref." };
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.unstageFile('file.txt');

		expect(commands).toContainEqual(['symbolic-ref', '-q', 'HEAD']);
		expect(commands).toContainEqual(['for-each-ref', '--format=%(refname)']);
		expect(commands).toContainEqual(['rm', '--cached', '-q', '--', 'file.txt']);
	});

	it('unstageFile propagates a git status failure instead of swallowing it', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'status') {
				throw new Error('status exploded');
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageFile('file.txt')).rejects.toThrow('status exploded');
	});

	it('unstageAll issues a single native git restore --staged command', async () => {
		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.unstageAll();

		const restoreCalls = mockGitRun.mock.calls.filter((call: [string, string[]]) => call[1][0] === 'restore');
		expect(restoreCalls.length).toBe(1);
		expect(restoreCalls[0][1]).toEqual(['restore', '--staged', '.']);
	});

	it('unstageAll falls back to rm --cached -r when HEAD is unborn', async () => {
		const commands: string[][] = [];
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			commands.push(args);
			if (args[0] === 'restore') {
				return { code: 1, stdout: '', stderr: "fatal: could not resolve 'HEAD'" };
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		await adapter.unstageAll();

		expect(commands).toContainEqual(['rm', '--cached', '-q', '-r', '--', '.']);
	});

	it('unstageAll propagates a real rm --cached failure on an unborn HEAD', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'restore') {
				return { code: 1, stdout: '', stderr: "fatal: could not resolve 'HEAD'" };
			}
			if (args[0] === 'symbolic-ref') {
				return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			if (args[0] === 'rm') {
				return { code: 128, stdout: '', stderr: 'fatal: rm failed' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});
		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageAll()).rejects.toThrow('rm failed');
	});

	it('unstageAll propagates a non-unborn restore failure', async () => {
		mockGitRun.mockImplementation(async () => ({ code: 1, stdout: '', stderr: 'fatal: restore failed' }));
		const adapter = new SpawnGitAdapter(rootOrigin);
		await expect(adapter.unstageAll()).rejects.toThrow('restore failed');
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

	it('switchBranch returns error status when git diff exits non-zero instead of proceeding to checkout', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'branch' && args.includes('--format=%(refname:short)')) {
				return { code: 0, stdout: 'main\nfeature\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args.includes('HEAD')) {
				return { code: 0, stdout: 'main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args.includes('feature')) {
				return { code: 0, stdout: 'abc1234\n', stderr: '' };
			}
			if (args[0] === 'status') {
				return { code: 0, stdout: ' M dirty.txt\0', stderr: '' };
			}
			if (args[0] === 'diff') {
				return { code: 128, stdout: '', stderr: 'fatal: git diff failed' };
			}
			if (args[0] === 'checkout') {
				throw new Error('checkout should not be called when diff fails');
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const res = await adapter.switchBranch('feature');
		expect(res.status).toBe('error');
		if (res.status === 'error') {
			expect(res.message).toContain('git diff failed');
		}
	});

	it('switchBranch does not spread uncommitted files into diff CLI arguments', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'branch' && args.includes('--format=%(refname:short)')) {
				return { code: 0, stdout: 'main\nfeature\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args.includes('HEAD')) {
				return { code: 0, stdout: 'main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args.includes('feature')) {
				return { code: 0, stdout: 'abc1234\n', stderr: '' };
			}
			if (args[0] === 'status') {
				return { code: 0, stdout: ' M dirty1.txt\0 M dirty2.txt\0', stderr: '' };
			}
			if (args[0] === 'diff') {
				// Assert args only compare tree to tree without spreading dirty filepaths
				expect(args).toEqual(['diff', '--name-only', '-z', 'HEAD', 'feature']);
				return { code: 0, stdout: 'dirty1.txt\0other.txt\0', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const res = await adapter.switchBranch('feature');
		expect(res.status).toBe('blocked');
		if (res.status === 'blocked') {
			expect(res.reason).toBe('conflict');
			// Intersected with status.uncommittedFiles, so only dirty1.txt is reported
			expect(res.files).toEqual(['dirty1.txt']);
		}
	});

	it('switchBranch surfaces untracked collisions as checkout error (pinned for #69 worktree upgrade)', async () => {
		mockGitRun.mockImplementation(async (_workingDir: string, args: string[]) => {
			if (args[0] === 'branch' && args.includes('--format=%(refname:short)')) {
				return { code: 0, stdout: 'main\nfeature\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args.includes('HEAD')) {
				return { code: 0, stdout: 'main\n', stderr: '' };
			}
			if (args[0] === 'rev-parse' && args.includes('feature')) {
				return { code: 0, stdout: 'abc1234\n', stderr: '' };
			}
			if (args[0] === 'status') {
				return { code: 0, stdout: '?? untracked.txt\0', stderr: '' };
			}
			if (args[0] === 'diff') {
				// Tracked tree-to-tree diff is empty: untracked paths are not in
				// either tree, so the O(1) path reports no conflict here.
				return { code: 0, stdout: '', stderr: '' };
			}
			if (args[0] === 'checkout') {
				return {
					code: 128,
					stdout: '',
					stderr: 'error: The following untracked working tree files would be overwritten by checkout:\n\tuntracked.txt'
				};
			}
			return { code: 0, stdout: '', stderr: '' };
		});

		const adapter = new SpawnGitAdapter(rootOrigin);
		const res = await adapter.switchBranch('feature');
		// Pinned current behavior: untracked overwrite surfaces as error.
		// #69 owns upgrading this to { status: 'blocked', reason: 'worktree' }.
		expect(res.status).toBe('error');
	});
});
