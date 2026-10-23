import type { LspDiagnostic, LspDiagnosticSeverity } from './diagnostics';
import { marked } from 'marked';
import { sanitizeHtml } from '../../transformer/sanitize';

/**
 * Tagged template literal helper that allows template strings to receive
 * full HTML syntax highlighting, formatting, and Emmet in editors
 * (VS Code, Zed, Cursor, Neovim Treesitter, WebStorm).
 */
const html = String.raw;

/**
 * TypeScript diagnostic formatter for hover tooltips.
 *
 * Implements high-impact parity with `yoavbls/pretty-ts-errors`:
 * 1. Prettified Types & Multi-line Indentation (objects, generics, unions, intersections, tuples, function signatures)
 * 2. Missing property bullet lists
 * 3. Overloads, missing names, property non-existence, and type-argument diagnostics
 * 4. Rich Header with Error/Warning severity badges, TS code, and Action links
 *    ("Explain" -> typescript.tv, "Translate" -> ts-error-translator)
 */

export interface FormattedDiagnosticResult {
	readonly html: string;
	readonly rawText: string;
	readonly isTypeScript: boolean;
	readonly errorCode?: string;
}

const TS_SOURCES = new Set(['ts', 'typescript', 'deno-ts']);

/**
 * Checks if a diagnostic originates from TypeScript.
 */
export function isTypeScriptDiagnostic(diagnostic: LspDiagnostic): boolean {
	if (diagnostic.source) {
		const src = diagnostic.source.toLowerCase();
		if (TS_SOURCES.has(src)) return true;
		// Non-TS servers (eslint, stub, pyright, rust-analyzer, etc.)
		return false;
	}
	if (typeof diagnostic.code === 'number' && diagnostic.code >= 1000 && diagnostic.code < 90000) {
		return true;
	}
	if (typeof diagnostic.code === 'string' && /^TS\d+/i.test(diagnostic.code)) {
		return true;
	}
	if (/^ts:\s*\(\d+\)/i.test(diagnostic.message) || /\bTS\d{4,5}\b/.test(diagnostic.message)) {
		return true;
	}
	return false;
}

/**
 * Extracts a numeric TypeScript error code (e.g. '2322' from 2322 or 'TS2322').
 */
