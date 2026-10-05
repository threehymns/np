import "../../../../../tests/contract/rune-setup";
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
	type CompletionSource,
} from "@codemirror/autocomplete";
import {
	bufferWordCompletions,
	DEFAULT_BUFFER_WORD_SETTINGS,
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
	it("stays silent on a typing trigger in Markdown prose at every prefix length", () => {
		// The prefix runs from one to six characters against `kettle`, so the
		// sweep crosses the default minimum of three: prose is quiet on both
		// sides of it.
		const source = bufferWordCompletions({ languageName: "Markdown" });

		for (let typed = 1; typed <= 6; typed++) {
			const doc = `Kettles whistle loudly every morning\n${"kettle".slice(0, typed)}`;

			expect(
				query(source, {
					doc,
					pos: doc.length,
					explicit: false,
					extensions: [markdownExtension],
				}),
			).toBeNull();
		}
	});

	it("offers words on a typing trigger in a code file past the minimum length", async () => {
		const support = await codeSupport("JavaScript");
		const doc = "const totalCount = 1;\ntotal";
		const source = bufferWordCompletions({ languageName: "javascript" });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: false,
					extensions: [support],
				}),
			),
		).toEqual(["totalCount"]);
	});

	it("offers nothing on a typing trigger below the minimum length", async () => {
		const support = await codeSupport("JavaScript");
		// Two characters typed against `counterValue`: under the default of three.
		const doc = "let counterValue = 1;\nco";
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

	it("follows the minimum length into the automatic trigger threshold", async () => {
		const support = await codeSupport("JavaScript");
		const doc = "let counterValue = 1;\nco";
		const source = bufferWordCompletions({
			languageName: "javascript",
			readSettings: () => ({ ...DEFAULT_BUFFER_WORD_SETTINGS, minWordLength: 2 }),
		});

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: false,
					extensions: [support],
				}),
			),
		).toEqual(["counterValue"]);
	});

	it("stays silent on a typing trigger in any language when words are disabled", async () => {
		const support = await codeSupport("JavaScript");
		const doc = "const totalCount = 1;\ntotal";
		const source = bufferWordCompletions({
			languageName: "javascript",
			readSettings: () => ({ ...DEFAULT_BUFFER_WORD_SETTINGS, words: "disabled" }),
		});

		expect(
			query(source, {
				doc,
				pos: doc.length,
				explicit: false,
				extensions: [support],
			}),
		).toBeNull();
	});

	it("still answers the explicit trigger when words are disabled", async () => {
		const support = await codeSupport("JavaScript");
		const doc = "const totalCount = 1;\ntotal";
		const source = bufferWordCompletions({
			languageName: "javascript",
			readSettings: () => ({ ...DEFAULT_BUFFER_WORD_SETTINGS, words: "disabled" }),
		});

		// Off means quiet, not unavailable.
		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: true,
					extensions: [support],
				}),
			),
		).toEqual(["totalCount"]);
	});

	it("identifies Markdown prose by language identity, case-insensitively", () => {
		const doc = "Kettles whistle\nkettl";
		const source = bufferWordCompletions({ languageName: "mArKdOwN" });

		expect(
			query(source, {
				doc,
				pos: doc.length,
				explicit: false,
				extensions: [markdownExtension],
			}),
		).toBeNull();
	});

	it("offers words on a typing trigger inside a fenced code block in a note", () => {
		// The note is Markdown, so the prose above is quiet — but a fenced block
		// is code the user is writing, and it gets the automatic offers a code
		// file gets.
		const source = bufferWordCompletions({ languageName: "Markdown" });
		const doc = "The kettle whistles.\n\n```js\nconst totalCount = 1;\ntotal\n```\n";
		const afterTrigger = doc.indexOf("total\n```") + "total".length;

		expect(
			labels(
				query(source, {
					doc,
					pos: afterTrigger,
					explicit: false,
					extensions: [markdownExtension],
				}),
			),
		).toEqual(["totalCount"]);
	});

	it("treats an unfinished fenced block as code too", () => {
		// The fence has not been closed yet because the block is still being
		// written; the cursor is on the code line either way.
		const source = bufferWordCompletions({ languageName: "Markdown" });
		const doc = "The kettle whistles.\n\n```js\nconst totalCount = 1;\ntotal";

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: false,
					extensions: [markdownExtension],
				}),
			),
		).toEqual(["totalCount"]);
	});

	it("keeps the prose around a fenced block quiet in the same note", () => {
		// One document, two cursors: quiet above the fence and quiet below it,
		// which is what "silent in Markdown prose" means per prose rather than
		// per document.
		const source = bufferWordCompletions({ languageName: "Markdown" });
		const doc = "Kettles whistle loudly\n\n```js\nconst kettlepot = 1;\nkett\n```\n\nkettl";

		for (const pos of [doc.indexOf("\n\n") + 1, doc.lastIndexOf("kettl") + 4]) {
			expect(
				query(source, {
					doc,
					pos,
					explicit: false,
					extensions: [markdownExtension],
				}),
			).toBeNull();
		}
	});

	it("treats a document with no language as not prose", () => {
		const doc = "Kettles whistle\nkettl";
		const source = bufferWordCompletions({ languageName: null });

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: false,
					extensions: [],
				}),
			),
		).toEqual(["Kettles"]);
	});
});

