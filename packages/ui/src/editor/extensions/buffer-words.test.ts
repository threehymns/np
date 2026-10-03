import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { markdown } from "@codemirror/lang-markdown";
import { Table, GFM } from "@lezer/markdown";
import {
	CompletionContext,
	type Completion,
	type CompletionResult,
} from "@codemirror/autocomplete";
import {
	bufferWordCompletions,
	type BufferWordSettings,
} from "./buffer-words";
import { WikiLinkExtension, workspaceFacet, currentDocFacet } from "./wikilinks";

const markdownExtension = markdown({
	extensions: [Table, GFM, WikiLinkExtension] as any,
});

/** A real `LanguageSupport` for a code file, loaded through the registry. */
async function codeSupport(name: string): Promise<LanguageSupport> {
	const desc = languages.find((l) => l.name === name);
	expect(desc).toBeDefined();
	return (await desc!.load()) as LanguageSupport;
}

/**
 * Drives the source through a `CompletionContext` at `pos`, with no DOM —
 * the seam the wikilink suite already uses.
 */
function query(
	source: (context: CompletionContext) => CompletionResult | null,
	options: {
		doc: string;
		pos: number;
		explicit?: boolean;
		extensions?: readonly unknown[];
	},
): CompletionResult | null {
	const state = EditorState.create({
		doc: options.doc,
		selection: { anchor: options.pos },
		extensions: (options.extensions ?? []) as any,
	});
	return source(new CompletionContext(state, options.pos, options.explicit ?? false));
}

function labels(result: CompletionResult | null): string[] {
	return (result?.options ?? []).map((o) => o.label);
}

describe("bufferWordCompletions — explicit trigger", () => {
	it("offers current-document words in a code file", async () => {
		const support = await codeSupport("JavaScript");
		const doc = "const totalCount = computeTotals(rows);\ntotal";
		const source = bufferWordCompletions({ languageName: "javascript" });

		const result = query(source, {
			doc,
			pos: doc.length,
			explicit: true,
			extensions: [support],
		});

		expect(labels(result)).toEqual(["totalCount"]);
	});

	it("offers current-document words in Markdown prose", () => {
		const doc = "The kettle whistles loudly.\nEvery kettle knows\nkettl";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		const result = query(source, {
			doc,
			pos: doc.length,
			explicit: true,
			extensions: [markdownExtension],
		});

		expect(labels(result)).toEqual(["kettle"]);
	});

	it("matches the typed prefix case-insensitively", () => {
		const doc = "Widget assembly\nwidget";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		const result = query(source, {
			doc,
			pos: doc.length,
			explicit: true,
			extensions: [markdownExtension],
		});

		expect(labels(result)).toEqual(["Widget"]);
	});

	it("offers nothing when the typed prefix has no match in the document", () => {
		const doc = "kettle\nqqq";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			query(source, {
				doc,
				pos: doc.length,
				explicit: true,
				extensions: [markdownExtension],
			}),
		).toBeNull();
	});

	it("offers nothing on an empty prefix instead of dumping the vocabulary", () => {
		const doc = "kettle\n\n";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			query(source, {
				doc,
				pos: doc.length,
				explicit: true,
				extensions: [markdownExtension],
			}),
		).toBeNull();
	});

	it("replaces exactly the typed prefix on accept", () => {
		const doc = "kettle\nkettl";
		const source = bufferWordCompletions({ languageName: "Markdown" });
		const result = query(source, {
			doc,
			pos: doc.length,
			explicit: true,
			extensions: [markdownExtension],
		})!;

		// CodeMirror filters options against sliceDoc(from, to); a `from` that
		// swallowed more than the typed word would leave nothing matching.
		expect(result.from).toBe(doc.length - 5);
		expect(result.to ?? doc.length).toBe(doc.length);
	});
});

describe("bufferWordCompletions — automatic trigger", () => {
	it("stays silent on a typing trigger in Markdown prose", () => {
		const doc = "The kettle whistles.\nkettl";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			query(source, {
				doc,
				pos: doc.length,
				explicit: false,
				extensions: [markdownExtension],
			}),
		).toBeNull();
	});

	it("stays silent on a typing trigger in a code file", async () => {
		const support = await codeSupport("JavaScript");
		const doc = "const totalCount = 1;\ntotal";
		const source = bufferWordCompletions({ languageName: "javascript" });

		expect(
			query(source, {
				doc,
				pos: doc.length,
				explicit: false,
				extensions: [support],
			}),
		).toBeNull();
	});
});

