import { describe, expect, it } from 'bun:test';
import {
	formatTypeScriptType,
	prettifyDiagnosticMessage,
	formatDiagnosticEntry,
	isTypeScriptDiagnostic,
	extractTypeScriptErrorCode
} from './ts-diagnostic-formatter';

describe('TypeScript diagnostic formatter', () => {
	describe('formatTypeScriptType', () => {
		it('leaves primitive and simple types inline', () => {
			expect(formatTypeScriptType('string')).toBe('string');
			expect(formatTypeScriptType('number[]')).toBe('number[]');
			expect(formatTypeScriptType('boolean')).toBe('boolean');
			expect(formatTypeScriptType('void')).toBe('void');
			expect(formatTypeScriptType('MyInterface')).toBe('MyInterface');
		});

		it('formats and indents complex object types onto multiple lines', () => {
			const raw = '{ a: string; b: number; }';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toBe('{\n  a: string;\n  b: number;\n}');
		});

		it('formats nested object types with indented sub-levels', () => {
			const raw = '{ user: { id: string; name: string; }; active: boolean; }';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toContain('{\n  user: {\n    id: string;\n    name: string;\n  };');
			expect(formatted).toContain('active: boolean;');
		});

		it('formats union types onto multiple lines when long or complex', () => {
			const raw = 'string | number | boolean | { id: string; value: number; }';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toContain('\n  | ');
			expect(formatted).toContain('id: string;');
		});

		it('formats intersection types onto multiple lines when complex', () => {
			const raw = 'Base & { id: string; active: boolean; } & Timestamp';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toContain('\n  & ');
		});

		it('formats tuples onto multiple lines when containing object types or long', () => {
			const raw = '[string, number, { extra: boolean; details: string; }]';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toContain('[\n  string,');
			expect(formatted).toContain('extra: boolean;');
		});

		it('formats function signatures onto multiple lines when arguments are complex', () => {
			const raw = '(x: string, y: number, z: boolean, options: { debug: boolean; }) => void';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toContain('(\n  x: string,');
			expect(formatted).toContain('=> void');
		});

		it('formats generics and optional properties without extraneous spaces', () => {
			const raw = 'Record<string, { id?: string; count: number; }>';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toContain('Record<\n  string,\n  {\n    id?: string;\n    count: number;\n  }>');
		});

		it('preserves TypeScript truncation markers', () => {
			const raw = '{ a: string; ... 4 more ...; }';
			const formatted = formatTypeScriptType(raw);
			expect(formatted).toContain('... 4 more ...;');
		});
	});

	describe('prettifyDiagnosticMessage', () => {
		it('formats missing property errors into structured bullet lists', () => {
			const msg = "Type 'X' is missing the following properties from type 'Y': foo, bar, baz.";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain('<ul class="cm-lsp-diagnostic-prop-list">');
			expect(result).toContain('<li><code>foo</code></li>');
			expect(result).toContain('<li><code>bar</code></li>');
			expect(result).toContain('<li><code>baz</code></li>');
		});

		it('formats type pairs in diagnostics', () => {
			const msg = "This condition will always return 'false' since the types 'string' and 'number' have no overlap.";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain('types `string` and `number`');
		});

		it('formats type annotations', () => {
			const msg = "Type annotation must be 'string' or 'number'.";
			const result = prettifyDiagnosticMessage(msg);
			expect(result.toLowerCase()).toContain('type annotation must be `string` or `number`');
		});

		it('formats overload diagnostics', () => {
			const msg = "No overload matches this call.\n  Overload 1 of 2, '(x: string): void', gave the following error.";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain('Overload 1 of 2:');
			expect(result).toContain('`(x: string): void`');
		});

		it('formats complex type assignability into code fences', () => {
			const msg = "Type '{ a: string; b: number; }' is not assignable to type '{ b: number; }'.";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain('```ts\n{\n  a: string;\n  b: number;\n}\n```');
			expect(result).toContain('is not assignable to type:');
		});

		it('formats property non-existence and did-you-mean suggestions', () => {
			const msg = "Property 'fistName' does not exist on type 'User'. Did you mean 'firstName'?";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain('Property `fistName` does not exist on type:\n\n`User`');
			expect(result).toContain('Did you mean `firstName`?');
		});

		it('formats missing name diagnostics', () => {
			const msg = "Cannot find name 'fetchUser'. Did you mean 'fetchUsers'?";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain('Cannot find name `fetchUser`. Did you mean `fetchUsers`?');
		});

		it('preserves english contractions without mangling', () => {
			const msg = "Property 'foo' doesn't exist. It's not available and won't work.";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain("`foo`");
			expect(result).toContain("doesn't exist");
			expect(result).toContain("It's not available");
			expect(result).toContain("won't work");
		});

		it('formats nested indented lines as structured sub-containers', () => {
			const msg = "Type 'A' is not assignable to type 'B'.\n  Type 'C' is not assignable to type 'D'.\n    Type 'string' is not assignable to type 'number'.";
			const result = prettifyDiagnosticMessage(msg);
			expect(result).toContain('class="cm-lsp-diagnostic-indent cm-lsp-diagnostic-indent-1"');
			expect(result).toContain('class="cm-lsp-diagnostic-indent cm-lsp-diagnostic-indent-2"');
		});
	});

	describe('formatDiagnosticEntry', () => {
		it('detects TypeScript error with code and generates action links', () => {
			const diag = {
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
				severity: 1 as const,
				source: 'ts',
				code: 2322,
				message: "Type 'string' is not assignable to type 'number'."
			};

			expect(isTypeScriptDiagnostic(diag)).toBe(true);
			expect(extractTypeScriptErrorCode(diag)).toBe('2322');

			const entry = formatDiagnosticEntry(diag);
			expect(entry.isTs).toBe(true);
			expect(entry.code).toBe('2322');
			expect(entry.html).toContain('TS2322');
			expect(entry.html).toContain('cm-lsp-severity-error');
			expect(entry.html).toContain('Error');
			expect(entry.html).toContain('https://typescript.tv/errors/#TS2322');
			expect(entry.html).toContain('https://ts-error-translator.vercel.app/?error=2322');
			expect(entry.html).toContain('title="Explain Error"');
			expect(entry.html).toContain('title="Translate Error"');
		});

		it('renders warning badges for severity 2 diagnostics', () => {
			const diag = {
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
				severity: 2 as const,
				source: 'ts',
				code: 6133,
				message: "'x' is declared but its value is never read."
			};

			const entry = formatDiagnosticEntry(diag);
			expect(entry.html).toContain('cm-lsp-severity-warning');
			expect(entry.html).toContain('Warning');
		});

		it('preserves non-TypeScript diagnostics without TS action links or formatting', () => {
			const diag = {
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
				severity: 1 as const,
				source: 'stub',
				code: 2304,
				message: 'stub server: cannot find name'
			};

			expect(isTypeScriptDiagnostic(diag)).toBe(false);
			const entry = formatDiagnosticEntry(diag);
			expect(entry.isTs).toBe(false);
			expect(entry.html).not.toContain('typescript.tv');
			expect(entry.html).not.toContain('ts-error-translator');
			expect(entry.html).toContain('stub: (2304) stub server: cannot find name');
		});
	});
});
