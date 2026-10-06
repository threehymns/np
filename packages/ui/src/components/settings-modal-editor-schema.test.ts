import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EDITOR_SCHEMA, type SettingPropertySchema } from "@np/core";

/**
 * Schema text and hand-written markup must agree (ADR 0014).
 *
 * The `editor` namespace has no generated section — `SettingsModal.svelte`
 * filters it out of `GeneratedSettingsSection` — so a `control` hint declared in
 * its schema is dead and every control is spelled out by hand. That leaves the
 * title and description as the only contract between the two halves, and
 * nothing in the build checks that contract: a control whose label drifts from
 * its schema is a settings UI that documents itself wrongly, which is exactly
 * what a schema is for.
 *
 * So this is the check ADR 0014 asks for and the build does not do. It reads the
 * markup as text on purpose: the assertion is about the *words* agreeing, and a
 * rendered-DOM assertion would only prove the two strings reached the DOM rather
 * than that they were the same string.
 */

const SETTINGS_MODAL = resolve(
	dirname(import.meta.dir),
	"components/SettingsModal.svelte"
);

/**
 * The `editor` keys whose controls are hand-built, and each of which therefore
 * carries its title and description in the markup rather than generating them.
 *
 * `languages` and `tab_size` are absent: their controls are a JSON textarea and a
 * generated-free text input whose labels describe the *control* rather than the
 * setting, so the schema's description is not what the box shows.
 */
const HAND_BUILT_EDITOR_KEYS = [
	"words",
	"min_word_length",
	"automatic_completions",
	"lsp",
	"lsp_fetch_timeout_ms",
	"lsp_insert_mode",
	"show_completion_documentation"
] as const;

function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the markup carries this exact string, whitespace collapsed. */
function markupContains(markup: string, text: string): boolean {
	return new RegExp(escapeForRegExp(text.replace(/\s+/g, " ").trim())).test(
		markup.replace(/\s+/g, " ")
	);
}

describe("editor settings: schema and markup agree", () => {
	const markup = readFileSync(SETTINGS_MODAL, "utf-8");
	const properties = EDITOR_SCHEMA.properties as Record<
		string,
		SettingPropertySchema & { description?: string }
	>;

	it("declares every hand-built key, and each with the text the markup shows", () => {
		for (const key of HAND_BUILT_EDITOR_KEYS) {
			const property = properties[key];
			expect(property, `editor.${key} is missing from the schema`).toBeDefined();
			expect(
				markupContains(markup, property.title ?? key),
				`the markup does not carry the title for editor.${key}: ${property.title}`
			).toBe(true);
			expect(
				markupContains(markup, property.description ?? ""),
				`the markup does not carry the description for editor.${key}`
			).toBe(true);
		}
	});

	it("keeps a control hint out of the editor schema, because nothing dispatches it", () => {
		// `SettingsModal.svelte` filters the `editor` namespace out of the generated
		// sections, so a `control` hint here would document a UI that does not exist.
		for (const key of HAND_BUILT_EDITOR_KEYS) {
			expect(
				properties[key].control,
				`editor.${key} declares a control hint the editor UI never dispatches`
			).toBeUndefined();
		}
	});

	it("offers every enum value the schema declares", () => {
		for (const key of ["words", "lsp_insert_mode"] as const) {
			for (const value of properties[key].enum ?? []) {
				expect(
					markupContains(markup, `value="${value}"`),
					`the markup offers no control for editor.${key} = ${value}`
				).toBe(true);
			}
		}
	});
});
