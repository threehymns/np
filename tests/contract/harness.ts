import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll as bunAfterAll, describe as bunDescribe, test as bunTest } from 'bun:test';
import type { GitFileAccess } from '../../apps/desktop/src/renderer/SpawnGitAdapter';

export interface GitOutput {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GitFloor {
	major: number;
	minor: number;
}

export interface GitVersion extends GitFloor {
	patch: number;
	raw: string;
}

export const GIT_FLOOR: GitFloor = Object.freeze({ major: 2, minor: 23 });

export const TEST_IDENTITY = Object.freeze({ name: 'Contract Test', email: 'contract@test.invalid' });

export interface PorcelainEntry {
	x: string;
	y: string;
	path: string;
	origPath?: string;
}

/** Spawn real `git` in `cwd` with a hermetic environment; the runner the contract suite hands adapters. */
export function runGit(cwd: string, env: Record<string, string>, args: string[]): Promise<GitOutput> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => (stdout += chunk));
		child.stderr.on('data', chunk => (stderr += chunk));
		child.on('error', err => reject(new Error(`Failed to spawn git: ${err.message}`)));
		child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

/**
 * Environment for hermetic git invocations: system/global/user config disabled via
 * `HOME` redirection plus `GIT_CONFIG_NOSYSTEM` (with `GIT_CONFIG_GLOBAL` pinned to
 * an isolated, nonexistent file in the temp home so a developer's global config can
 * never leak in), commit identity supplied through `GIT_AUTHOR_*`/`GIT_COMMITTER_*`,
 * and developer-set git override variables scrubbed.
 */
export function gitEnv(homePath: string): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	delete env.GIT_CONFIG;
	delete env.GIT_CONFIG_SYSTEM;
	delete env.GIT_CONFIG_COUNT;
	delete env.XDG_CONFIG_HOME;
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_OBJECT_DIRECTORY;
	delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	delete env.GIT_AUTHOR_NAME;
	delete env.GIT_AUTHOR_EMAIL;
	delete env.GIT_COMMITTER_NAME;
	delete env.GIT_COMMITTER_EMAIL;
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: join(homePath, '.gitconfig'),
		HOME: homePath,
		GIT_TERMINAL_PROMPT: '0',
		GIT_AUTHOR_NAME: TEST_IDENTITY.name,
		GIT_AUTHOR_EMAIL: TEST_IDENTITY.email,
		GIT_COMMITTER_NAME: TEST_IDENTITY.name,
		GIT_COMMITTER_EMAIL: TEST_IDENTITY.email
	};
}

/**
 * A fresh throwaway repository. Every test gets its own instance — repositories are
 * never shared or reused, and `cleanup()` removes the whole temp tree.
 */
export class TestRepo {
	constructor(
		readonly root: string,
		readonly path: string,
		readonly env: Record<string, string>
	) {}

	git(args: string[]): Promise<GitOutput> {
		return runGit(this.path, this.env, args);
	}

	async write(relPath: string, content: string): Promise<void> {
		const target = join(this.path, relPath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, 'utf8');
	}

