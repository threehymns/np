import type { GitHistoryCommit } from '@np/core';
import type { ClipboardService } from '@np/core/state.svelte';

export type HistoryAction = 'copyShortSha' | 'copySha' | 'copySubject';

export const defaultClipboardService: ClipboardService = {
	writeText: async (text: string) => {
		if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
			throw new Error('Clipboard API is unavailable');
		}
		await navigator.clipboard.writeText(text);
	},
	readText: async () => {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
			return await navigator.clipboard.readText();
		}
		return '';
	}
};

/**
 * Executes a clipboard copy action for a git history commit entry.
 */
export async function runHistoryAction(
	action: HistoryAction,
	commit: GitHistoryCommit,
	clipboard: ClipboardService = defaultClipboardService
): Promise<boolean> {
	if (!clipboard?.writeText) {
		console.warn('Clipboard service unavailable');
		return false;
	}

	try {
		if (action === 'copyShortSha') {
			if (!commit.shortSha) return false;
			await clipboard.writeText(commit.shortSha);
			return true;
		}
		if (action === 'copySha') {
			if (!commit.sha) return false;
			await clipboard.writeText(commit.sha);
			return true;
		}
		if (action === 'copySubject') {
			await clipboard.writeText(commit.subject ?? '');
			return true;
		}
		return false;
	} catch (err) {
		console.error(`Failed to execute history action "${action}":`, err);
		return false;
	}
}

/**
 * Handles keyboard events on history commit rows.
 * Enter is reserved as a no-op for the v2 commit detail page.
 */
export function handleHistoryKeyDown(event: KeyboardEvent): boolean {
	if (event.key === 'Enter') {
		event.preventDefault();
		event.stopPropagation?.();
		return true;
	}
	return false;
}
