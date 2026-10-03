import { describe, it, expect } from 'bun:test';
import { resolveLanguageScoped } from './language-scope';

const editorLevel = { words: 'enabled', minWordLength: 3 };

describe('resolveLanguageScoped', () => {
	it('returns the editor-level values for a language with no override', () => {
		expect(resolveLanguageScoped(editorLevel, {}, 'Markdown')).toEqual(editorLevel);
		expect(resolveLanguageScoped(editorLevel, undefined, 'Markdown')).toEqual(editorLevel);
	});

	it('folds one language override over the editor-level values', () => {
		const map = { Markdown: { words: 'disabled' } };

		expect(resolveLanguageScoped(editorLevel, map, 'Markdown')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
	});

	it('leaves every other language on the editor-level values', () => {
		const map = { Markdown: { words: 'disabled' } };

		// The point of scoping: an override for one language must not leak.
		expect(resolveLanguageScoped(editorLevel, map, 'TypeScript')).toEqual(editorLevel);
	});

	it('keeps the keys the language does not override', () => {
		const map = { TypeScript: { minWordLength: 2 } };

		expect(resolveLanguageScoped(editorLevel, map, 'TypeScript')).toEqual({
			words: 'enabled',
			minWordLength: 2
		});
	});

	it('matches the language key case-insensitively in both directions', () => {
		expect(resolveLanguageScoped(editorLevel, { markdown: { words: 'disabled' } }, 'Markdown')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
		expect(resolveLanguageScoped(editorLevel, { MARKDOWN: { words: 'disabled' } }, 'markdown')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
	});

	it('ignores surrounding whitespace on the language name', () => {
		expect(resolveLanguageScoped(editorLevel, { ' Markdown ': { words: 'disabled' } }, ' Markdown ')).toEqual({
			words: 'disabled',
			minWordLength: 3
		});
	});

	it('returns the editor-level values for a document with no language', () => {
		const map = { Markdown: { words: 'disabled' } };

		// Plain text resolves to no language at all, never to Markdown.
		expect(resolveLanguageScoped(editorLevel, map, null)).toEqual(editorLevel);
		expect(resolveLanguageScoped(editorLevel, map, undefined)).toEqual(editorLevel);
		expect(resolveLanguageScoped(editorLevel, map, '   ')).toEqual(editorLevel);
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
			expect(resolveLanguageScoped(editorLevel, malformed, 'Markdown')).toEqual(editorLevel);
		}
	});

	it('degrades to the editor-level values when the base value is not an object', () => {
		expect(resolveLanguageScoped(3, { Markdown: { words: 'disabled' } }, 'Markdown')).toBe(3);
		expect(resolveLanguageScoped('enabled', { Markdown: { words: 'disabled' } }, 'Markdown')).toBe('enabled');
	});

	it('leaves the base value untouched', () => {
		const base = { words: 'enabled', minWordLength: 3 };
		resolveLanguageScoped(base, { Markdown: { words: 'disabled' } }, 'Markdown');

		expect(base).toEqual({ words: 'enabled', minWordLength: 3 });
	});
});