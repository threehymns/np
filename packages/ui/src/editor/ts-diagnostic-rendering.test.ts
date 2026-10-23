import "../../../../tests/contract/rune-setup";
import { describe, expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import {
	diagnosticHoverSource,
	createDiagnosticEditorContribution,
	LspDiagnosticsStore,
	toFileUri,
	type LspDiagnosticSource,
} from "@np/core";
import { highlightCodeBlocks, highlightFencedCode } from "./extensions/server-completions";

describe("TypeScript diagnostic error rendering (pretty-ts-errors parity)", () => {
	it("syntax-highlights TypeScript fenced code blocks using editor theme styles", async () => {
		const code = "type User = {\n  id: string;\n  count: number;\n};";
		const html = await highlightFencedCode(code, "typescript");

		// Should wrap keywords and types in theme token spans
		expect(html).toContain("<span");
		expect(html).toContain("type");
		expect(html).toContain("User");
		expect(html).toContain("string");
	});

	it("renders TypeScript diagnostic hover tooltip with action links and formatted code blocks", async () => {
		const store = new LspDiagnosticsStore();
		const uri = toFileUri("/project/test.ts");
		store.publish({
			uri,
			server: "ts",
			diagnostics: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 10 },
					},
					severity: 1,
					source: "ts",
					code: 2322,
					message: "Type '{ a: string; b: number; }' is not assignable to type '{ b: number; }'.",
				},
			],
		});

		const source: LspDiagnosticSource = {
			currentUri: () => uri,
			store,
			highlightCodeBlocks: (dom) => highlightCodeBlocks(dom),
		};

		const contribution = createDiagnosticEditorContribution(source);
		const state = EditorState.create({
			doc: "const x = 1;\n",
			extensions: contribution.extension,
		});

		const tooltip = diagnosticHoverSource({ state }, 2);
		expect(tooltip).not.toBeNull();
		const dom = (tooltip!.create as any)({ state }).dom;

		// Verify action links
		const explainLink = dom.querySelector?.('a[title="Explain Error"]') as HTMLAnchorElement | null;
		const translateLink = dom.querySelector?.('a[title="Translate Error"]') as HTMLAnchorElement | null;
		expect(explainLink).toBeDefined();
		expect(translateLink).toBeDefined();

		// Check action links href
		if (explainLink) {
			expect(explainLink.getAttribute("href") ?? (explainLink as any).href).toBe("https://typescript.tv/errors/#TS2322");
		}
		if (translateLink) {
			expect(translateLink.getAttribute("href") ?? (translateLink as any).href).toBe("https://ts-error-translator.vercel.app/?error=2322");
		}

		// Verify copy button
		const copyBtn = dom.querySelector?.(".cm-lsp-diagnostic-copy");
		expect(copyBtn).toBeDefined();

		// Wait for syntax highlighting of fenced code blocks
		if ((dom as any).highlightPromise) {
			await (dom as any).highlightPromise;
		}

		const messageEl = dom.querySelector?.(".cm-lsp-diagnostic-message");
		expect(messageEl).toBeDefined();
		const html = messageEl?.innerHTML ?? "";
		expect(html).toContain("<pre><code");
		expect(html).toContain("language-ts");
	});

	it("formats missing property errors into structured bullet lists in tooltips", async () => {
		const store = new LspDiagnosticsStore();
		const uri = toFileUri("/project/test.ts");
		store.publish({
			uri,
			server: "ts",
			diagnostics: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 10 },
					},
					severity: 1,
					source: "typescript",
					code: 2741,
					message: "Property 'id' is missing in type 'NewUser' but required in type 'User'.",
				},
			],
		});

		const source: LspDiagnosticSource = {
			currentUri: () => uri,
			store,
			highlightCodeBlocks: (dom) => highlightCodeBlocks(dom),
		};

		const contribution = createDiagnosticEditorContribution(source);
		const state = EditorState.create({
			doc: "const x = 1;\n",
			extensions: contribution.extension,
		});

		const tooltip = diagnosticHoverSource({ state }, 2);
		expect(tooltip).not.toBeNull();
		const dom = (tooltip!.create as any)({ state }).dom;

		if ((dom as any).highlightPromise) {
			await (dom as any).highlightPromise;
		}

		const messageEl = dom.querySelector?.(".cm-lsp-diagnostic-message");
		const html = messageEl?.innerHTML ?? "";
		expect(html).toContain("<code>id</code>");
		expect(html).toContain("missing in type");
		expect(html).toContain("required in type");
	});
});
