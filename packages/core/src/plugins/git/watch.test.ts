import { describe, it, expect } from 'bun:test';
import {
	isGitHistoryWatchedPath,
	resolveGitDir,
	startGitWatcher,
	startWorkspaceGitWatcher,
	stopWorkspaceGitWatcher
} from './watch';

describe('isGitHistoryWatchedPath (Ticket #349 / ADR 0027)', () => {
	const gitDir = '/home/user/project/.git';

	it('matches HEAD file within gitDir', () => {
		expect(isGitHistoryWatchedPath('/home/user/project/.git/HEAD', gitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('HEAD', gitDir)).toBe(true);
	});

	it('matches refs/heads branches within gitDir at any depth', () => {
		expect(isGitHistoryWatchedPath('/home/user/project/.git/refs/heads/main', gitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/refs/heads/feat/issue-349', gitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('refs/heads/main', gitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/refs/heads', gitDir)).toBe(true);
	});

	it('matches packed-refs within gitDir', () => {
		expect(isGitHistoryWatchedPath('/home/user/project/.git/packed-refs', gitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('packed-refs', gitDir)).toBe(true);
	});

	it('handles Windows backslashes in paths', () => {
		const winGitDir = 'C:\\workspace\\project\\.git';
		expect(isGitHistoryWatchedPath('C:\\workspace\\project\\.git\\HEAD', winGitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('C:\\workspace\\project\\.git\\refs\\heads\\main', winGitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('C:\\workspace\\project\\.git\\packed-refs', winGitDir)).toBe(true);
	});

	it('ignores staging index writes and other internal git files', () => {
		expect(isGitHistoryWatchedPath('/home/user/project/.git/index', gitDir)).toBe(false);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/COMMIT_EDITMSG', gitDir)).toBe(false);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/config', gitDir)).toBe(false);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/description', gitDir)).toBe(false);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/ORIG_HEAD', gitDir)).toBe(false);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/FETCH_HEAD', gitDir)).toBe(false);
	});

	it('matches refs/remotes so push/fetch refresh the unpushed indicator', () => {
		expect(isGitHistoryWatchedPath('/home/user/project/.git/refs/remotes/origin/main', gitDir)).toBe(true);
		expect(isGitHistoryWatchedPath('refs/remotes/origin/feature-x', gitDir)).toBe(true);
	});

	it('ignores non-branch refs and object store writes', () => {
		expect(isGitHistoryWatchedPath('/home/user/project/.git/refs/tags/v1.0.0', gitDir)).toBe(false);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/objects/4b/825dc642cb6eb9a060e54bf8d69288fbee4904', gitDir)).toBe(false);
		expect(isGitHistoryWatchedPath('/home/user/project/.git/logs/HEAD', gitDir)).toBe(false);
	});
});

describe('resolveGitDir (Ticket #349 / ADR 0027)', () => {
	it('resolves relative .git in standard repository', () => {
		expect(resolveGitDir('/workspace/my-repo', '.git')).toBe('/workspace/my-repo/.git');
		expect(resolveGitDir('/workspace/my-repo/', '.git\n')).toBe('/workspace/my-repo/.git');
	});

	it('preserves absolute git dir from linked worktrees', () => {
		const worktreeGitDir = '/workspace/main-repo/.git/worktrees/linked-wt';
		expect(resolveGitDir('/workspace/linked-wt', worktreeGitDir)).toBe(worktreeGitDir);
	});

	it('normalizes relative parent navigation segments', () => {
		expect(resolveGitDir('/workspace/linked-wt', '../main-repo/.git/worktrees/linked-wt')).toBe(
			'/workspace/main-repo/.git/worktrees/linked-wt'
		);
	});

	it('handles Windows drive-letter paths correctly', () => {
		expect(resolveGitDir('C:\\workspace\\my-repo', '.git')).toBe('C:/workspace/my-repo/.git');
		expect(resolveGitDir('C:\\workspace\\linked-wt', 'C:\\workspace\\main-repo\\.git\\worktrees\\wt')).toBe(
			'C:/workspace/main-repo/.git/worktrees/wt'
		);
	});

	it('returns null when raw git dir output is empty', () => {
		expect(resolveGitDir('/workspace/my-repo', '')).toBe(null);
		expect(resolveGitDir('/workspace/my-repo', '   \n')).toBe(null);
	});
});

