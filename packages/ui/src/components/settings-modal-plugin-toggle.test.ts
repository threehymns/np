import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("SettingsModal plugin toggle switch binding contract", () => {
	const sveltePath = path.resolve(__dirname, "./SettingsModal.svelte");
	const content = fs.readFileSync(sveltePath, "utf-8");

	it("uses function binding for plugin toggle switch without separate onCheckedChange", () => {
		// Verify function binding pattern is used for row.enabled and handlePluginToggle
		expect(content).toMatch(/bind:checked=\{[^{}]*\(\)\s*=>\s*row\.enabled[^{}]*,\s*\(next\)\s*=>\s*handlePluginToggle\(row,\s*next\)[^{}]*\}/);
		
		// Verify onCheckedChange is not used on the plugin row Switch
		const pluginSectionMatch = content.match(/pluginConfirmId[\s\S]*?<Switch[\s\S]*?\/>/);
		if (pluginSectionMatch) {
			expect(pluginSectionMatch[0]).not.toContain("onCheckedChange");
		}
	});
});
