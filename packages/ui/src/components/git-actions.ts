import type { AppState } from '@np/core/state.svelte';
import { resolveDiscardOptions } from '@np/core';

export type GitFileAction = 'stage' | 'unstage' | 'discard' | 'diff' | 'open';

/**
 * Applies a git action to a file, expanding to every selected path when the
 * target file is part of the current multi-selection.
 */
export async function runGitAction(
	appState: AppState,
	action: GitFileAction,
	filepath: string,
	opts: { isStaged: boolean; selectedPaths?: Set<string> }
): Promise<void> {
	if (action === 'diff') {
		appState.commands.execute('git.openDiff', filepath);
		return;
	}
	if (action === 'open') {
		appState.commands.execute('file.open', filepath);
		return;
	}

	const changes = appState.workspace.repository?.changes;
	const targets = opts.selectedPaths?.has(filepath) ? Array.from(opts.selectedPaths) : [filepath];
	for (const path of targets) {
		if (action === 'discard') {
			const options = resolveDiscardOptions(path, opts.isStaged, changes);
			const success = await appState.commands.execute('git.discard', path, options);
			if (!success) break;
		} else {
			await appState.commands.execute(`git.${action}`, path);
		}
	}
}

/**
 * Manages empty-state repository initialization lifecycle, busy / loading states,
 * error presentation, retry capabilities, and folder/permission gating.
 */
export class GitInitController {
	isInitializing = $state(false);
	error = $state<string | null>(null);

	constructor(private getAppState: () => AppState) {}

	get canInitialize(): boolean {
		const appState = this.getAppState();
		return Boolean(appState?.workspace?.rootOrigin && appState?.workspace?.hasRootPermission);
	}

	async initialize(): Promise<boolean> {
		if (this.isInitializing) return false;
		if (!this.canInitialize) return false;

		this.isInitializing = true;
		this.error = null;

		try {
			const appState = this.getAppState();
			const success = await appState.workspace.initializeRepository();
			if (!success && !appState.workspace.repository) {
				this.error = 'Failed to initialize repository';
				return false;
			}
			return Boolean(success);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			return false;
		} finally {
			this.isInitializing = false;
		}
	}

	retry(): Promise<boolean> {
		return this.initialize();
	}

	reset(): void {
		this.isInitializing = false;
		this.error = null;
	}
}
