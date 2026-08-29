import "./contract/rune-setup";
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type {
	IconRegistryInterface,
	FileIconProvider,
	ProductIconProvider,
	ResolvedIcon,
	ZedIconTheme
} from "../packages/core/src/editor/icons-types";

let HeadlessIconRegistry: any;
let ManifestIconProvider: any;
let PhosphorIconProvider: any;
let IconRegistry: any;

beforeAll(async () => {
	const core = await import("../packages/core/src");
	HeadlessIconRegistry = core.HeadlessIconRegistry;
	ManifestIconProvider = core.ManifestIconProvider;

	const uiIcons = await import("../packages/ui/src/editor/icons.svelte");
	PhosphorIconProvider = uiIcons.PhosphorIconProvider;
	IconRegistry = uiIcons.IconRegistry;
});

describe("Adversarial Stress Test: HeadlessIconRegistry", () => {
	it("handles missing, unknown, and invalid active theme IDs gracefully", () => {
		const registry = new HeadlessIconRegistry();
		
		// Set to non-existent theme IDs
		registry.activeFileThemeId = "non-existent-theme-xyz";
		registry.activeProductThemeId = "non-existent-product-theme";

		expect(registry.resolveFileIconChain("index.ts")).toEqual([]);
		expect(registry.resolveFolderIconChain("src")).toEqual([]);
		expect(registry.resolveProductIconChain("settings")).toEqual([]);
		expect(registry.resolveFileIcon("index.ts")).toBeNull();
		expect(registry.resolveProductIcon("settings")).toBeNull();
		expect(registry.getFileIcon("index.ts")).toBeNull();
		expect(registry.getFolderIcon("src")).toBeNull();
		expect(registry.getFolderExpandedIcon("src")).toBeNull();
		expect(registry.getThemeDefaultFileIcon()).toBeNull();
		expect(registry.getThemeDefaultFolderIcon()).toBeNull();
		expect(registry.getThemeDefaultFolderExpandedIcon()).toBeNull();

		// Set to empty string
		registry.activeFileThemeId = "";
		registry.activeProductThemeId = "";
		expect(registry.resolveFileIcon("index.ts")).toBeNull();
		expect(registry.getFolderIcon("src")).toBeNull();
	});

	it("handles appearance changes across registered providers with and without setAppearance", () => {
		const registry = new HeadlessIconRegistry();
		let provider1Appearance = "";
		const provider1: FileIconProvider = {
			id: "prov-1",
			name: "Provider 1",
			resolveFileIcon: () => null,
			resolveFolderIcon: () => null,
			getDefaultFileIcon: () => null,
			getDefaultFolderIcon: () => null,
			setAppearance: (app) => { provider1Appearance = app; }
		};

		const provider2: FileIconProvider = {
			id: "prov-2",
			name: "Provider 2",
			resolveFileIcon: () => null,
			resolveFolderIcon: () => null,
			getDefaultFileIcon: () => null,
			getDefaultFolderIcon: () => null
			// setAppearance omitted
		};

		registry.registerFileTheme("p1", provider1);
		registry.registerFileTheme("p2", provider2);

		expect(() => registry.setAppearance("light")).not.toThrow();
		expect(registry.currentAppearance).toBe("light");
		expect(provider1Appearance).toBe("light");

		expect(() => registry.setAppearance("dark")).not.toThrow();
		expect(registry.currentAppearance).toBe("dark");
		expect(provider1Appearance).toBe("dark");
	});

	it("handles resolution of empty, dotfiles, multi-extensions, and extreme strings", () => {
		const registry = new HeadlessIconRegistry();
		
		const mockProvider: FileIconProvider = {
			id: "mock",
			name: "Mock Provider",
			resolveFileIcon: (fn, ctx) => {
				if (!fn) return null;
				if (fn.endsWith(".special")) return { type: "svg", value: "<svg></svg>" };
				return null;
			},
			resolveFolderIcon: (fn, opt) => {
				if (fn === "special_dir") return { type: "svg", value: "<svg folder></svg>" };
				return null;
			},
			getDefaultFileIcon: () => ({ type: "svg", value: "<svg def-file></svg>" }),
			getDefaultFolderIcon: (opt) => ({ type: "svg", value: opt?.expanded ? "<svg def-open></svg>" : "<svg def-folder></svg>" })
		};

		registry.registerFileTheme("mock", mockProvider);
		registry.activeFileThemeId = "mock";

		// Empty strings
		expect(registry.resolveFileIcon("")).toBe("<svg def-file></svg>"); // Falls back to default file icon in chain
		expect(registry.getFolderIcon("")).toBe("<svg def-folder></svg>");

		// Special filename
		expect(registry.resolveFileIcon("custom.special")).toBe("<svg></svg>");

		// Huge filename (50k chars)
		const hugeName = "a/b/c/".repeat(5000) + "file.special";
		expect(registry.resolveFileIcon(hugeName)).toBe("<svg></svg>");

		// Unicode / emoji
		expect(registry.resolveFileIcon("🦀_rust_file.special")).toBe("<svg></svg>");
	});
});