export function extractTypeScriptErrorCode(diagnostic: LspDiagnostic): string | undefined {
	if (diagnostic.code != null) {
		const raw = String(diagnostic.code).replace(/^TS/i, '').trim();
		if (/^\d{4,5}$/.test(raw)) return raw;
	}
	const match = diagnostic.message.match(/(?:ts:\s*\(|TS|\bTS)(\d{4,5})\b/i);
	return match ? match[1] : undefined;
}

/**
 * Formats a TypeScript type string with multi-line indentation if complex.
 */
export function formatTypeScriptType(typeStr: string, { maxLineLength = 50 }: { maxLineLength?: number } = {}): string {
	const trimmed = typeStr.trim();
	if (!trimmed) return '';

	// Simple types stay single-line
	if (/^(void|null|undefined|any|unknown|never|number|string|boolean|bigint|symbol|object)(\[\])*$/.test(trimmed)) {
		return trimmed;
	}
	if (/^[A-Za-z_$][A-Za-z0-9_$]*(\[\])*$/.test(trimmed)) {
		return trimmed;
	}

	// Tokenize
	const tokens: Array<{ type: string; value: string }> = [];
	let i = 0;
	while (i < trimmed.length) {
		const char = trimmed[i];

		// String literals
		if (char === '"' || char === "'") {
			const quote = char;
			let str = quote;
			i++;
			while (i < trimmed.length && trimmed[i] !== quote) {
				if (trimmed[i] === '\\') {
					str += trimmed[i++];
				}
				str += trimmed[i++];
			}
			if (i < trimmed.length) str += trimmed[i++];
			tokens.push({ type: 'string', value: str });
			continue;
		}

		// Truncation markers
		if (trimmed.startsWith('... ', i) || trimmed.startsWith('...;', i) || trimmed.startsWith('...', i)) {
			const match = trimmed.slice(i).match(/^(\.\.\.\s*\d*\s*more\s*\.\.\.;?|\.\.\.;?|\.\.\.)/);
			if (match) {
				tokens.push({ type: 'truncation', value: match[1] });
				i += match[1].length;
				continue;
			}
		}

		// Arrow
		if (trimmed.startsWith('=>', i)) {
			tokens.push({ type: 'arrow', value: '=>' });
			i += 2;
			continue;
		}

		// Brackets and delimiters
		if ('{}[]()<>;,:|&?'.includes(char)) {
			tokens.push({ type: char, value: char });
			i++;
			continue;
		}

		// Whitespace
		if (/\s/.test(char)) {
			let ws = '';
			while (i < trimmed.length && /\s/.test(trimmed[i])) {
				ws += trimmed[i++];
			}
			tokens.push({ type: 'ws', value: ws });
			continue;
		}

		// Words / identifiers / numbers / operators
		let word = '';
		while (i < trimmed.length && !'{}[]()<>;,:|&?"\'\\'.includes(trimmed[i]) && !/\s/.test(trimmed[i])) {
			word += trimmed[i++];
		}
		if (word) {
			tokens.push({ type: 'word', value: word });
		} else if (i < trimmed.length) {
			tokens.push({ type: 'word', value: trimmed[i++] });
		}
	}

	// Decide if multiline
	let shouldBeMultiline = trimmed.length > maxLineLength;
	let objectPropsCount = 0;
	let hasNestedBraces = false;
	let braceDepth = 0;
	for (const t of tokens) {
		if (t.type === '{') {
			braceDepth++;
			if (braceDepth > 1) hasNestedBraces = true;
		} else if (t.type === '}') {
			braceDepth--;
		} else if (t.type === ';' && braceDepth === 1) {
			objectPropsCount++;
		}
	}
	if (objectPropsCount > 1 || hasNestedBraces) {
		shouldBeMultiline = true;
	}

	if (!shouldBeMultiline && !trimmed.includes('\n')) {
		return trimmed.replace(/\s+/g, ' ');
	}

	let out = '';
	let indent = 0;
	const pad = () => '  '.repeat(indent);
	const stack: string[] = [];

	for (let k = 0; k < tokens.length; k++) {
		const t = tokens[k];

		if (t.type === 'ws') {
			continue;
		}

		if (t.type === '{') {
			out += '{\n';
			indent++;
			stack.push('{');
			out += pad();
		} else if (t.type === '}') {
			if (stack[stack.length - 1] === '{') stack.pop();
			indent = Math.max(0, indent - 1);
			if (out.endsWith('  ')) {
				out = out.slice(0, -2);
			} else if (!out.endsWith('\n')) {
				out += '\n' + pad();
			}
			out += '}';
			const next = tokens.slice(k + 1).find((x) => x.type !== 'ws');
			if (next && (next.type === 'arrow' || next.type === 'word')) {
				out += ' ';
			}
		} else if (t.type === ';') {
			out += ';';
			if (stack[stack.length - 1] === '{') {
				let nextNonWs: { type: string; value: string } | null = null;
				for (let j = k + 1; j < tokens.length; j++) {
					if (tokens[j].type !== 'ws') { nextNonWs = tokens[j]; break; }
				}
				if (nextNonWs && nextNonWs.type !== '}') {
					out += '\n' + pad();
				}
			} else {
				out += ' ';
			}
		} else if (t.type === ',') {
			out += ', ';
			if ((stack[stack.length - 1] === '[' || stack[stack.length - 1] === '(' || stack[stack.length - 1] === '<') && shouldBeMultiline) {
				out = out.trimEnd() + '\n' + pad();
			}
		} else if (t.type === ':') {
			out += ': ';
		} else if (t.type === '?') {
			out += '?';
		} else if (t.type === 'arrow' || t.type === '=>') {
			if (!out.endsWith(' ') && !out.endsWith('\n')) out += ' ';
			out += '=> ';
		} else if (t.type === '|') {
			if (stack.length === 0 && shouldBeMultiline) {
				out += '\n  | ';
			} else {
				out += ' | ';
			}
		} else if (t.type === '&') {
			if (stack.length === 0 && shouldBeMultiline) {
				out += '\n  & ';
			} else {
				out += ' & ';
			}
		} else if (t.type === '<') {
			stack.push('<');
			out += '<';
			if (shouldBeMultiline && (trimmed.includes('{') || tokens.filter((x) => x.type === ',').length > 2)) {
				indent++;
				out += '\n' + pad();
			}
		} else if (t.type === '>') {
			if (stack[stack.length - 1] === '<') stack.pop();
			if (out.endsWith('\n  ')) {
				indent = Math.max(0, indent - 1);
				out = out.slice(0, -2) + '>';
			} else {
				out += '>';
			}
			const next = tokens.slice(k + 1).find((x) => x.type !== 'ws');
			if (next && (next.type === 'arrow' || next.type === 'word')) {
				out += ' ';
			}
		} else if (t.type === '[') {
			stack.push('[');
			out += '[';
			if (shouldBeMultiline && (tokens.filter((x) => x.type === ',').length > 1 || trimmed.includes('{'))) {
				indent++;
				out += '\n' + pad();
			}
		} else if (t.type === ']') {
			if (stack[stack.length - 1] === '[') stack.pop();
			if (out.endsWith('\n  ')) {
				indent = Math.max(0, indent - 1);
				out = out.slice(0, -2) + ']';
			} else {
				out += ']';
			}
			const next = tokens.slice(k + 1).find((x) => x.type !== 'ws');
			if (next && (next.type === 'arrow' || next.type === 'word')) {
				out += ' ';
			}
		} else if (t.type === '(') {
			stack.push('(');
			out += '(';
			if (shouldBeMultiline && tokens.filter((x) => x.type === ':').length > 2) {
				indent++;
				out += '\n' + pad();
			}
		} else if (t.type === ')') {
			if (stack[stack.length - 1] === '(') stack.pop();
			if (out.endsWith('\n  ')) {
				indent = Math.max(0, indent - 1);
				out = out.slice(0, -2) + ')';
			} else {
				out += ')';
			}
			const next = tokens.slice(k + 1).find((x) => x.type !== 'ws');
			if (next && (next.type === 'arrow' || next.type === 'word')) {
				out += ' ';
			}
		} else {
			const prev = tokens.slice(0, k).reverse().find((x) => x.type !== 'ws');
			const needsSpaceBefore =
				Boolean(prev) &&
				(prev!.type === 'word' || prev!.type === ')' || prev!.type === ']' || prev!.type === '}') &&
				t.type !== '<' &&
				t.type !== '>' &&
				t.type !== '?' &&
				t.type !== ';' &&
				!out.endsWith(' ') &&
				!out.endsWith('\n');

			if (needsSpaceBefore) {
				out += ' ';
			}
			out += t.value;
		}
	}

	return out.trim();
}

function formatTypeInMarkdown(prefix: string, type: string): string {
	const formatted = formatTypeScriptType(type);
	if (formatted.includes('\n')) {
		const pre = prefix ? `${prefix}:\n\n` : '';
		return `${pre}\`\`\`ts\n${formatted}\n\`\`\`\n\n`;
	}
	const pre = prefix ? `${prefix} ` : '';
	return `${pre}\`${formatted}\``;
}

/**
 * Prettifies a TypeScript diagnostic message.
 */
export function prettifyDiagnosticMessage(message: string): string {
	// First handle multi-line indentation chains (nested diagnostic explanation lines)
	const lines = message.split('\n');
	const processedLines: string[] = [];

	for (const line of lines) {
		const indentMatch = line.match(/^(\s{2,})(.*)$/);
		if (indentMatch) {
			const spaceCount = indentMatch[1].length;
			const content = indentMatch[2];
			const level = Math.min(4, Math.floor(spaceCount / 2));
			// Format as indented container to prevent 4-space markdown indented code block parsing
			processedLines.push(html`<div class="cm-lsp-diagnostic-indent cm-lsp-diagnostic-indent-${level}">${formatLineContent(content)}</div>`);
		} else {
			processedLines.push(formatLineContent(line));
		}
	}

	return processedLines.join('\n\n');
}

function formatLineContent(line: string): string {
	let text = line;

	// Missing properties structured bullet list
	// e.g. "Type 'X' is missing the following properties from type 'Y': foo, bar, baz."
	text = text.replace(
		/(is missing the following properties from type\s*)'([^']+)'(:\s*)([^.]+?)(?=\s*(?:and\s+\d+\s+more|\.|$))/gi,
		(_, pre, type, col, props) => {
			const formattedType = formatTypeInMarkdown('', type);
			const propItems = props.split(',').map((p: string) => p.trim()).filter(Boolean);
			const listHtml = html`<ul class="cm-lsp-diagnostic-prop-list">${propItems.map((p: string) => html`<li><code>${p}</code></li>`).join('')}</ul>`;
			return `${pre}${formattedType}${col}${listHtml}`;
		}
	);

	// Missing single property: "Property 'x' is missing in type 'X' but required in type 'Y'"
	text = text.replace(
		/Property '([^']+)' is missing in type '([^']+)' but required in type '([^']+)'/gi,
		(_, prop, typeA, typeB) => {
			return `Property \`${prop}\` is missing in type:\n\n${formatTypeInMarkdown('', typeA)}\n\nbut required in type:\n\n${formatTypeInMarkdown('', typeB)}`;
		}
	);

	// Property 'x' does not exist on type 'Y' (optional: Did you mean 'Z'?)
	text = text.replace(
		/Property '([^']+)' does not exist on type '([^']+)'(\.\s*Did you mean '([^']+)'\?)?/gi,
		(_, prop, type, didMeanPre, didMeanProp) => {
			const formattedType = formatTypeInMarkdown('', type);
			let res = `Property \`${prop}\` does not exist on type:\n\n${formattedType}`;
			if (didMeanProp) {
				res += `\n\nDid you mean \`${didMeanProp}\`?`;
			}
			return res;
		}
	);

	// Cannot find name 'x'. Did you mean 'y'?
	text = text.replace(
		/Cannot find name '([^']+)'.\s*Did you mean '([^']+)'\?/gi,
		(_, name, didMean) => `Cannot find name \`${name}\`. Did you mean \`${didMean}\`?`
	);

	// Types of property / properties incompatible
	text = text.replace(
		/Types of property '([^']+)' are incompatible/gi,
		(_, prop) => `Types of property \`${prop}\` are incompatible`
	);
	text = text.replace(
		/The types of '([^']+)' are incompatible between these types/gi,
		(_, prop) => `The types of \`${prop}\` are incompatible between these types`
	);

	// Overloads: "Overload 1 of 2, '(x: string): void', gave the following error:"
	text = text.replace(
		/(Overload \d+ of \d+),\s*'([^']+)',\s*/gi,
		(_, overload, sig) => {
			return `${overload}:\n\n${formatTypeInMarkdown('', sig)}\n\n`;
		}
	);

	// Types 'X' and 'Y'
	text = text.replace(
		/(types\s+)'([^']+)'\s+and\s+'([^']+)'/gi,
		(_, pre, typeA, typeB) => {
			return `${pre}${formatTypeInMarkdown('', typeA)} and ${formatTypeInMarkdown('', typeB)}`;
		}
	);

	// Type annotation must be 'X' or 'Y'
	text = text.replace(
		/(type annotation must be\s+)'([^']+)'\s+or\s+'([^']+)'/gi,
		(_, pre, typeA, typeB) => {
			return `${pre}${formatTypeInMarkdown('', typeA)} or ${formatTypeInMarkdown('', typeB)}`;
		}
	);

	// Type 'X' is not assignable to [parameter of] type 'Y'
	text = text.replace(
		/(Type\s+)'([^']+)'\s+is not assignable to (?:parameter of )?type\s+'([^']+)'/gi,
		(_, pre, typeA, typeB) => {
			const formattedA = formatTypeScriptType(typeA);
			const formattedB = formatTypeScriptType(typeB);
			if (formattedA.includes('\n') || formattedB.includes('\n')) {
				return `Type:\n\n\`\`\`ts\n${formattedA}\n\`\`\`\n\nis not assignable to type:\n\n\`\`\`ts\n${formattedB}\n\`\`\``;
			}
			return `Type \`${formattedA}\` is not assignable to type \`${formattedB}\``;
		}
	);

	// Argument of type 'X' is not assignable to parameter of type 'Y'
	text = text.replace(
		/(Argument of type\s+)'([^']+)'\s+is not assignable to parameter of type\s+'([^']+)'/gi,
		(_, pre, typeA, typeB) => {
			const formattedA = formatTypeScriptType(typeA);
			const formattedB = formatTypeScriptType(typeB);
			if (formattedA.includes('\n') || formattedB.includes('\n')) {
				return `Argument of type:\n\n\`\`\`ts\n${formattedA}\n\`\`\`\n\nis not assignable to parameter of type:\n\n\`\`\`ts\n${formattedB}\n\`\`\``;
			}
			return `Argument of type \`${formattedA}\` is not assignable to parameter of type \`${formattedB}\``;
		}
	);

	// Module/file specifiers
	text = text.replace(
		/(module|file|file name|imported via)\s+'([^']+)'/gi,
		(_, pre, target) => `${pre} \`${target}\``
	);

	// Type aliases, interfaces, classes
	text = text.replace(
		/(type alias|interface|subtype of constraint)\s+'([^']+)'/gi,
		(_, pre, target) => `${pre} ${formatTypeInMarkdown('', target)}`
	);

	// General single-quoted types/identifiers (excluding contractions like doesn't / it's)
	text = text.replace(/(?<!\w)'([^'\n`]+)'(?!\w)/g, (_, val) => {
		const formatted = formatTypeScriptType(val);
		if (formatted.includes('\n')) {
			return `\n\n\`\`\`ts\n${formatted}\n\`\`\`\n\n`;
		}
		return `\`${formatted}\``;
	});

	return text;
}