	async read(relPath: string): Promise<string | null> {
		try {
			return await readFile(join(this.path, relPath), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	}

	async cleanup(): Promise<void> {
		await rm(this.root, { recursive: true, force: true });
	}
}

/**
 * Create a fresh throwaway repository: isolated temp home, `git init`, and a
 * deterministic `main` branch selected via `symbolic-ref` on every git version.
 */
export async function createTestRepo(): Promise<TestRepo> {
	const root = await mkdtemp(join(tmpdir(), 'np-contract-'));
	const path = join(root, 'repo');
	const home = join(root, 'home');
	await mkdir(path);
	await mkdir(home);
	const repo = new TestRepo(root, path, gitEnv(home));
	try {
		const init = await repo.git(['init', '-q']);
		if (init.code !== 0) {
			throw new Error(`git init failed: ${init.stderr}`);
		}
		const ref = await repo.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
		if (ref.code !== 0) {
			throw new Error(`Failed to set default branch: ${ref.stderr}`);
		}
		return repo;
	} catch (error) {
		await repo.cleanup();
		throw error;
	}
}

const registeredRepos: TestRepo[] = [];

bunAfterAll(async () => {
	await Promise.all(registeredRepos.map(repo => repo.cleanup()));
});

/** Like `createTestRepo`, but registers the repository for cleanup at suite end. */
export async function createTrackedRepo(): Promise<TestRepo> {
	const repo = await createTestRepo();
	registeredRepos.push(repo);
	return repo;
}

/** Create an empty commit on the default branch so HEAD resolves to a real branch. */
export async function seedCommit(repo: TestRepo): Promise<void> {
	const res = await repo.git(['commit', '--allow-empty', '-m', 'seed']);
	if (res.code !== 0) {
		throw new Error(`git commit --allow-empty failed: ${res.stderr}`);
	}
}

let cachedVersion: Promise<GitVersion> | null = null;

async function detectGitVersion(): Promise<GitVersion> {
	const res = await runGit(process.cwd(), process.env as Record<string, string>, ['--version']);
	if (res.code !== 0) {
		throw new Error(`Contract suite requires real git; 'git --version' failed: ${res.stderr || 'git not found'}`);
	}
	const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(res.stdout.trim());
	if (!match) {
		throw new Error(`Cannot parse git version from output: ${res.stdout.trim()}`);
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		raw: res.stdout.trim()
	};
}

export function gitVersion(): Promise<GitVersion> {
	if (!cachedVersion) {
		cachedVersion = detectGitVersion();
	}
	return cachedVersion;
}

export function atLeastGit(version: GitVersion, floor: GitFloor = GIT_FLOOR): boolean {
	return version.major > floor.major || (version.major === floor.major && version.minor >= floor.minor);
}

/** Null when the installed git satisfies the floor, otherwise a human-readable skip reason. */
export async function gitFloorSkipReason(floor: GitFloor = GIT_FLOOR): Promise<string | null> {
	const version = await gitVersion();
	if (atLeastGit(version, floor)) return null;
	return `requires git >= ${floor.major}.${floor.minor}.0 (found ${version.raw})`;
}

const defaultSkipReason = await gitFloorSkipReason();

if (defaultSkipReason) {
	console.warn(`[contract harness] ${defaultSkipReason} — contract suite provider unavailable`);
}

/** `describe` bound to the git version floor: the whole suite skips below git 2.23 with a clear reason. */
export const describe = defaultSkipReason ? bunDescribe.skipIf(true, defaultSkipReason) : bunDescribe;

/** `it` bound to the git version floor: each test skips below git 2.23 with a clear reason. */
export const it = defaultSkipReason ? bunTest.skipIf(true, defaultSkipReason) : bunTest;

/** Index contents for a path (`git show :path`), or null when the path has no index entry. */
export async function indexContents(repo: TestRepo, relPath: string): Promise<string | null> {
	const res = await repo.git(['show', `:${relPath}`]);
	return res.code === 0 ? res.stdout : null;
}

/** Worktree contents for a path, or null when the file does not exist on disk. */
export async function worktreeContents(repo: TestRepo, relPath: string): Promise<string | null> {
	return repo.read(relPath);
}

/** Porcelain v1 status (`-z -uall`), NUL-parsed exactly like the adapters parse it. */
export async function porcelainStatus(repo: TestRepo): Promise<PorcelainEntry[]> {
	const res = await repo.git(['status', '--porcelain=v1', '-z', '-uall']);
	if (res.code !== 0) {
		throw new Error(`git status failed: ${res.stderr}`);
	}
	const entries: PorcelainEntry[] = [];
	const tokens = res.stdout.split('\0');
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token || token.length < 3) continue;
		const x = token[0];
		const y = token[1];
		const path = token.substring(3);
		let origPath: string | undefined;
		if (x === 'R' || y === 'R') {
			origPath = tokens[++i];
		} else if (x === 'C' || y === 'C') {
			i++;
		}
		entries.push({ x, y, path, origPath });
	}
	return entries;
}

/** Paths tracked in the index (`git ls-files`). */
export async function lsFiles(repo: TestRepo): Promise<string[]> {
	const res = await repo.git(['ls-files']);
	if (res.code !== 0) {
		throw new Error(`git ls-files failed: ${res.stderr}`);
	}
	return res.stdout.split('\n').filter(Boolean);
}

export async function currentBranch(repo: TestRepo): Promise<string | null> {
	const res = await repo.git(['symbolic-ref', '--short', 'HEAD']);
	if (res.code === 0) {
		const branch = res.stdout.trim();
		return branch || null;
	}
	const fallback = await repo.git(['rev-parse', '--abbrev-ref', 'HEAD']);
	const branch = fallback.stdout.trim();
	return fallback.code === 0 && branch !== 'HEAD' ? branch : null;
}

/** Author of the most recent commit, or null when the repository has no commits. */
export async function headAuthor(repo: TestRepo): Promise<{ name: string; email: string } | null> {
	const res = await repo.git(['log', '-1', '--format=%an|%ae']);
	if (res.code !== 0) return null;
	const [name, email] = res.stdout.trim().split('|');
	return { name, email: email ?? '' };
}

/** Run git in the repository and throw with the command and stderr on any non-zero exit. */
export async function checkedGit(repo: TestRepo, args: string[]): Promise<GitOutput> {
	const res = await repo.git(args);
	if (res.code !== 0) {
		throw new Error(`git ${args.join(' ')} failed (exit ${res.code}): ${res.stderr}`);
	}
	return res;
}

/** Check out an existing branch in the repository, throwing on any non-zero exit. */
export async function checkoutBranch(repo: TestRepo, branch: string): Promise<void> {
	await checkedGit(repo, ['checkout', branch]);
}

/** node:fs-backed `GitFileAccess` for SpawnGitAdapter engines in the contract suite. */
export const nodeFileAccess: GitFileAccess = {
	readFile: (filePath) => readFile(filePath),
	writeFile: (filePath, content) => writeFile(filePath, content),
	deleteEntry: (filePath) => rm(filePath, { force: true })
};