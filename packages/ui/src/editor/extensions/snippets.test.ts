import "../../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { EditorState } from "@codemirror/state";
import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import {
	getSnippetsForLanguage,
	PluginHost,
	svelteLanguageRegistration,
	type RegisteredSnippet,
} from "@np/core";
import {
	snippetCompletions,
	SNIPPETS_RANK_BELOW_NOTE_SOURCES,
} from "./snippets";

/**
 * Drives the source through a `CompletionContext`, with no DOM — the seam the
 * wikilink and buffer-word suites already use. `apply` is exercised against a
 * fake view so the inserted text is asserted without an `EditorView`.
 */
function query(
	snippets: readonly RegisteredSnippet[],
	opts: { languageName: string | null; doc: string; pos?: number; explicit?: boolean },
): CompletionResult | null {
	const state = EditorState.create({
		doc: opts.doc,
		selection: { anchor: opts.pos ?? opts.doc.length },
	});
	const pos = opts.pos ?? opts.doc.length;
	return snippetCompletions({ snippets, languageName: opts.languageName })(
		new CompletionContext(state, pos, opts.explicit ?? true),
	);
}

function labels(result: CompletionResult | null): string[] {
	return (result?.options ?? []).map((o) => o.label);
}

function snippet(
	id: string,
	trigger: string,
	extra: Partial<RegisteredSnippet> = {},
): RegisteredSnippet {
	return {
		id,
		language: "svelte",
		trigger,
		body: `${trigger} body`,
		description: `${trigger} description`,
		owner: "fixture",
		...extra,
	};
}

/** Applies an option to `doc` through a fake view and returns the new text. */
function appliedDoc(
	option: Completion,
	state: EditorState,
	from: number,
	to: number,
): string {
	let spec: any = null;
	const view = { state, dispatch: (next: any) => (spec = next) };
	option.apply!(view as never, option, from, to);
	return state.update(spec).state.doc.toString();
}

describe("snippetCompletions", () => {
	it("offers only triggers extending the typed prefix, matched case-insensitively", () => {
		const snippets = [snippet("a", "reactive"), snippet("b", "each"), snippet("c", "store")];

		expect(labels(query(snippets, { languageName: "svelte", doc: "re" }))).toEqual(["reactive"]);
		expect(labels(query(snippets, { languageName: "svelte", doc: "REA" }))).toEqual(["reactive"]);
		expect(labels(query(snippets, { languageName: "svelte", doc: "zzz" }))).toEqual([]);
	});

	it("joins on the language case-insensitively and offers nothing without one", () => {
		const snippets = [snippet("a", "reactive")];

		expect(labels(query(snippets, { languageName: "SVELTE", doc: "re" }))).toEqual(["reactive"]);
		expect(labels(query(snippets, { languageName: "markdown", doc: "re" }))).toEqual([]);
		expect(labels(query(snippets, { languageName: null, doc: "re" }))).toEqual([]);
	});

	it("offers nothing for an empty prefix and nothing for an empty pack", () => {
		expect(labels(query([snippet("a", "reactive")], { languageName: "svelte", doc: " " }))).toEqual([]);
		expect(labels(query([], { languageName: "svelte", doc: "re" }))).toEqual([]);
	});

	it("answers a typing trigger as well as the explicit one", () => {
		const snippets = [snippet("a", "reactive")];

		expect(labels(query(snippets, { languageName: "svelte", doc: "re", explicit: false }))).toEqual([
			"reactive",
		]);
	});

	it("carries the description as the option detail and the tiered boost", () => {
		const result = query([snippet("a", "reactive")], { languageName: "svelte", doc: "re" });

		expect(result!.options[0].detail).toBe("reactive description");
		expect(result!.options[0].boost).toBe(SNIPPETS_RANK_BELOW_NOTE_SOURCES);
	});

	it("inserts the body verbatim over the matched trigger, placeholders aside", () => {
		const body = "{#each items as item, index}\n\t\n{/each}";
		const state = EditorState.create({ doc: "ea", selection: { anchor: 2 } });
		const result = query([snippet("a", "each", { body })], {
			languageName: "svelte",
			doc: "ea",
		});

		expect(appliedDoc(result!.options[0], state, 0, 2)).toBe(body);
	});

	it("inserts a `$`-carrying body literally rather than treating it as a variable", () => {
		// Svelte's own `$` syntax is legal in a body; a snippet variable is not
		// part of the contract, so nothing may interpret one. `insertCompletionText`
		// is plain text, so the store reference lands as typed.
		const body = "{$store}";
		const state = EditorState.create({ doc: "sto", selection: { anchor: 3 } });
		const result = query([snippet("a", "storeauto", { body })], {
			languageName: "svelte",
			doc: "sto",
		});

		expect(result!.options.map((o) => o.label)).toEqual(["storeauto"]);
		expect(appliedDoc(result!.options[0], state, 0, 3)).toBe(body);
	});
});