function getSeverityClass(severity?: LspDiagnosticSeverity | number): string {
	switch (severity) {
		case 2:
		case 'warning':
			return 'cm-lsp-severity-warning';
		case 3:
		case 'info':
			return 'cm-lsp-severity-info';
		case 4:
		case 'hint':
			return 'cm-lsp-severity-hint';
		case 1:
		case 'error':
		default:
			return 'cm-lsp-severity-error';
	}
}

function getSeverityLabel(severity?: LspDiagnosticSeverity | number): string {
	switch (severity) {
		case 2:
		case 'warning':
			return 'Warning';
		case 3:
		case 'info':
			return 'Info';
		case 4:
		case 'hint':
			return 'Hint';
		case 1:
		case 'error':
		default:
			return 'Error';
	}
}

function getSeverityIcon(severity?: LspDiagnosticSeverity | number): string {
	if (severity === 2 || severity === 'warning') {
		// Warning triangle
		return html`
			<svg class="cm-lsp-diagnostic-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
				<path d="M7.938 2.016a.13.13 0 0 1 .125 0l6.857 11.856c.026.045.026.1 0 .145a.14.14 0 0 1-.125.073H1.205a.14.14 0 0 1-.125-.073.15.15 0 0 1 0-.145L7.938 2.016zM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5zm0 6.5a.875.875 0 1 0 0 1.75.875.875 0 0 0 0-1.75z"/>
			</svg>
		`;
	}
	if (severity === 3 || severity === 4 || severity === 'info' || severity === 'hint') {
		// Info circle
		return html`
			<svg class="cm-lsp-diagnostic-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
				<path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
				<path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
			</svg>
		`;
	}
	// Error triangle (matching pretty-ts-errors ⚠ style)
	return html`
		<svg class="cm-lsp-diagnostic-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
			<path d="M7.938 2.016a.13.13 0 0 1 .125 0l6.857 11.856c.026.045.026.1 0 .145a.14.14 0 0 1-.125.073H1.205a.14.14 0 0 1-.125-.073.15.15 0 0 1 0-.145L7.938 2.016zM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5zm0 6.5a.875.875 0 1 0 0 1.75.875.875 0 0 0 0-1.75z"/>
		</svg>
	`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Builds the HTML content for one diagnostic tooltip entry.
 */
export function formatDiagnosticEntry(diagnostic: LspDiagnostic): {
	html: string;
	rawText: string;
	isTs: boolean;
	code?: string;
} {
	const isTs = isTypeScriptDiagnostic(diagnostic);
	const code = extractTypeScriptErrorCode(diagnostic);
	const rawText = diagnostic.message;

	let headerHtml = '';
	if (isTs && code) {
		const explainUrl = `https://typescript.tv/errors/#TS${code}`;
		const translateUrl = `https://ts-error-translator.vercel.app/?error=${code}`;
		const severityClass = getSeverityClass(diagnostic.severity);
		const severityLabel = getSeverityLabel(diagnostic.severity);
		const severityIcon = getSeverityIcon(diagnostic.severity);

		headerHtml = html`
			<div class="cm-lsp-diagnostic-header">
				<span class="cm-lsp-diagnostic-badge ${severityClass}">
					${severityIcon}
					<span class="cm-lsp-diagnostic-severity-label">${severityLabel}</span>
				</span>
				<span class="cm-lsp-diagnostic-code">(TS${code})</span>
				<div class="cm-lsp-diagnostic-actions">
					<a
						class="cm-lsp-diagnostic-action-link"
						href="${explainUrl}"
						target="_blank"
						rel="noopener noreferrer"
						title="Explain Error"
					>
						<svg class="cm-lsp-action-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
							<path d="M1.5 1h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 0 1 2.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 1 1 0v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 0 13.5v-11A1.5 1.5 0 0 1 1.5 1z"/>
							<path d="M10 .5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0V1.707L9.354 7.354a.5.5 0 1 1-.708-.708L14.293 1H10.5a.5.5 0 0 1-.5-.5z"/>
						</svg>
						<span>Explain</span>
					</a>
					<span class="cm-lsp-diagnostic-action-separator">|</span>
					<a
						class="cm-lsp-diagnostic-action-link"
						href="${translateUrl}"
						target="_blank"
						rel="noopener noreferrer"
						title="Translate Error"
					>
						<svg class="cm-lsp-action-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
							<path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855-.143.268-.276.56-.395.872.705.157 1.472.257 2.282.287V1.077zM4.249 4.95a6.974 6.974 0 0 0-.58 2.05h3.831V4.95H4.25zm0 3.05H3.669c.073.716.273 1.408.58 2.05h3.251V8H4.25zm3.25 3.05H4.25c.394.757.887 1.34 1.462 1.696.552.342 1.15.526 1.788.581V11.05zm1-9.973v2.744c.81-.03 1.577-.13 2.282-.287-.12-.312-.252-.604-.395-.872-.552-1.035-1.218-1.65-1.887-1.855zm0 3.794V7h3.831a6.974 6.974 0 0 0-.58-2.05H8.5zm0 3.129v2.05h3.251c.307-.642.507-1.334.58-2.05H8.5zm0 3.05v2.204c.638-.055 1.236-.239 1.788-.581.575-.356 1.068-.939 1.462-1.696H8.5z"/>
						</svg>
						<span>Translate</span>
					</a>
				</div>
			</div>
		`;
	}

	let bodyMarkdown: string;
	if (isTs) {
		// Strip leading ts: (code) prefix from message body if already presented in header
		let cleanedMessage = diagnostic.message;
		if (code) {
			cleanedMessage = cleanedMessage.replace(/^(?:ts:\s*)?(?:\(TS\d+\)|\(TS\d+\)|\(\d+\)|TS\d+)\s*:?\s*/i, '');
		}
		bodyMarkdown = prettifyDiagnosticMessage(cleanedMessage);
	} else {
		// Non-TS: preserve existing single-quote to code span transformation
		const sourcePrefix = diagnostic.source ? `${diagnostic.source}: ` : '';
		const codePrefix = diagnostic.code ? `(${diagnostic.code}) ` : '';
		const fullText = `${sourcePrefix}${codePrefix}${diagnostic.message}`;
		bodyMarkdown = fullText.replace(/(?<!\w)'([^'\n`]+)'(?!\w)/g, '`$1`');
	}

	let parsedBody = '';
	try {
		parsedBody = sanitizeHtml(marked.parse(bodyMarkdown, { async: false }) as string);
	} catch {
		parsedBody = escapeHtml(bodyMarkdown);
	}

	const htmlResult = html`
		${headerHtml}
		<div class="cm-lsp-diagnostic-message">${parsedBody}</div>
	`;
	return { html: htmlResult, rawText, isTs, code };
}
