import { describe, expect, it } from 'bun:test';
import { flattenMarkup, parseServerCompletions } from './completions';

/**
 * Decoding a `textDocument/completion` reply (spec #263).
 *
 * The source on the other side of the package boundary reads plain data, so
 * everything the protocol can say has to be flattened here or lost: a markup
 * union that survives the crossing intact is a CodeMirror `info` that renders.
 */
describe('parseServerCompletions', () => {
	it('reads a CompletionList with a signature and JSDoc', () => {
		const list = parseServerCompletions({
			isIncomplete: true,
			items: [
				{
					label: 'Widget',
					kind: 7,
					detail: '(class) Widget',
					documentation: { kind: 'markdown', value: 'A thing with an id.' }
				}
			]
		});

		expect(list.incomplete).toBe(true);
		expect(list.items).toEqual([
			{
				label: 'Widget',
				insertText: 'Widget',
				detail: '(class) Widget',
				documentation: 'A thing with an id.',
				kind: 7,
				replaceRange: null
			}
		]);
	});

	it('reads a bare CompletionItem[] as well, since the shape is the server’s choice', () => {
		const list = parseServerCompletions([{ label: 'widge', insertText: 'widget' }]);

		expect(list.incomplete).toBe(false);
		expect(list.items[0].label).toBe('widge');
		expect(list.items[0].insertText).toBe('widget');
	});

	it('flattens every markup shape the protocol allows into one string', () => {
		expect(flattenMarkup('plain')).toBe('plain');
		expect(flattenMarkup({ kind: 'markdown', value: '# Heading' })).toBe('# Heading');
		expect(flattenMarkup(['one', { language: 'ts', value: 'two' }])).toBe('one\n\ntwo');
		expect(flattenMarkup([])).toBeNull();
		expect(flattenMarkup(undefined)).toBeNull();
		expect(flattenMarkup({})).toBeNull();
		expect(flattenMarkup('')).toBeNull();
	});

	it('keeps the range a named text edit replaces, which replace_range needs', () => {
		const list = parseServerCompletions([
			{
				label: 'widgetId',
				textEdit: {
					range: {
						start: { line: 3, character: 20 },
						end: { line: 3, character: 23 }
					},
					newText: 'widgetId'
				}
			}
		]);

		expect(list.items[0].replaceRange).toEqual({
			start: { line: 3, character: 20 },
			end: { line: 3, character: 23 }
		});
		// A range and a `newText` travel together: the text edit is what replaces
		// the range, so its text is what lands.
		expect(list.items[0].insertText).toBe('widgetId');
	});

	it('drops an item CodeMirror could never match', () => {
		// Options are filtered by label, so an item without one is invisible to
		// the popover however much text it carries.
		const list = parseServerCompletions([
			{ insertText: 'orphan' },
			{ label: '' },
			{ label: 'kept' },
			'not an object',
			null
		]);

		expect(list.items.map((item) => item.label)).toEqual(['kept']);
	});

	it('returns an empty list rather than throwing on a reply it cannot read', () => {
		for (const reply of [undefined, null, 'error', { items: 'nope' }, 42]) {
			expect(parseServerCompletions(reply)).toEqual({ items: [], incomplete: false });
		}
	});

	it('ignores a text edit range that is not a range', () => {
		const list = parseServerCompletions([
			{ label: 'a', textEdit: { range: { start: { line: 'x', character: 1 } }, newText: 'b' } },
			{ label: 'c', textEdit: { newText: 'd' } }
		]);

		// `replace_range` degrades to the suffix for these rather than replacing an
		// unknown range.
		expect(list.items.map((item) => item.replaceRange)).toEqual([null, null]);
	});
});
