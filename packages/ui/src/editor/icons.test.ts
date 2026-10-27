import "../../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { IconRegistry } from "./icons.svelte";

const createFileProvider = (id: string, name = id) => ({
	id,
	name,
	resolveFileIcon: () => null,
	resolveFolderIcon: () => null,
	getDefaultFileIcon: () => null,
	getDefaultFolderIcon: () => null
});

const createProductProvider = (id: string, name = id) => ({
	id,
	name,
	resolveProductIcon: () => null
});

const addFileTheme = (id: string, name = id) => (previous: ReadonlyMap<string, any>) =>
	new Map(previous).set(id, createFileProvider(id, name));

const addProductTheme = (id: string, name = id) => (previous: ReadonlyMap<string, any>) =>
	new Map(previous).set(id, createProductProvider(id, name));

describe("IconRegistry", () => {
	it("removing one icon theme owner and calling refresh() produces the exact same file theme list as a clean IconRegistry", () => {
		const registry = new IconRegistry();
		const clean = new IconRegistry();

		registry.registerFileIconTransform("plugin-alpha", addFileTheme("alpha-theme"));
		registry.registerFileIconTransform("plugin-beta", addFileTheme("beta-theme"));
		clean.registerFileIconTransform("plugin-beta", addFileTheme("beta-theme"));

		registry.removePluginIcons("plugin-alpha");
		registry.refresh();

		expect(registry.getFileThemes()).toEqual(clean.getFileThemes());
	});

	it("removing one product icon theme owner and calling refresh() produces the exact same product theme list as a clean IconRegistry", () => {
		const registry = new IconRegistry();
		const clean = new IconRegistry();

		registry.registerProductIconTransform("plugin-alpha", addProductTheme("alpha-product"));
		registry.registerProductIconTransform("plugin-beta", addProductTheme("beta-product"));
		clean.registerProductIconTransform("plugin-beta", addProductTheme("beta-product"));

		registry.removePluginIcons("plugin-alpha");
		registry.refresh();

		expect(registry.getProductThemes()).toEqual(clean.getProductThemes());
	});

	it("calling refresh() mid-session produces no duplicates or losses", () => {
		const registry = new IconRegistry();
		registry.registerFileIconTransform("plugin-1", addFileTheme("theme-1"));
		registry.registerFileIconTransform("plugin-2", addFileTheme("theme-2"));
		registry.registerProductIconTransform("plugin-1", addProductTheme("prod-1"));
		registry.registerProductIconTransform("plugin-2", addProductTheme("prod-2"));

		const beforeFileThemes = registry.getFileThemes();
		const beforeProductThemes = registry.getProductThemes();

		// Check for uniqueness
		const fileIds = beforeFileThemes.map((t) => t.id);
		expect(new Set(fileIds).size).toBe(fileIds.length);
		const productIds = beforeProductThemes.map((t) => t.id);
		expect(new Set(productIds).size).toBe(productIds.length);

		// Refresh mid-session multiple times
		registry.refresh();
		registry.refresh();

		expect(registry.getFileThemes()).toEqual(beforeFileThemes);
		expect(registry.getProductThemes()).toEqual(beforeProductThemes);
	});

	it("a throwing icon transform leaves no wedged entry behind (atomic registration)", () => {
		const registry = new IconRegistry();
		registry.registerFileIconTransform("plugin-ok", addFileTheme("ok-theme"));
		const beforeFiles = registry.getFileThemes();

		let fileError: unknown = null;
		try {
			registry.registerFileIconTransform("plugin-throwing", () => {
				throw new Error("failing file transform");
			});
		} catch (err) {
			fileError = err;
		}

		expect(fileError).toBeInstanceOf(Error);
		expect((fileError as Error).message).toContain("failing file transform");
		expect(registry.getFileThemes()).toEqual(beforeFiles);
		registry.rebuild();
		expect(registry.getFileThemes()).toEqual(beforeFiles);

		// Product icon transform atomic registration
		registry.registerProductIconTransform("plugin-ok", addProductTheme("ok-prod"));
		const beforeProducts = registry.getProductThemes();

		let productError: unknown = null;
		try {
			registry.registerProductIconTransform("plugin-throwing", () => {
				throw new Error("failing product transform");
			});
		} catch (err) {
			productError = err;
		}

		expect(productError).toBeInstanceOf(Error);
		expect((productError as Error).message).toContain("failing product transform");
		expect(registry.getProductThemes()).toEqual(beforeProducts);
		registry.rebuild();
		expect(registry.getProductThemes()).toEqual(beforeProducts);
	});

	it("removing an owner whose theme was active resets activeFileThemeId / activeProductThemeId back to phosphor", () => {
		const registry = new IconRegistry();
		registry.registerFileIconTransform("plugin-a", addFileTheme("custom-file-theme"));
		registry.registerProductIconTransform("plugin-b", addProductTheme("custom-product-theme"));

		registry.activeFileThemeId = "custom-file-theme";
		registry.activeProductThemeId = "custom-product-theme";
		expect(registry.activeFileThemeId).toBe("custom-file-theme");
		expect(registry.activeProductThemeId).toBe("custom-product-theme");

		// Removing file theme owner resets activeFileThemeId back to phosphor
		registry.removePluginIcons("plugin-a");
		expect(registry.activeFileThemeId).toBe("phosphor");
		expect(registry.activeProductThemeId).toBe("custom-product-theme");

		// Removing product theme owner resets activeProductThemeId back to phosphor
		registry.removePluginIcons("plugin-b");
		expect(registry.activeProductThemeId).toBe("phosphor");
	});

	it("removing an owner whose theme was not active preserves the active theme", () => {
		const registry = new IconRegistry();
		registry.registerFileIconTransform("plugin-a", addFileTheme("theme-a"));
		registry.registerFileIconTransform("plugin-b", addFileTheme("theme-b"));

		registry.activeFileThemeId = "theme-a";
		registry.removePluginIcons("plugin-b");
		expect(registry.activeFileThemeId).toBe("theme-a");
	});

	it("refresh preserves an active builtin theme that has not loaded yet", () => {
		const registry = new IconRegistry();
		registry.activeFileThemeId = "material";
		registry.activeProductThemeId = "custom-product";

		registry.registerFileIconTransform("plugin-a", addFileTheme("theme-a"));
		registry.registerProductIconTransform("plugin-a", addProductTheme("product-a"));
		registry.refresh();

		expect(registry.activeFileThemeId).toBe("material");
		expect(registry.activeProductThemeId).toBe("custom-product");
	});

	it("removing an owner with no icon transforms preserves an unloaded active theme", () => {
		const registry = new IconRegistry();
		registry.activeFileThemeId = "material";

		registry.removePluginIcons("plugin-not-registered");

		expect(registry.activeFileThemeId).toBe("material");
	});

	it("removing a plugin owner preserves an unloaded builtin active theme", () => {
		const registry = new IconRegistry();
		registry.registerFileIconTransform("plugin-a", addFileTheme("theme-a"));
		registry.activeFileThemeId = "material";

		registry.removePluginIcons("plugin-a");

		expect(registry.activeFileThemeId).toBe("material");
	});
});