describe('startGitWatcher (Ticket #349 / ADR 0027)', () => {
	it('returns null when platform APIs are absent (web environment guard)', async () => {
		const stop = await startGitWatcher({
			workingDir: '/workspace/project',
			onHistoryChange: () => {}
		});
		expect(stop).toBe(null);
	});

	it('returns null when git rev-parse fails', async () => {
		const mockGitRun = async () => ({ code: 128, stdout: '', stderr: 'not a git repo' });
		const mockWatch = async () => () => {};

		const stop = await startGitWatcher({
			workingDir: '/workspace/project',
			onHistoryChange: () => {},
			gitRun: mockGitRun,
			watchDirectory: mockWatch
		});
		expect(stop).toBe(null);
	});

	it('resolves git dir and starts watcher on resolved path', async () => {
		let watchedPath = '';
		const mockGitRun = async () => ({ code: 0, stdout: '.git\n', stderr: '' });
		const mockWatch = async (dirPath: string) => {
			watchedPath = dirPath;
			return () => {};
		};

		const stop = await startGitWatcher({
			workingDir: '/workspace/project',
			onHistoryChange: () => {},
			gitRun: mockGitRun,
			watchDirectory: mockWatch
		});

		expect(stop).toBeFunction();
		expect(watchedPath).toBe('/workspace/project/.git');
		if (stop) await stop();
	});

	it('ignores staging index churn and non-history files without triggering callback', async () => {
		let eventCallback: any = null;
		let changeCalls = 0;
		const mockGitRun = async () => ({ code: 0, stdout: '.git\n', stderr: '' });
		const mockWatch = (dirPath: string, cb: any) => {
			eventCallback = cb;
			return () => {};
		};

		const stop = await startGitWatcher({
			workingDir: '/workspace/project',
			onHistoryChange: () => {
				changeCalls++;
			},
			gitRun: mockGitRun,
			watchDirectory: mockWatch,
			debounceMs: 20
		});

		expect(eventCallback).toBeFunction();
		eventCallback([
			{ path: '/workspace/project/.git/index', type: 'update' },
			{ path: '/workspace/project/.git/COMMIT_EDITMSG', type: 'create' },
			{ path: '/workspace/project/.git/objects/ab/1234', type: 'create' }
		]);

		await new Promise((r) => setTimeout(r, 50));
		expect(changeCalls).toBe(0);

		if (stop) await stop();
	});

	it('debounces ref/HEAD changes and coalesces refetch storms into one refresh', async () => {
		let eventCallback: any = null;
		let changeCalls = 0;
		const mockGitRun = async () => ({ code: 0, stdout: '.git\n', stderr: '' });
		const mockWatch = (dirPath: string, cb: any) => {
			eventCallback = cb;
			return () => {};
		};

		const stop = await startGitWatcher({
			workingDir: '/workspace/project',
			onHistoryChange: () => {
				changeCalls++;
			},
			gitRun: mockGitRun,
			watchDirectory: mockWatch,
			debounceMs: 30
		});

		// Rapid storm of events (e.g. git commit / gc / checkout rewriting refs)
		eventCallback([{ path: '/workspace/project/.git/refs/heads/main', type: 'update' }]);
		await new Promise((r) => setTimeout(r, 10));
		eventCallback([{ path: '/workspace/project/.git/HEAD', type: 'update' }]);
		await new Promise((r) => setTimeout(r, 10));
		eventCallback([{ path: '/workspace/project/.git/packed-refs', type: 'update' }]);

		// Before debounce timer finishes
		expect(changeCalls).toBe(0);

		// Wait for debounce timer to fire
		await new Promise((r) => setTimeout(r, 60));
		expect(changeCalls).toBe(1);

		if (stop) await stop();
	});

	it('unsubscribes and cancels pending debounce timer on stop', async () => {
		let eventCallback: any = null;
		let changeCalls = 0;
		let unwatchCalled = false;
		const mockGitRun = async () => ({ code: 0, stdout: '.git\n', stderr: '' });
		const mockWatch = (dirPath: string, cb: any) => {
			eventCallback = cb;
			return () => {
				unwatchCalled = true;
			};
		};

		const stop = await startGitWatcher({
			workingDir: '/workspace/project',
			onHistoryChange: () => {
				changeCalls++;
			},
			gitRun: mockGitRun,
			watchDirectory: mockWatch,
			debounceMs: 30
		});

		eventCallback([{ path: '/workspace/project/.git/HEAD', type: 'update' }]);
		expect(stop).toBeFunction();

		// Stop immediately while debounce timer is still pending
		if (stop) await stop();
		expect(unwatchCalled).toBe(true);

		// Wait longer than debounceMs and verify onHistoryChange did not fire
		await new Promise((r) => setTimeout(r, 50));
		expect(changeCalls).toBe(0);
	});

	it('subscribes to the git common dir as well as the per-worktree dir when they differ', async () => {
		const worktreeGitDir = '/workspace/main-repo/.git/worktrees/linked-wt';
		const commonGitDir = '/workspace/main-repo/.git';
		const watchedDirs: string[] = [];
		const callbacks = new Map<string, any>();
		const stopped: string[] = [];
		let changeCalls = 0;

		const mockGitRun = async (_workingDir: string, args: string[]) => {
			if (args[1] === '--git-common-dir') {
				return { code: 0, stdout: `${commonGitDir}\n`, stderr: '' };
			}
			return { code: 0, stdout: `${worktreeGitDir}\n`, stderr: '' };
		};
		const mockWatch = (dirPath: string, cb: any) => {
			watchedDirs.push(dirPath);
			callbacks.set(dirPath, cb);
			return () => {
				stopped.push(dirPath);
			};
		};

		const stop = await startGitWatcher({
			workingDir: '/workspace/linked-wt',
			onHistoryChange: () => {
				changeCalls++;
			},
			gitRun: mockGitRun,
			watchDirectory: mockWatch,
			debounceMs: 20
		});

		expect(stop).toBeFunction();
		expect(watchedDirs).toEqual([worktreeGitDir, commonGitDir]);

		// A commit in the linked worktree updates the branch ref in the common dir
		callbacks.get(commonGitDir)([{ path: `${commonGitDir}/refs/heads/feature`, type: 'update' }]);
		await new Promise((r) => setTimeout(r, 40));
		expect(changeCalls).toBe(1);

		// The worktree dir holds HEAD but no branch refs: a refs/heads event
		// there is not a real history change and must not trigger
		callbacks.get(worktreeGitDir)([{ path: `${worktreeGitDir}/refs/heads/feature`, type: 'update' }]);
		await new Promise((r) => setTimeout(r, 40));
		expect(changeCalls).toBe(1);

		// HEAD in the worktree dir still triggers (branch switch)
		callbacks.get(worktreeGitDir)([{ path: `${worktreeGitDir}/HEAD`, type: 'update' }]);
		await new Promise((r) => setTimeout(r, 40));
		expect(changeCalls).toBe(2);

		// Stop closes both subscriptions
		if (stop) await stop();
		expect(stopped).toEqual([worktreeGitDir, commonGitDir]);
	});

	it('watches only the git dir when --git-common-dir is unavailable', async () => {
		const watchedDirs: string[] = [];
		const mockGitRun = async (_workingDir: string, args: string[]) => {
			if (args[1] === '--git-common-dir') {
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 0, stdout: '.git\n', stderr: '' };
		};
		const mockWatch = (dirPath: string, _cb: any) => {
			watchedDirs.push(dirPath);
			return () => {};
		};

		const stop = await startGitWatcher({
			workingDir: '/workspace/project',
			onHistoryChange: () => {},
			gitRun: mockGitRun,
			watchDirectory: mockWatch
		});

		expect(stop).toBeFunction();
		expect(watchedDirs).toEqual(['/workspace/project/.git']);
		if (stop) await stop();
	});
});

