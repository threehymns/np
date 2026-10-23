import "../../../../../tests/contract/rune-setup";
import { describe, expect, it } from "bun:test";
import { SettingsManager, type WorkspaceSettingsStorage } from "@np/core";
import {
	languageOverridesText,
	scopeLanguageOverrides,
	writeLanguageOverrides
} from "./language-overrides";

/**
 * A settings store with a different per-language map in each scope.
 *
 * The two maps are the point. The resolved map is the two folded together, so
 * a box that edits one scope and shows the resolved map shows the other
 * scope's entries as well, and saving them back writes them into the scope
 * being edited.
 */
async function storeWithBothScopes() {
	const userDocuments: string[] = [];
	const workspaceDocuments: string[] = [];

	const manager = new SettingsManager({
		storage: {
			getItem: () => null,
			setItem: (_key: string, value: string) => {
				userDocuments.push(value);
			}
		}
	});

	const workspaceStorage: WorkspaceSettingsStorage = {
		load: () =>
			JSON.stringify({ editor: { languages: { TypeScript: { min_word_length: 2 } } } }),
		save: (content: string) => {
			workspaceDocuments.push(content);
		}
	};
	await manager.attachWorkspaceStorage(workspaceStorage);

	manager.set("editor", "languages", { Markdown: { words: "disabled" } }, "user");
	manager.set("editor", "languages", { TypeScript: { min_word_length: 2 } }, "workspace");

	return { manager, userDocuments, workspaceDocuments };
}

describe("the per-language override box", () => {
	it("shows the user scope the user's own map, not the folded one", async () => {
		const { manager } = await storeWithBothScopes();

		expect(scopeLanguageOverrides(manager, "user")).toEqual({
			Markdown: { words: "disabled" }
		});
		expect(languageOverridesText(manager, "user")).not.toContain("TypeScript");
	});

	it("shows the workspace scope the workspace's own map, not the folded one", async () => {
		const { manager } = await storeWithBothScopes();

		expect(scopeLanguageOverrides(manager, "workspace")).toEqual({
			TypeScript: { min_word_length: 2 }
		});
		expect(languageOverridesText(manager, "workspace")).not.toContain("Markdown");
	});

	it("leaves the folded map to the resolver, which is what answers for every scope", async () => {
		const { manager } = await storeWithBothScopes();

		expect(manager.get("editor", "languages")).toEqual({
			Markdown: { words: "disabled" },
			TypeScript: { min_word_length: 2 }
		});
	});

	it("a write in the user scope leaves the workspace scope's stored value alone", async () => {
		const { manager, workspaceDocuments } = await storeWithBothScopes();
		const workspaceWritesBefore = workspaceDocuments.length;

		writeLanguageOverrides(manager, "user", JSON.stringify({ Python: { words: "enabled" } }));

		expect(scopeLanguageOverrides(manager, "user")).toEqual({
			Python: { words: "enabled" }
		});
		expect(scopeLanguageOverrides(manager, "workspace")).toEqual({
			TypeScript: { min_word_length: 2 }
		});
		expect(workspaceDocuments.length).toBe(workspaceWritesBefore);
	});

	it("a write in the workspace scope leaves the user scope's stored value alone", async () => {
		const { manager, userDocuments } = await storeWithBothScopes();
		const userWritesBefore = userDocuments.length;

		writeLanguageOverrides(manager, "workspace", JSON.stringify({ Rust: { lsp: false } }));

		expect(scopeLanguageOverrides(manager, "workspace")).toEqual({ Rust: { lsp: false } });
		expect(scopeLanguageOverrides(manager, "user")).toEqual({
			Markdown: { words: "disabled" }
		});
		expect(userDocuments.length).toBe(userWritesBefore);
	});

	it("a draft that is not JSON is refused, and nothing is written", async () => {
		const { manager } = await storeWithBothScopes();

		expect(() => writeLanguageOverrides(manager, "user", "{ not json")).toThrow();
		expect(scopeLanguageOverrides(manager, "user")).toEqual({
			Markdown: { words: "disabled" }
		});
	});

	it("each scope round-trips its own map", async () => {
		const { manager } = await storeWithBothScopes();

		writeLanguageOverrides(manager, "user", JSON.stringify({ Rust: { lsp: false } }));
		expect(scopeLanguageOverrides(manager, "user")).toEqual({ Rust: { lsp: false } });

		writeLanguageOverrides(manager, "workspace", JSON.stringify({ Python: { words: "enabled" } }));
		expect(scopeLanguageOverrides(manager, "workspace")).toEqual({
			Python: { words: "enabled" }
		});

		// The user scope still holds the user scope's own map.
		expect(scopeLanguageOverrides(manager, "user")).toEqual({ Rust: { lsp: false } });
	});
});
