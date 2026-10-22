import type { SearchQuery } from './types';

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
}
