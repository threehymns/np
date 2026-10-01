import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("SettingsModal settings scope ownership", () => {
	const sveltePath = path.resolve(__dirname, "./SettingsModal.svelte");
	const content = fs.readFileSync(sveltePath, "utf-8");

	it("takes its open state from the one binding Dialog.Root renders", () => {
		expect(content).toMatch(/let \{ open = \$bindable\(false\) \} = \$props\(\)/);
		expect(content).toMatch(/<Dialog\.Root bind:open>/);
		// No second open state or close handler that could close the dialog
		// without going through the binding the scope reset reads.
		expect(content).not.toMatch(/onOpenChange/);
	});

	it("returns the active scope to user on every close path", () => {
		// Ordinary setters (zoom, theme, ...) write to appState.prefs.activeScope,
		// so a closed dialog must never leave the workspace scope active. Escape,
		// outside click, the close button and the command that opens the settings
		// all funnel through `open`, so the reset hangs off that binding instead
		// of a close handler that could miss a path.
		expect(content).toMatch(
			/\$effect\(\(\) => \{\s*if \(!open\) appState\.prefs\.activeScope = 'user';\s*\}\);/
		);
	});
});