describe("Adversarial Stress Test: ManifestIconProvider", () => {
	const mockZedTheme: ZedIconTheme = {
		name: "Stress Test Theme",
		themes: [
			{
				name: "Stress Variant Dark",
				appearance: "dark",
				file_stems: {
					"dockerfile": "docker",
					"package.json": "npm",
					"gitignore": "git",
					".env": "env"
				},
				file_suffixes: {
					"test.ts": "ts_test",
					"spec.js": "js_test",
					"ts": "typescript",
					"js": "javascript",
					"tar.gz": "archive"
				},
				file_icons: {
					docker: { path: "docker.svg" },
					npm: { path: "npm.svg" },
					git: { path: "git.svg" },
					env: { path: "env.svg" },
					ts_test: { path: "ts_test.svg" },
					js_test: { path: "js_test.svg" },
					typescript: { path: "typescript.svg" },
					javascript: { path: "javascript.svg" },
					archive: { path: "archive.svg" },
					file: { path: "default_file.svg" }
				},
				directory_icons: {
					collapsed: "dir_default.svg",
					expanded: "dir_default_open.svg"
				},
				named_directory_icons: {
					src: {
						collapsed: "dir_src.svg",
						expanded: "dir_src_open.svg"
					}
				}
			},
			{
				name: "Stress Variant Light",
				appearance: "light",
				file_stems: {
					"package.json": "npm_light"
				},
				file_suffixes: {
					"ts": "typescript_light"
				},
				file_icons: {
					npm_light: { path: "npm_light.svg" },
					typescript_light: { path: "typescript_light.svg" },
					file: { path: "default_file_light.svg" }
				},
				directory_icons: {
					collapsed: "dir_default_light.svg",
					expanded: "dir_default_light_open.svg"
				}
			}
		]
	};

	it("resolves multi-dot extensions, dotfiles, stems, and fallbacks accurately", () => {
		const provider = new ManifestIconProvider("stress", "Stress Theme", mockZedTheme, "https://icons.example.com/");

		// 1. Exact stem
		expect(provider.resolveFileIcon("Dockerfile")).toEqual({
			type: "url",
			value: "https://icons.example.com/docker.svg"
		});

		// 2. Dotfile stem stripping (e.g. .gitignore -> gitignore)
		expect(provider.resolveFileIcon(".gitignore")).toEqual({
			type: "url",
			value: "https://icons.example.com/git.svg"
		});

		// 3. Dotfile exact match (e.g. .env)
		expect(provider.resolveFileIcon(".env")).toEqual({
			type: "url",
			value: "https://icons.example.com/env.svg"
		});

		// 4. Multi-dot extension (e.g. app.test.ts -> test.ts)
		expect(provider.resolveFileIcon("my.component.test.ts")).toEqual({
			type: "url",
			value: "https://icons.example.com/ts_test.svg"
		});

		// 5. Compound archive extension (e.g. bundle.tar.gz -> tar.gz)
		expect(provider.resolveFileIcon("release.v1.0.tar.gz")).toEqual({
			type: "url",
			value: "https://icons.example.com/archive.svg"
		});

		// 6. Standard extension
		expect(provider.resolveFileIcon("main.ts")).toEqual({
			type: "url",
			value: "https://icons.example.com/typescript.svg"
		});

		// 7. Unknown extension returns null (falls back to default file)
		expect(provider.resolveFileIcon("unknown.unknownext123")).toBeNull();
		expect(provider.getDefaultFileIcon()).toEqual({
			type: "url",
			value: "https://icons.example.com/default_file.svg"
		});

		// 8. Named folder
		expect(provider.resolveFolderIcon("src", { expanded: false })).toEqual({
			type: "url",
			value: "https://icons.example.com/dir_src.svg"
		});
		expect(provider.resolveFolderIcon("src", { expanded: true })).toEqual({
			type: "url",
			value: "https://icons.example.com/dir_src_open.svg"
		});
	});

	it("switches appearance seamlessly between light and dark variants", () => {
		const provider = new ManifestIconProvider("stress", "Stress Theme", mockZedTheme, "https://icons.example.com/");

		// Dark appearance (initial default)
		expect(provider.resolveFileIcon("main.ts")).toEqual({
			type: "url",
			value: "https://icons.example.com/typescript.svg"
		});

		// Switch to Light
		provider.setAppearance("light");
		expect(provider.resolveFileIcon("main.ts")).toEqual({
			type: "url",
			value: "https://icons.example.com/typescript_light.svg"
		});

		// Switch back to Dark
		provider.setAppearance("dark");
		expect(provider.resolveFileIcon("main.ts")).toEqual({
			type: "url",
			value: "https://icons.example.com/typescript.svg"
		});
	});

	it("resolves language fallbacks when extension is unknown or missing", () => {
		const provider = new ManifestIconProvider("stress", "Stress Theme", mockZedTheme, "https://icons.example.com/");

		// File without extension, but with language context 'typescript'
		const resolved = provider.resolveFileIcon("scratchpad", { language: "typescript" });
		expect(resolved).toEqual({
			type: "url",
			value: "https://icons.example.com/typescript.svg"
		});
	});

	it("handles malformed or minimal manifests without throwing", () => {
		const minimalTheme: ZedIconTheme = {
			name: "Minimal",
			themes: [{
				name: "Empty Variant",
				appearance: "dark"
			}]
		};

		const provider = new ManifestIconProvider("min", "Minimal", minimalTheme, "https://icons.example.com/");
		expect(provider.resolveFileIcon("test.ts")).toBeNull();
		expect(provider.resolveFolderIcon("src")).toBeNull();
		expect(provider.getDefaultFileIcon()).toBeNull();
		expect(provider.getDefaultFolderIcon()).toBeNull();
	});
});

