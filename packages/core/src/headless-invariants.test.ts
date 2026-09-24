import "../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

		// The transitive invariant lives in the "Browser bundle boundary" suite below.
	});
});

/**
 * Direct re-exports are not enough: the failure mode is *any* module in the
 * statically-reachable browser graph gaining a runtime node:/typescript import
 * (e.g. host.svelte.ts importing node:async_hooks). Vite externalizes those for
 * the browser and the app dies at import time, so walk the whole graph.
 */
const NODE_ONLY_SPECIFIERS = /^(node:|typescript$)/;

/** Static import/export specifiers with their type-only (erased) flag. */
function staticSpecifiers(source: string): { specifier: string; typeOnly: boolean }[] {
	const found: { specifier: string; typeOnly: boolean }[] = [];
	const clause = /(?:^|[\s;{}()])(?:import|export)\s+(type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/g;
	const sideEffect = /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;
	for (const match of source.matchAll(clause)) {
		found.push({ specifier: match[2], typeOnly: Boolean(match[1]) });
	}
	for (const match of source.matchAll(sideEffect)) {
		found.push({ specifier: match[1], typeOnly: false });
	}
	return found;
}

/** Resolve a relative specifier to the file Vite would load, or null. */
function resolveSourceFile(specifier: string, fromFile: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.svelte.ts`,
		`${base}.svelte`,
		`${base}.js`,
		join(base, "index.ts")
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/** Every file the client bundle can statically reach from the app entries. */
function collectClientEntries(repoRoot: string): string[] {
	const entries = [
		join(repoRoot, "packages/core/src/index.ts"),
		join(repoRoot, "packages/ui/src/index.ts")
	].filter((file) => existsSync(file));

	for (const root of [join(repoRoot, "apps/web/src"), join(repoRoot, "apps/desktop/src/renderer")]) {
		if (!existsSync(root)) continue;
		const queue = [root];
		while (queue.length > 0) {
			const dir = queue.pop()!;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!["node_modules", ".svelte-kit", "dist"].includes(entry.name)) queue.push(path);
				} else if (/\.(ts|svelte)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
					entries.push(path);
				}
			}
		}
	}
	return entries;
}

describe("Browser bundle boundary", () => {
	it("statically-reachable client code never imports node: or typescript", () => {
		const repoRoot = resolve(__dirname, "../../..");
		const seen = new Set<string>();
		const offenders: string[] = [];
		const queue = collectClientEntries(repoRoot);
		expect(queue.length).toBeGreaterThan(0);

		while (queue.length > 0) {
			const file = queue.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			for (const { specifier, typeOnly } of staticSpecifiers(readFileSync(file, "utf-8"))) {
				// Type-only imports are erased before bundling; only runtime imports matter.
				if (typeOnly) continue;
				if (NODE_ONLY_SPECIFIERS.test(specifier)) {
					offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
					continue;
				}
				const resolved = resolveSourceFile(specifier, file);
				if (resolved && !seen.has(resolved)) queue.push(resolved);
			}
		}

		expect(seen.size).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});
