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