describe("Adversarial Stress Test: UI IconRegistry & PhosphorIconProvider", () => {
	it("falls back to Phosphor icon when active theme does not have an icon for an extension", () => {
		const registry = new IconRegistry();
		registry.activeFileThemeId = "non-existent-custom";

		// Resolves file icon chain -> starts with non-existent (null), falls back to phosphor
		const chain = registry.resolveFileIconChain("script.ts");
		expect(chain.length).toBeGreaterThan(0);
		expect(chain[0].type).toBe("component");

		const icon = registry.resolveFileIcon("script.ts");
		expect(icon).toBeDefined();
	});

	it("handles unknown extensions by falling back to Phosphor File component", () => {
		const registry = new IconRegistry();
		const icon = registry.resolveFileIcon("data.someveryunusualextensionxyz");
		expect(icon).toBeDefined();
		expect(icon).toBe(registry.getThemeDefaultFileIcon());
	});

	it("prevents uninstallation of builtin themes", async () => {
		const registry = new IconRegistry();
		await registry.uninstallTheme("phosphor");
		await registry.uninstallTheme("material");
		await registry.uninstallTheme("catppuccin");
		await registry.uninstallTheme("vscode");

		const themes = registry.getFileThemes();
		expect(themes.some((t: any) => t.id === "phosphor")).toBe(true);
	});
});

describe("Adversarial Static Grep & AST Invariant Audits", () => {
	it("confirms zero phosphor-svelte in packages/core/package.json", () => {
		const pkg = JSON.parse(readFileSync(resolve(__dirname, "../packages/core/package.json"), "utf-8"));
		expect(pkg.dependencies?.["phosphor-svelte"]).toBeUndefined();
		expect(pkg.peerDependencies?.["phosphor-svelte"]).toBeUndefined();
		expect(pkg.devDependencies?.["phosphor-svelte"]).toBeUndefined();
	});

	it("confirms zero phosphor-svelte imports in packages/core/src/ (excluding tests)", () => {
		function scanDir(dir: string): string[] {
			let violations: string[] = [];
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const fullPath = join(dir, entry);
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					violations = violations.concat(scanDir(fullPath));
				} else if (fullPath.endsWith(".ts") || fullPath.endsWith(".svelte")) {
					if (fullPath.includes(".test.") || fullPath.includes("rune-setup")) continue;
					const content = readFileSync(fullPath, "utf-8");
					if (content.includes("phosphor-svelte")) {
						violations.push(fullPath);
					}
				}
			}
			return violations;
		}

		const violations = scanDir(resolve(__dirname, "../packages/core/src"));
		expect(violations).toEqual([]);
	});

	it("confirms zero HTML export DOM globals in packages/core/src/commands.svelte.ts", () => {
		const content = readFileSync(resolve(__dirname, "../packages/core/src/commands.svelte.ts"), "utf-8");
		
		expect(content).not.toContain("document.createElement");
		expect(content).not.toContain("showSaveFilePicker");
		expect(content).not.toContain("URL.createObjectURL");
		expect(content).not.toContain("URL.revokeObjectURL");
	});

	it("confirms zero window or localStorage in packages/core/src/editor/", () => {
		function scanDir(dir: string): string[] {
			let violations: string[] = [];
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const fullPath = join(dir, entry);
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					violations = violations.concat(scanDir(fullPath));
				} else if (fullPath.endsWith(".ts") || fullPath.endsWith(".svelte")) {
					if (fullPath.includes(".test.")) continue;
					const content = readFileSync(fullPath, "utf-8");
					if (content.includes("window.") || content.includes("localStorage.")) {
						violations.push(fullPath);
					}
				}
			}
			return violations;
		}

		const violations = scanDir(resolve(__dirname, "../packages/core/src/editor"));
		expect(violations).toEqual([]);
	});
});
