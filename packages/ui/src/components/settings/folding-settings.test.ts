import "../../../../../tests/contract/rune-setup";
import { describe, expect, it } from "bun:test";
import { SettingsManager, type WorkspaceSettingsStorage } from "@np/core";
import {
	scopeDocumentFoldingRanges,
	scopeGutterFolds,
	writeScopeDocumentFoldingRanges,
	writeScopeGutterFolds
} from "./folding-settings";

async function storeWithBothScopes() {
	const workspaceDocuments: string[] = [];

	const manager = new SettingsManager({
		storage: {
			getItem: () => null,
			setItem: () => {}
		}
	});

	const workspaceStorage: WorkspaceSettingsStorage = {
		load: () =>
			JSON.stringify({
				editor: { gutter: { folds: true }, document_folding_ranges: "on" }
			}),
		save: (content: string) => {
			workspaceDocuments.push(content);
		}
	};
	await manager.attachWorkspaceStorage(workspaceStorage);

	manager.set("editor", "gutter", { folds: false }, "user");

	return { manager, workspaceDocuments };
}

describe("the folding settings controls", () => {
	it("shows each scope its own folding values, not the folded ones", async () => {
		const { manager } = await storeWithBothScopes();

		expect(scopeGutterFolds(manager, "user")).toBe(false);
		expect(scopeDocumentFoldingRanges(manager, "user")).toBe("off");

		expect(scopeGutterFolds(manager, "workspace")).toBe(true);
		expect(scopeDocumentFoldingRanges(manager, "workspace")).toBe("on");
	});

	it("shows the schema defaults when a scope stores nothing", () => {
		const manager = new SettingsManager({
			storage: { getItem: () => null, setItem: () => {} }
		});

		expect(scopeGutterFolds(manager, "user")).toBe(true);
		expect(scopeDocumentFoldingRanges(manager, "user")).toBe("off");
	});

	it("writes a user change into the user scope alone", async () => {
		const { manager, workspaceDocuments } = await storeWithBothScopes();
		const workspaceWritesBefore = workspaceDocuments.length;

		writeScopeGutterFolds(manager, "user", true);
		writeScopeDocumentFoldingRanges(manager, "user", "on");

		expect(scopeGutterFolds(manager, "user")).toBe(true);
		expect(scopeDocumentFoldingRanges(manager, "user")).toBe("on");
		expect(scopeGutterFolds(manager, "workspace")).toBe(true);
		expect(scopeDocumentFoldingRanges(manager, "workspace")).toBe("on");
		expect(workspaceDocuments.length).toBe(workspaceWritesBefore);
	});

	it("writes a workspace change into the workspace scope alone", async () => {
		const { manager } = await storeWithBothScopes();

		writeScopeGutterFolds(manager, "workspace", false);
		writeScopeDocumentFoldingRanges(manager, "workspace", "off");

		expect(scopeGutterFolds(manager, "workspace")).toBe(false);
		expect(scopeDocumentFoldingRanges(manager, "workspace")).toBe("off");
		expect(scopeGutterFolds(manager, "user")).toBe(false);
		expect(scopeDocumentFoldingRanges(manager, "user")).toBe("off");
	});

	it("keeps other gutter keys when toggling folds", async () => {
		const { manager } = await storeWithBothScopes();
		manager.set("editor", "gutter", { folds: true, line_numbers: false }, "user");

		writeScopeGutterFolds(manager, "user", false);

		expect(manager.getScopeValue("editor", "gutter", "user")).toEqual({
			folds: false,
			line_numbers: false
		});
	});
});