describe("bufferWordCompletions — the prose override", () => {
	/** Two characters against `kettle`, under the default minimum of three. */
	const doc = "Kettles whistle loudly\nke";
	const source = (settings: Partial<BufferWordSettings>) =>
		bufferWordCompletions({
			languageName: "Markdown",
			readSettings: () => ({ ...DEFAULT_BUFFER_WORD_SETTINGS, ...settings }),
		});
	const typing = (buffered: CompletionSource) =>
		query(buffered, {
			doc,
			pos: doc.length,
			explicit: false,
			extensions: [markdownExtension],
		});

	it("keeps prose quiet with no per-language override, and quiet again for an explicit 'disabled'", () => {
		expect(typing(source({}))).toBeNull();
		expect(typing(source({ wordsOverridden: true, words: "disabled" }))).toBeNull();
	});

	it("lets an explicit 'enabled' override give prose automatic words", () => {
		const doc = "Kettles whistle loudly\nkettl";
		const result = query(source({ wordsOverridden: true, words: "enabled" }), {
			doc,
			pos: doc.length,
			explicit: false,
			extensions: [markdownExtension],
		});

		expect(labels(result)).toEqual(["Kettles"]);
	});

	it("still needs the minimum typed length once prose is overridden", () => {
		// The override changes *whether* prose speaks, not the threshold that
		// governs when.
		expect(typing(source({ wordsOverridden: true, words: "enabled" }))).toBeNull();
	});

	it("leaves the explicit trigger answering either way", () => {
		for (const settings of [
			{},
			{ wordsOverridden: true, words: "enabled" as const },
			{ wordsOverridden: true, words: "disabled" as const },
		]) {
			const doc = "Kettles whistle loudly\nkettl";
			expect(
				labels(
					query(source(settings), {
						doc,
						pos: doc.length,
						explicit: true,
						extensions: [markdownExtension],
					}),
				),
			).toEqual(["Kettles"]);
		}
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

	it("offers a word shorter than the minimum, because the minimum is a trigger threshold", () => {
		// The setting is about when words fire on their own. On the explicit
		// path the user asked, so a one-letter token is a legitimate offer.
		const doc = "a b cd\nb";
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
		).toEqual(["b"]);
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
				return DEFAULT_BUFFER_WORD_SETTINGS;
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

	it("picks up a settings change without rebuilding the source", async () => {
		// The threshold is the automatic trigger's, so it is exercised there.
		const support = await codeSupport("JavaScript");
		let settings: BufferWordSettings = {
			...DEFAULT_BUFFER_WORD_SETTINGS,
			minWordLength: 10,
		};
		const source = bufferWordCompletions({
			languageName: "javascript",
			readSettings: () => settings,
		});
		const doc = "const kettlepot = 1;\nkettl";

		expect(
			query(source, {
				doc,
				pos: doc.length,
				explicit: false,
				extensions: [support],
			}),
		).toBeNull();

		settings = { ...DEFAULT_BUFFER_WORD_SETTINGS, minWordLength: 4 };

		expect(
			labels(
				query(source, {
					doc,
					pos: doc.length,
					explicit: false,
					extensions: [support],
				}),
			),
		).toEqual(["kettlepot"]);
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
