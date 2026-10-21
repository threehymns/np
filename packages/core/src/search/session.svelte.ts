import type { SearchQuery, ReplaceAllUndoEntry } from './types';

export interface SearchTabSessionOptions {
	query?: string;
	isRegex?: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	includePattern?: string;
	excludePattern?: string;
}

export class SearchTabSession {
	query = $state('');
	isRegex = $state(false);
	caseSensitive = $state(false);
	wholeWord = $state(false);
	includePattern = $state('');
	excludePattern = $state('');

	constructor(initial?: SearchTabSessionOptions) {
		if (initial?.query !== undefined) this.query = initial.query;
		if (initial?.isRegex !== undefined) this.isRegex = initial.isRegex;
		if (initial?.caseSensitive !== undefined) this.caseSensitive = initial.caseSensitive;
		if (initial?.wholeWord !== undefined) this.wholeWord = initial.wholeWord;
		if (initial?.includePattern !== undefined) this.includePattern = initial.includePattern;
		if (initial?.excludePattern !== undefined) this.excludePattern = initial.excludePattern;
	}

	get regexError(): string | null {
		if (!this.isRegex || !this.query) return null;
		try {
			new RegExp(this.query);
			return null;
		} catch (e: any) {
			return e.message || 'Invalid regular expression';
		}
	}

	toQuery(): SearchQuery {
		return {
			pattern: this.query,
			isRegex: this.isRegex,
			caseSensitive: this.caseSensitive,
			wholeWord: this.wholeWord,
			includeGlobs: this.includePattern,
			excludeGlobs: this.excludePattern
		};
	}

	toggleRegex(): void {
		this.isRegex = !this.isRegex;
	}

	toggleCaseSensitive(): void {
		this.caseSensitive = !this.caseSensitive;
	}

	toggleWholeWord(): void {
		this.wholeWord = !this.wholeWord;
	}

	/**
	 * The replace-all operations waiting to be undone, most recent last.
	 *
	 * They live with the tab rather than in the tab's component: the
	 * component is mounted only while the tab is showing, and an operation
	 * the user cannot undo after a tab switch is no undo at all.
	 *
	 * The stack is bounded: an operation holds the content of every file it
	 * changed, so an unbounded stack would keep a lot of text alive.
	 */
	replaceAllUndos: ReplaceAllUndoEntry[] = [];
}
