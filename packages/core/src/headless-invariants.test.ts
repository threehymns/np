import "../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ManifestIconProvider } from "./editor/icons/manifest-provider";
import { HeadlessIconRegistry } from "./editor/icons/headless-registry.svelte";
import { transformer } from "./transformer";
import { createMockStorage } from "../../../tests/mock-storage";

let AppState: any;

beforeAll(async () => {
	const mod = await import("./state.svelte");
	AppState = mod.AppState;
});

describe("ADR 0002 Headless Core Invariants", () => {
	it("enforces zero phosphor-svelte dependencies in packages/core/package.json", () => {
		const pkgPath = resolve(__dirname, "../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		
		expect(pkg.dependencies?.["phosphor-svelte"]).toBeUndefined();
		expect(pkg.peerDependencies?.["phosphor-svelte"]).toBeUndefined();
		expect(pkg.devDependencies?.["phosphor-svelte"]).toBeUndefined();
	});

	it("instantiates AppState in pure headless environment without UI icon shims", () => {
		const storage = createMockStorage();
		const appState = new AppState({
			storage,
			vcsFactory: () => ({} as any)
		});

		expect(appState).toBeDefined();
		expect(appState.workspace).toBeDefined();
		expect(appState.commands).toBeDefined();
		expect(appState.icons).toBeDefined();
	});

	it("transforms markdown to HTML without DOM or window globals", async () => {
		const markdown = "# Heading 1\n\n- Item 1\n- Item 2\n\n```ts\nconst x = 1;\n```";
		const html = await transformer.transform(markdown, "html");

		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<h1 id=\"heading-1\">Heading 1</h1>");
		expect(html).toContain("<li>Item 1</li>");
		expect(html).toContain("const x = 1;");
	});

	it("resolves manifest icons as pure URL descriptors without Svelte components", () => {
		const mockTheme: any = {
			name: "Test Theme",
			themes: [{
				name: "Test Variant",
				appearance: "dark",
				file_stems: { "package.json": "npm" },
				file_suffixes: { "ts": "typescript" },
				file_icons: {
					npm: { path: "npm.svg" },
					typescript: { path: "typescript.svg" },
					file: { path: "file.svg" }
				}
			}]
		};

		const provider = new ManifestIconProvider("test", "Test", mockTheme, "https://cdn.example.com/icons/");
		const pkgIcon = provider.resolveFileIcon("package.json");
		const tsIcon = provider.resolveFileIcon("index.ts");
		const defIcon = provider.getDefaultFileIcon();

		expect(pkgIcon).toEqual({ type: "url", value: "https://cdn.example.com/icons/npm.svg" });
		expect(tsIcon).toEqual({ type: "url", value: "https://cdn.example.com/icons/typescript.svg" });
		expect(defIcon).toEqual({ type: "url", value: "https://cdn.example.com/icons/file.svg" });
	});

	it("HeadlessIconRegistry provides safe no-op fallbacks without UI components", () => {
		const registry = new HeadlessIconRegistry();
		expect(registry.activeFileThemeId).toBeDefined();
		expect(registry.resolveFileIcon("anything.ts")).toBeNull();
		expect(registry.getFolderIcon("src")).toBeNull();
		expect(registry.getFileThemes()).toEqual([]);
	});

	it("keeps node-only tooling out of the browser-reachable plugins barrel", () => {
		// state.svelte imports the plugins barrel into client code. boundary-check.ts
		// imports typescript + node:fs, which Vite externalizes for browser compatibility
		// and crashes the app at runtime. It is dev/test tooling and must stay directly
		// importable without leaking through the barrel.
		const pluginsDir = resolve(__dirname, "plugins");
		const barrel = readFileSync(resolve(pluginsDir, "index.ts"), "utf-8");
		expect(barrel).not.toMatch(/export\s+[^;]*from\s+['"]\.\/boundary-check['"]/);

		// Generalize the invariant: every module re-exported by the barrel must be free
		// of runtime node:/typescript imports, since the barrel ships to the browser.
		const targets = [...barrel.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
		expect(targets.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const target of targets) {
			const file = resolve(pluginsDir, `${target.slice(2)}.ts`);
			const source = readFileSync(file, "utf-8");
			for (const line of source.split("\n")) {
				if (/^\s*import\s+(?!type\b)[^;]*from\s+['"](node:[^'"]*|typescript)['"]/.test(line)) {
					offenders.push(`${target}: ${line.trim()}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
