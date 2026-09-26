import "../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ManifestIconProvider } from "./editor/icons/manifest-provider";
import { HeadlessIconRegistry } from "./editor/icons/headless-registry.svelte";
import { KeymapRegistry } from "./keymap.svelte";
import { transformer } from "./transformer";
import { createMockStorage } from "../../../tests/mock-storage";

let AppState: any;

beforeAll(async () => {
	const mod = await import("./state.svelte");
	AppState = mod.AppState;
});

/** A keydown carrying only the fields the keymap pipeline reads. */
function pressed(key: string, modifiers: { ctrl?: boolean; alt?: boolean } = {}): KeyboardEvent {
	return {
		key,
		ctrlKey: modifiers.ctrl ?? false,
		metaKey: false,
		altKey: modifiers.alt ?? false,
		shiftKey: false,
		target: { tagName: "DIV" },
		preventDefault() {},
		stopPropagation() {}
	} as unknown as KeyboardEvent;
}

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

	it("rebuilds keymaps after removing one owner and matches a clean build", () => {
		const appState = { commands: { execute: () => undefined } } as any;
		const registry = new KeymapRegistry(appState);
		const clean = new KeymapRegistry(appState);
		const add = (commandId: string) => (previous: readonly any[]) => [
			...previous,
			{ bindings: { [`ctrl+alt+${commandId}`]: commandId } }
		];

		registry.registerKeymapTransform("alpha", add("alpha"));
		registry.registerKeymapTransform("beta", add("beta"));
		clean.registerKeymapTransform("beta", add("beta"));
		registry.removePluginKeymaps("alpha");
		registry.refresh();

		expect(registry.bindings.map((binding) => binding.commandId)).toEqual(
			clean.bindings.map((binding) => binding.commandId)
		);
	});

	it("keeps the base keymap intact when a transform mutates its input", () => {
		const appState = { commands: { execute: () => undefined } } as any;
		const reference = new KeymapRegistry(appState);
		const baseCount = reference.bindings.length;

		const registry = new KeymapRegistry(appState);
		// An impure transform that appends to the array it was handed.
		registry.registerKeymapTransform("impure", (previous) => {
			(previous as any[]).push({ bindings: { "ctrl+alt+leak": "leak.command" } });
			return previous;
		});

		// A registry built afterwards must see the untouched base keymap.
		const later = new KeymapRegistry(appState);
		expect(later.bindings.length).toBe(baseCount);
		expect(later.bindings.some((binding) => binding.commandId === "leak.command")).toBe(false);
		expect(registry.bindings.some((binding) => binding.commandId === "leak.command")).toBe(true);
	});

	it("runs the user's command when a plugin binds the same sequence", () => {
		const executed: string[] = [];
		const appState = { commands: { execute: (id: string) => executed.push(id) } } as any;
		const registry = new KeymapRegistry(appState);

		// A plugin rebinds a default shortcut, and the user binds that same
		// sequence. Last match wins (ADR 0003), so the user must be the winner.
		registry.registerKeymapBindings("plugin", [{ bindings: { "ctrl+alt+i": "plugin.run" } }]);
		registry.reloadUserKeymap(JSON.stringify([{ bindings: { "ctrl+alt+i": "user.run" } }]));

		expect(registry.handleKeydown(pressed("i", { ctrl: true, alt: true }))).toBe(true);
		expect(executed).toEqual(["user.run"]);
	});

	it("keeps default bindings in the base keymap under user bindings", () => {
		const executed: string[] = [];
		const appState = { commands: { execute: (id: string) => executed.push(id) } } as any;
		const registry = new KeymapRegistry(appState);

		registry.reloadUserKeymap(JSON.stringify([{ bindings: { "ctrl+alt+i": "user.run" } }]));

		// The user keymap is stored apart from the defaults, so an untouched
		// default still resolves, and a transform registered afterwards still
		// builds on the defaults.
		expect(registry.handleKeydown(pressed("n", { ctrl: true }))).toBe(true);
		expect(executed).toEqual(["file.new"]);

		registry.registerKeymapBindings("plugin", [{ bindings: { "ctrl+alt+p": "plugin.run" } }]);
		expect(registry.handleKeydown(pressed("p", { ctrl: true, alt: true }))).toBe(true);
		expect(executed).toEqual(["file.new", "plugin.run"]);

		// A registry that never read the user's keymap is unaffected by it.
		const clean = new KeymapRegistry({ commands: { execute: () => undefined } } as any);
		expect(clean.bindings.some((binding) => binding.commandId === "user.run")).toBe(false);
	});

	it("rebuilds icon providers after removing one owner and matches a clean build", () => {
		const provider = (id: string) => ({
			id,
			name: id,
			resolveFileIcon: () => null,
			resolveFolderIcon: () => null,
			getDefaultFileIcon: () => null,
			getDefaultFolderIcon: () => null
		});
		const registry = new HeadlessIconRegistry();
		const clean = new HeadlessIconRegistry();
		const add = (id: string) => (previous: ReadonlyMap<string, any>) =>
			new Map(previous).set(id, provider(id));

		registry.registerFileIconTransform("alpha", add("alpha"));
		registry.registerFileIconTransform("beta", add("beta"));
		clean.registerFileIconTransform("beta", add("beta"));
		registry.removePluginIcons("alpha");
		registry.refresh();

		expect(registry.getFileThemes()).toEqual(clean.getFileThemes());
	});

	it("removes plugin keymap and icon transforms through host lifecycle", async () => {
		const app = new AppState({
			storage: createMockStorage(),
			vcsFactory: () => ({} as any)
		});
		const provider = {
			id: "plugin-theme",
			name: "Plugin Theme",
			resolveFileIcon: () => null,
			resolveFolderIcon: () => null,
			getDefaultFileIcon: () => null,
			getDefaultFolderIcon: () => null
		};
		app.plugins.register({
			manifest: { id: "registry-plugin", name: "Registry Plugin", version: 0 },
			setup: (host) => {
				host.registerKeymapBindings("registry-plugin", [{ bindings: { "ctrl+alt+r": "registry.plugin" } }]);
				host.registerFileIconTransform("registry-plugin", (previous) =>
					new Map(previous).set(provider.id, provider)
				);
			}
		});

		await app.plugins.activate("registry-plugin");
		expect(app.keymaps.bindings.some((binding) => binding.commandId === "registry.plugin")).toBe(true);
		expect(app.icons.getFileThemes().some((theme) => theme.id === provider.id)).toBe(true);

		await app.plugins.deactivate("registry-plugin");
		expect(app.keymaps.bindings.some((binding) => binding.commandId === "registry.plugin")).toBe(false);
		expect(app.icons.getFileThemes().some((theme) => theme.id === provider.id)).toBe(false);
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