describe('startWorkspaceGitWatcher & stopWorkspaceGitWatcher lifecycle (Ticket #349 / ADR 0027)', () => {
	it('attaches watcher to state and triggers repo.refreshHistory on matching events', async () => {
		let eventCallback: any = null;
		let refreshHistoryCalls = 0;
		const mockGitRun = async () => ({ code: 0, stdout: '.git\n', stderr: '' });
		const mockWatch = (dirPath: string, cb: any) => {
			eventCallback = cb;
			return () => {};
		};

		const repo: any = {
			refreshHistory: async () => {
				refreshHistoryCalls++;
				return true;
			}
		};
		const state: any = {
			workspace: {},
			ownerId: 'git',
			repository: repo,
			disposed: false,
			pending: new Set(),
			disposables: [],
			currentOpenId: 1,
			isActive: () => true
		};
		const origin = { scheme: 'file', path: '/workspace/project', name: 'project' };

		await startWorkspaceGitWatcher(state, origin as any, repo, {
			gitRun: mockGitRun,
			watchDirectory: mockWatch,
			debounceMs: 20
		});

		expect(state.watcherStop).toBeFunction();
		expect(state.disposables).toHaveLength(1);

		eventCallback([{ path: '/workspace/project/.git/refs/heads/main', type: 'update' }]);
		await new Promise((r) => setTimeout(r, 40));
		expect(refreshHistoryCalls).toBe(1);

		stopWorkspaceGitWatcher(state);
		expect(state.watcherStop).toBe(null);
		expect(state.disposables).toHaveLength(0);
	});

	it('stops previous watcher when a new watcher is started on the same state', async () => {
		let unwatchFirst = false;
		const mockGitRun = async () => ({ code: 0, stdout: '.git\n', stderr: '' });
		const mockWatch = () => () => {
			unwatchFirst = true;
		};

		const repo: any = { refreshHistory: async () => true };
		const state: any = {
			workspace: {},
			ownerId: 'git',
			repository: repo,
			disposed: false,
			pending: new Set(),
			disposables: [],
			currentOpenId: 1,
			isActive: () => true
		};
		const origin = { scheme: 'file', path: '/workspace/project', name: 'project' };

		await startWorkspaceGitWatcher(state, origin as any, repo, {
			gitRun: mockGitRun,
			watchDirectory: mockWatch
		});
		expect(state.watcherStop).toBeFunction();

		// Start second watcher
		await startWorkspaceGitWatcher(state, origin as any, repo, {
			gitRun: mockGitRun,
			watchDirectory: () => () => {}
		});

		expect(unwatchFirst).toBe(true);
	});

	it('no-ops when origin scheme is not file', async () => {
		const state: any = {
			workspace: {},
			ownerId: 'git',
			repository: {},
			disposed: false,
			pending: new Set(),
			disposables: [],
			currentOpenId: 1,
			isActive: () => true
		};
		const memoryOrigin = { scheme: 'memory', path: '/workspace/project', name: 'project' };

		await startWorkspaceGitWatcher(state, memoryOrigin as any, state.repository, {
			gitRun: async () => ({ code: 0, stdout: '.git', stderr: '' }),
			watchDirectory: async () => () => {}
		});

		expect(state.watcherStop).toBeUndefined();
		expect(state.disposables).toHaveLength(0);
	});
});