describe("the Svelte snippet pack", () => {
	/** The pack as the editor would read it: through the plugin registry. */
	async function packForSvelte(): Promise<RegisteredSnippet[]> {
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		await host.activate(svelteLanguageRegistration.manifest.id);
		const snippets = getSnippetsForLanguage(host.getSnippets(), "svelte");
		await host.deactivate(svelteLanguageRegistration.manifest.id);
		return snippets;
	}

	it("offers its triggers with the bodies and descriptions it registered", async () => {
		const snippets = await packForSvelte();
		expect(snippets.length).toBeGreaterThan(0);

		for (const registered of snippets) {
			const result = query(snippets, {
				languageName: "svelte",
				doc: registered.trigger,
			});
			const option = result!.options.find((o) => o.label === registered.trigger);
			expect(option).toBeDefined();
			expect(option!.detail).toBe(registered.description);

			const state = EditorState.create({
				doc: registered.trigger,
				selection: { anchor: registered.trigger.length },
			});
			expect(appliedDoc(option!, state, 0, registered.trigger.length)).toBe(registered.body);
		}
	});

	it("registers the common Svelte constructs with plain-text bodies", async () => {
		const snippets = await packForSvelte();
		const byTrigger = new Map(snippets.map((s) => [s.trigger, s]));

		for (const trigger of ["reactive", "each", "transition", "store"]) {
			expect(byTrigger.has(trigger)).toBe(true);
		}
		// No placeholders and no snippet variables (explicitly out of scope):
		// a `$` may only introduce Svelte's own syntax, never a digit or brace.
		for (const registered of snippets) {
			expect(registered.body).not.toMatch(/\$(?:\d+|\{)/);
		}
		expect(byTrigger.get("each")!.body).toBe("{#each items as item}\n\t\n{/each}");
		expect(byTrigger.get("reactive")!.body).toBe("$: doubled = count * 2;");
	});

	it("loses its triggers when the owning plugin is off and regains them on re-enable", async () => {
		// The editor effect reads the registry per revision and rebuilds the
		// chain; this drives the same read against a real host.
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		const offerFor = () =>
			labels(
				query(getSnippetsForLanguage(host.getSnippets(), "svelte"), {
					languageName: "svelte",
					doc: "reactive",
				})
			);
		const revision = () => host.snippetRevision;

		expect(offerFor()).toEqual([]);

		await host.activate(svelteLanguageRegistration.manifest.id);
		const enabledRevision = revision();
		expect(offerFor()).toEqual(["reactive"]);
		expect(enabledRevision).toBeGreaterThan(0);

		await host.deactivate(svelteLanguageRegistration.manifest.id);
		expect(revision()).toBeGreaterThan(enabledRevision);
		expect(offerFor()).toEqual([]);
		// The rest of the registry is untouched by the pack's removal.
		expect(host.getLanguages().length).toBeGreaterThan(100);
		expect(host.getLanguageForFile("notes.md")?.name).toBe("Markdown");

		await host.activate(svelteLanguageRegistration.manifest.id);
		expect(offerFor()).toEqual(["reactive"]);
		await host.deactivate(svelteLanguageRegistration.manifest.id);
	});
});
