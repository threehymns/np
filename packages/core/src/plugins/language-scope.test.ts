import { describe, it, expect } from 'bun:test';
import { scopeForLanguage } from './language-scope';

const editorLevel = { words: 'enabled', minWordLength: 3 };

/** The folded value on its own, for the cases that only care about it. */
function value(base: unknown, map: unknown, language: string | null | undefined): any {
	return scopeForLanguage(base, map, language).value;
}

describe('scopeForLanguage', () => {
	it('returns the editor-level values for a language with no override', () => {
		expect(value(editorLevel, {}, 'Markdown')).toEqual(editorLevel);
		expect(value(editorLevel, undefined, 'Markdown')).toEqual(editorLevel);
	});

	it('folds one language override over the editor-level values', () => {
		const map = { Markdown: { words: 'disabled' } };

		expect(value(editorLevel, map, 'Markdown')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
	});

	it('leaves every other language on the editor-level values', () => {
		const map = { Markdown: { words: 'disabled' } };

		// The point of scoping: an override for one language must not leak.
		expect(value(editorLevel, map, 'TypeScript')).toEqual(editorLevel);
	});

	it('keeps the keys the language does not override', () => {
		const map = { TypeScript: { minWordLength: 2 } };

		expect(value(editorLevel, map, 'TypeScript')).toEqual({
			words: 'enabled',
			minWordLength: 2
		});
	});

	it('matches the language key case-insensitively in both directions', () => {
		expect(value(editorLevel, { markdown: { words: 'disabled' } }, 'Markdown')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
		expect(value(editorLevel, { MARKDOWN: { words: 'disabled' } }, 'markdown')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
	});

	it('ignores surrounding whitespace on the language name', () => {
		expect(value(editorLevel, { ' Markdown ': { words: 'disabled' } }, ' Markdown ')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
	});

	it('returns the editor-level values for a document with no language', () => {
		const map = { Markdown: { words: 'disabled' } };

		// Plain text resolves to no language at all, never to Markdown.
		expect(value(editorLevel, map, null)).toEqual(editorLevel);
		expect(value(editorLevel, map, undefined)).toEqual(editorLevel);
		expect(value(editorLevel, map, '   ')).toEqual(editorLevel);
	});

	it('degrades to the editor-level values for a malformed map instead of throwing', () => {
		for (const malformed of [
			null,
			undefined,
			'Markdown',
			42,
			true,
			['Markdown'],
			{ Markdown: 'disabled' },
			{ Markdown: ['disabled'] },
			{ Markdown: null }
		]) {
			expect(value(editorLevel, malformed, 'Markdown')).toEqual(editorLevel);
		}
	});

	it('degrades to the editor-level values when the base value is not an object', () => {
		expect(value(3, { Markdown: { words: 'disabled' } }, 'Markdown')).toBe(3);
		expect(value('enabled', { Markdown: { words: 'disabled' } }, 'Markdown')).toBe('enabled');
	});

	it('leaves the base value untouched', () => {
		const base = { words: 'enabled', minWordLength: 3 };
		scopeForLanguage(base, { Markdown: { words: 'disabled' } }, 'Markdown');

		expect(base).toEqual({ words: 'enabled', minWordLength: 3 });
	});

	it('reports which keys the language supplied', () => {
		// The key list is what tells "this language has no opinion about this
		// setting" from "this language said the same thing the default said".
		// Both arrive as the same value, and prose silence needs them apart to
		// be a *default*.
		expect(
			scopeForLanguage(editorLevel, { Markdown: { words: 'enabled' } }, 'Markdown')
		).toEqual({ value: editorLevel, keys: ['words'] });
		expect(
			scopeForLanguage(editorLevel, { Markdown: { words: 'disabled' } }, 'Markdown')
		).toEqual({ value: { words: 'disabled', minWordLength: 3 }, keys: ['words'] });
		expect(scopeForLanguage(editorLevel, {}, 'Markdown')).toEqual({
			value: editorLevel,
			keys: []
		});
		// An entry that tuned only the threshold did not rule on `words`.
		expect(
			scopeForLanguage(editorLevel, { Markdown: { minWordLength: 5 } }, 'Markdown')
		).toEqual({ value: { words: 'enabled', minWordLength: 5 }, keys: ['minWordLength'] });
		expect(
			scopeForLanguage(editorLevel, { TypeScript: { words: 'disabled' } }, 'Markdown').keys
		).toEqual([]);
	});

	it('reports no keys for every input it degrades on', () => {
		// Otherwise a hand-edited map that resolved to nothing would read as
		// permission from the language, and a default would be overwritten by a
		// malformed file.
		for (const malformed of [null, 'Markdown', ['Markdown'], { Markdown: 'disabled' }]) {
			expect(scopeForLanguage(editorLevel, malformed, 'Markdown').keys).toEqual([]);
		}
		expect(
			scopeForLanguage(editorLevel, { Markdown: { words: 'disabled' } }, null).keys
		).toEqual([]);
	});
});
