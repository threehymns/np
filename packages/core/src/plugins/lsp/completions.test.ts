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

	it('keeps the opaque data a resolve round trip sends back', () => {
		const list = parseServerCompletions([
			{ label: 'Widget', data: { file: 'a.ts', id: 7 } }
		]);

		expect(list.items[0].data).toEqual({ file: 'a.ts', id: 7 });
	});
});

describe('mergeResolvedCompletion', () => {
	it('fills documentation and detail immediately, keeping the original range', async () => {
		const { mergeResolvedCompletion, parseServerCompletions } = await import('./completions');
		const [original] = parseServerCompletions([
			{
				label: 'Widget',
				data: { id: 7 },
				textEdit: {
					range: { start: { line: 1, character: 20 }, end: { line: 1, character: 23 } },
					newText: 'Widget'
				}
			}
		]).items;

		const merged = mergeResolvedCompletion(original, {
			label: 'Widget',
			detail: '(class) Widget',
			documentation: { kind: 'markdown', value: 'A thing with an id.' },
			textEdit: {
				range: { start: { line: 1, character: 0 }, end: { line: 1, character: 99 } },
				newText: 'Widget()'
			},
			data: { id: 7 }
		});

		expect(merged.detail).toBe('(class) Widget');
		expect(merged.documentation).toBe('A thing with an id.');
		// Only the text is re-derived; the range stays the anchor the first
		// reply named.
		expect(merged.insertText).toBe('Widget()');
		expect(merged.replaceRange).toEqual(original.replaceRange);
	});

	it('keeps additional edits and command for confirm time rather than applying them', async () => {
		const { mergeResolvedCompletion, parseServerCompletions } = await import('./completions');
		const [original] = parseServerCompletions([{ label: 'Widget', data: 1 }]).items;

		const merged = mergeResolvedCompletion(original, {
			label: 'Widget',
			additionalTextEdits: [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'import' }
			],
			command: { command: 'refactor', arguments: [1] }
		});

		expect(merged.additionalTextEdits).toEqual([
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'import' }
		]);
		expect(merged.command).toEqual({ command: 'refactor', args: [1] });
		// Docs/detail untouched when the resolve carries none.
		expect(merged.documentation).toBe(original.documentation);
	});

	it('leaves the item alone when the resolve cannot be read', async () => {
		const { mergeResolvedCompletion, parseServerCompletions } = await import('./completions');
		const [original] = parseServerCompletions([{ label: 'Widget' }]).items;

		for (const reply of [null, undefined, 'error', 42]) {
			expect(mergeResolvedCompletion(original, reply)).toBe(original);
		}
	});
});
