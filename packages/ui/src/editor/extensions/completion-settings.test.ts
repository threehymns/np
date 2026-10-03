import { describe, it, expect } from "bun:test";
import { EDITOR_SCHEMA, SettingsManager } from "@np/core";
import {
	readAutomaticCompletions,
	readBufferWordSettings,
	type SettingReader,
} from "./completion-settings";
import { DEFAULT_BUFFER_WORD_SETTINGS } from "./buffer-words";

/**
 * A reader over the real `editor` schema with an optional stored overlay, so
 * these assertions run against the same defaults the editor resolves rather
 * than against hand-written numbers.
 */
function readerFor(
	stored: Record<string, unknown> = {},
	namespace = "editor",
): SettingReader {
	const manager = new SettingsManager({
		storage: {
			getItem: () => null,
			setItem: () => {},
		},
	});
	manager.registerSchema("core", {
		namespace,
		properties: EDITOR_SCHEMA.properties,
	});
	manager.loadFromText(JSON.stringify({ [namespace]: stored }));
	return (ns, key) => manager.get(ns, key);
}

describe("readBufferWordSettings", () => {
	it("reads the schema defaults for an editor with nothing stored", () => {
		expect(readBufferWordSettings(readerFor(), "Markdown")).toEqual({
			words: "fallback",
			minWordLength: 3,
			wordsOverridden: false,
		});
		expect(DEFAULT_BUFFER_WORD_SETTINGS).toEqual({
			words: "fallback",
			minWordLength: 3,
			wordsOverridden: false,
		});
		// One default, one home: the source's fallback is the schema's number,
		// not a second copy of it that could drift.
		expect(DEFAULT_BUFFER_WORD_SETTINGS.minWordLength).toBe(
			EDITOR_SCHEMA.properties.min_word_length.default,
		);
		expect(DEFAULT_BUFFER_WORD_SETTINGS.words).toBe(
			EDITOR_SCHEMA.properties.words.default,
		);
	});

	it("reads the editor-level values once stored", () => {
		const read = readerFor({ words: "disabled", min_word_length: 5 });

		expect(readBufferWordSettings(read, "TypeScript")).toEqual({
			words: "disabled",
			minWordLength: 5,
			wordsOverridden: false,
		});
	});

	it("applies one language's override and leaves another on the defaults", () => {
		const read = readerFor({
			languages: {
				Markdown: { words: "disabled" },
				TypeScript: { min_word_length: 2 },
			},
		});

		expect(readBufferWordSettings(read, "Markdown")).toEqual({
			words: "disabled",
			minWordLength: 3,
			wordsOverridden: true,
		});
		expect(readBufferWordSettings(read, "TypeScript")).toEqual({
			words: "fallback",
			minWordLength: 2,
			wordsOverridden: false,
		});
		// Anything unnamed keeps the editor-level value.
		expect(readBufferWordSettings(read, "Rust")).toEqual({
			words: "fallback",
			minWordLength: 3,
			wordsOverridden: false,
		});
		expect(readBufferWordSettings(read, null)).toEqual({
			words: "fallback",
			minWordLength: 3,
			wordsOverridden: false,
		});
	});

	it("reports an override that says nothing as no opinion", () => {
		// The flag exists so prose silence can tell "unset" from "disabled"; an
		// override carrying only `min_word_length` did not rule on `words`, so it
		// must not read as permission to speak.
		const read = readerFor({ languages: { Markdown: { min_word_length: 5 } } });

		expect(readBufferWordSettings(read, "Markdown")).toEqual({
			words: "fallback",
			minWordLength: 5,
			wordsOverridden: false,
		});
		expect(readBufferWordSettings(readerFor(), "Markdown").wordsOverridden).toBe(false);
	});

	it("lets a language override shadow the editor-level value", () => {
		const read = readerFor({
			words: "disabled",
			languages: { TypeScript: { words: "enabled" } },
		});

		expect(readBufferWordSettings(read, "TypeScript").words).toBe("enabled");
		expect(readBufferWordSettings(read, "Markdown").words).toBe("disabled");
		// A disabled editor-level value is not an override: prose stays quiet
		// and the flag stays false for the language that did not ask.
		expect(readBufferWordSettings(read, "Markdown").wordsOverridden).toBe(false);
	});

	it("degrades to the editor-level values for a malformed override map", () => {
		const base = readerFor();

		for (const languages of [null, "Markdown", 7, ["Markdown"], { Markdown: "disabled" }]) {
			const read: SettingReader = (namespace, key) =>
				key === "languages" ? languages : base(namespace, key);

			// The schema already refuses to store a non-object map, so reaching
			// the resolver with one means the document was hand-edited past
			// validation. It must cost the overrides and nothing else — and the
			// override flag has to go with them, or prose would read the
			// hand-edited map as permission to speak.
			expect(readBufferWordSettings(read, "Markdown")).toEqual({
				words: "fallback",
				minWordLength: 3,
				wordsOverridden: false,
			});
		}
	});

	it("never reports words as anything but the three schema values", () => {
		// An invalid stored enum keeps the schema default; a hand-edited value
		// that reached the reader anyway must not read as 'disabled'.
		const read = readerFor();
		const overridden: SettingReader = (namespace, key) =>
			key === "words" ? "sometimes" : read(namespace, key);

		expect(readBufferWordSettings(overridden, "TypeScript").words).toBe("fallback");
	});
});

describe("readAutomaticCompletions", () => {
	it("defaults to on", () => {
		expect(readAutomaticCompletions(readerFor())).toBe(true);
	});

	it("reads the stored toggle", () => {
		expect(readAutomaticCompletions(readerFor({ automatic_completions: false }))).toBe(false);
		expect(readAutomaticCompletions(readerFor({ automatic_completions: true }))).toBe(true);
	});

	it("ignores a per-language entry, because the toggle is global", () => {
		const read = readerFor({
			automatic_completions: false,
			languages: { Markdown: { automatic_completions: true } },
		});

		expect(readAutomaticCompletions(read)).toBe(false);
	});
});
