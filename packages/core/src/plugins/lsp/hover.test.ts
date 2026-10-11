import { describe, expect, it } from 'bun:test';
import { parseServerHover } from './hover';

/**
 * Decoding a `textDocument/hover` reply (spec #280).
 *
 * The hover source reads plain data, so everything the protocol can say has
 * to flatten here or lost — the same pipeline `completions.ts` uses for
 * `documentation`, because resolve fills the same string the hover shows.
 */
describe('parseServerHover', () => {
	it('reads Markdown contents with type, signature and documentation', () => {
		const hover = parseServerHover({
			contents: {
				kind: 'markdown',
				value: '```typescript\n(class) Widget\n```\n\nA thing with an id.'
			}
		});
		expect(hover?.contents).toContain('(class) Widget');
		expect(hover?.contents).toContain('A thing with an id.');
	});

	it('reads a MarkedString array, keeping fenced code blocks intact', () => {
		const hover = parseServerHover({
			contents: [{ language: 'typescript', value: '(class) Widget' }, 'A thing with an id.']
		});
		expect(hover?.contents).toContain('```typescript');
		expect(hover?.contents).toContain('(class) Widget');
		expect(hover?.contents).toContain('A thing with an id.');
	});

	it('hovers to nothing rather than to an error when the server reports nothing', () => {
		for (const reply of [null, undefined, {}, { contents: '' }, { contents: [] }, { contents: { kind: 'markdown', value: '' } }, 'error', 42]) {
			expect(parseServerHover(reply)).toBeNull();
		}
	});

	it('keeps the range when the server names one', () => {
		const hover = parseServerHover({
			contents: 'Widget',
			range: { start: { line: 1, character: 5 }, end: { line: 1, character: 11 } }
		});
		expect(hover?.range).toEqual({
			start: { line: 1, character: 5 },
			end: { line: 1, character: 11 }
		});
	});

	it('drops a range that is not a range', () => {
		const hover = parseServerHover({
			contents: 'Widget',
			range: { start: { line: 'x', character: 1 } }
		});
		expect(hover?.range).toBeNull();
	});
});
