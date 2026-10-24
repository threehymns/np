import type {
	FileOrigin,
	VCSAdapter,
	VCSStatus,
	SwitchResult,
	GitChange,
	GitCommit,
	GitHistoryCommit,
	FileDiffDetail,
	GetFileDiffOptions
} from '@np/core';
import type { IsomorphicGitAdapter } from './isomorphic-git';

type AdapterLoader = () => Promise<IsomorphicGitAdapter>;

/**
 * A VCSAdapter that resolves the real browser git adapter on first use.
 *
 * `VCSAdapter`'s factory is synchronous, and `Repository` calls it while the
 * app boots. Constructing this wrapper keeps boot free of `isomorphic-git`
 * while preserving the adapter contract: every method awaits the dynamic
 * import and then delegates. `fs` is exposed for the e2e helpers, which read
 * it after a repository refresh has already forced the load.
 */
export class LazyIsomorphicGitAdapter implements VCSAdapter {
	private inner: IsomorphicGitAdapter | null = null;
	private loading: Promise<IsomorphicGitAdapter> | null = null;

	private readonly load: AdapterLoader;

	constructor(private readonly rootOrigin: FileOrigin, load?: AdapterLoader) {
		this.load = load ?? (() => loadDefault(this.rootOrigin));
	}

	private async get(): Promise<IsomorphicGitAdapter> {
		if (this.inner) return this.inner;
		this.loading ??= this.load().then((adapter) => {
			this.inner = adapter;
			return adapter;
		});
		return this.loading;
	}

	/** Read by `tests/e2e/helpers/mock-diff-repo.ts` after `repository.refresh()`. */
	get fs(): unknown {
		return (this.inner as any)?.fs;
	}

	async detect(rootPath: string): Promise<boolean> {
		return (await this.get()).detect(rootPath);
	}

	async init(rootPath?: string): Promise<void> {
		return (await this.get()).init(rootPath);
	}

	async getCurrentBranch(): Promise<string | null> {
		return (await this.get()).getCurrentBranch();
	}

	async getBranches(): Promise<string[]> {
		return (await this.get()).getBranches();
	}

	async getStatus(): Promise<VCSStatus> {
		return (await this.get()).getStatus();
	}

	async switchBranch(branchName: string, options?: { dryRun?: boolean }): Promise<SwitchResult> {
		return (await this.get()).switchBranch(branchName, options);
	}

	async getChanges(): Promise<GitChange[]> {
		return (await this.get()).getChanges();
	}

	async getCommits(): Promise<GitCommit[]> {
		return (await this.get()).getCommits();
	}

	async getHistory(options?: { branch?: string | null; maxCount?: number }): Promise<GitHistoryCommit[]> {
		return (await this.get()).getHistory(options);
	}

	async getAheadCount(branch?: string | null): Promise<number> {
		return (await this.get()).getAheadCount(branch);
	}

	async getFileDiff(filepath: string, options?: GetFileDiffOptions): Promise<FileDiffDetail> {
		return (await this.get()).getFileDiff(filepath, options);
	}

	async stageFile(filepath: string): Promise<void> {
		return (await this.get()).stageFile(filepath);
	}

	async unstageFile(filepath: string): Promise<void> {
		return (await this.get()).unstageFile(filepath);
	}

	async discardChanges(filepath: string, options?: { staged?: boolean }): Promise<void> {
		return (await this.get()).discardChanges(filepath, options);
	}

	async stageAll(): Promise<void> {
		return (await this.get()).stageAll();
	}

	async unstageAll(): Promise<void> {
		return (await this.get()).unstageAll();
	}

	async discardAll(): Promise<void> {
		return (await this.get()).discardAll();
	}

	async commit(message: string, options?: { author?: { name: string; email: string }; amend?: boolean }): Promise<void> {
		return (await this.get()).commit(message, options);
	}

	async createBranch(branchName: string): Promise<void> {
		return (await this.get()).createBranch(branchName);
	}

	async getUserConfig(): Promise<{ name: string; email: string } | null> {
		return (await this.get()).getUserConfig();
	}

	async updateIndexContent(filepath: string, content: string): Promise<void> {
		return (await this.get()).updateIndexContent(filepath, content);
	}

	async updateFileContent(filepath: string, content: string): Promise<void> {
		return (await this.get()).updateFileContent(filepath, content);
	}
}

async function loadDefault(origin: FileOrigin): Promise<IsomorphicGitAdapter> {
	await import('./polyfills');
	const { IsomorphicGitAdapter } = await import('./isomorphic-git');
	return new IsomorphicGitAdapter(origin);
}