describe("bufferWordCompletions — vocabulary", () => {
	it("draws from the current document only", () => {
		// A neighbouring note full of words, reachable through both facets the
		// note sources read. None of it may leak into a buffer-word offer.
		const otherDocument = "quokka quokka quokka";
		const doc = "kettle\nkettl";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		const result = query(source, {
			doc,
			pos: doc.length,
			explicit: true,
			extensions: [
				markdownExtension,
				workspaceFacet.of({
					project: { projectTree: { nodes: [] } },
					documents: [{ fileName: "Other.md", content: otherDocument }],
				} as any),
				currentDocFacet.of({ content: otherDocument } as any),
			],
		});

		expect(labels(result)).toEqual(["kettle"]);
	});

	it("dedupes repeated words and keeps first document order", () => {
		const doc = "gamma gamma delta epsilon gamma\nde";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: true,
					extensions: [markdownExtension],
				}),
			),
		).toEqual(["delta"]);
	});

	it("orders a longer vocabulary by first document occurrence", () => {
		const doc = "tangerine tart tangerine\nta";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: true,
					extensions: [markdownExtension],
				}),
			),
		).toEqual(["tangerine", "tart"]);
	});

	it("never offers the token the cursor is typing", () => {
		const doc = "cherry cherry\ncher";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: true,
					extensions: [markdownExtension],
				}),
			),
		).toEqual(["cherry"]);
	});

	it("keeps identifier-shaped tokens in a code file", async () => {
		const support = await codeSupport("JavaScript");
		const doc = "const _private$field = 1;\n_priv";
		const source = bufferWordCompletions({ languageName: "javascript" });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: true,
					extensions: [support],
				}),
			),
		).toEqual(["_private$field"]);
	});

	it("drops tokens shorter than the minimum length", () => {
		const doc = "be ab abc abcd\nab";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: true,
					extensions: [markdownExtension],
				}),
			),
		).toEqual(["abc", "abcd"]);
	});

	it("splits non-word characters out of prose tokens", () => {
		const doc = "state-of-the-art\nstat";
		const source = bufferWordCompletions({ languageName: "Markdown" });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: true,
					extensions: [markdownExtension],
				}),
			),
		).toEqual(["state"]);
	});
});

describe("bufferWordCompletions — injected settings", () => {
	it("consults the settings reader on every query", () => {
		let calls = 0;
		const source = bufferWordCompletions({
			languageName: "Markdown",
			readSettings: () => {
				calls++;
				return { minWordLength: 3 };
			},
		});

		for (const pos of [10, 10, 10]) {
			query(source, {
				doc: "kettl\nkettl",
				pos,
				explicit: true,
				extensions: [markdownExtension],
			});
		}

		expect(calls).toBe(3);
	});

	it("picks up a settings change without rebuilding the source", () => {
		let settings: BufferWordSettings = { minWordLength: 10 };
		const source = bufferWordCompletions({
			languageName: "Markdown",
			readSettings: () => settings,
		});
		const doc = "kettle kettlepot\nkettl";

		const before = query(source, {
			doc,
			pos: doc.length,
			explicit: true,
			extensions: [markdownExtension],
		});
		expect(labels(before)).toEqual([]);

		settings = { minWordLength: 4 };

		const after = query(source, {
			doc,
			pos: doc.length,
			explicit: true,
			extensions: [markdownExtension],
		});
		expect(labels(after)).toEqual(["kettle", "kettlepot"]);
	});
});

describe("bufferWordCompletions — ranking contract", () => {
	it("carries a rank below every other completion source", () => {
		const doc = "cherry\ncher";
		const source = bufferWordCompletions({ languageName: "Markdown" });
		const options = (
			query(source, {
				doc,
				pos: doc.length,
				explicit: true,
				extensions: [markdownExtension],
			})?.options ?? []
		) as Completion[];

		expect(options.length).toBeGreaterThan(0);
		// CodeMirror ranks by fuzzy score + boost, descending, and every fuzzy
		// score is <= 0. A negative boost of this size therefore loses to any
		// option the table, wikilink and language sources can emit.
		for (const option of options) {
			expect(option.boost).toBeLessThan(-2100);
		}
	});
});
