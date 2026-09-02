import "./contract/rune-setup";
import { describe, it, expect, beforeAll } from "bun:test";

let AppState: any;
let HeadlessIconRegistry: any;
let ManifestIconProvider: any;
let createMockStorage: any;

beforeAll(async () => {
	const core = await import("../packages/core/src");
	AppState = core.AppState;
	HeadlessIconRegistry = core.HeadlessIconRegistry;
	ManifestIconProvider = core.ManifestIconProvider;

	const mockStorageMod = await import("./mock-storage");
	createMockStorage = mockStorageMod.createMockStorage;
});

describe("Clean Headless Subprocess Invariant Verification", () => {
	it("verifies zero DOM or browser globals in headless execution environment", () => {
		expect(typeof window).toBe("undefined");
		expect(typeof document).toBe("undefined");
		expect(typeof localStorage).toBe("undefined");
	});

	it("instantiates AppState with pure HeadlessIconRegistry without UI shims", () => {
		const storage = createMockStorage();
		const appState = new AppState({
			storage,
			vcsFactory: () => ({} as any)
		});

		expect(appState).toBeDefined();
		expect(appState.icons).toBeInstanceOf(HeadlessIconRegistry);
	});

	it("completes deferred AppState.init() in headless mode cleanly", async () => {
		const storage = createMockStorage();
		const appState = new AppState({
			storage,
			vcsFactory: () => ({} as any)
		});

		await expect(appState.init()).resolves.toBeUndefined();
	});

	it("executes core export commands without DOM dependencies", async () => {
		const storage = createMockStorage();
		const appState = new AppState({
			storage,
			vcsFactory: () => ({} as any)
		});

		await expect(appState.commands.execute("transformer.exportHTML")).resolves.toBeUndefined();
		await expect(appState.commands.execute("transformer.copyHTML")).resolves.toBeUndefined();
		expect(() => appState.commands.execute("file.new")).not.toThrow();
	});

	it("safely resolves icons via HeadlessIconRegistry in pure headless environment", () => {
		const registry = new HeadlessIconRegistry();
		expect(registry.resolveFileIcon("test.ts")).toBeNull();
		expect(registry.resolveFileIconChain("test.ts")).toEqual([]);
		expect(registry.getFileThemes()).toEqual([]);
	});

	it("resolves pure URL icon descriptors via ManifestIconProvider without Svelte runtime components", () => {
		const mockTheme: any = {
			name: "Headless Mock",
			themes: [{
				name: "Mock Variant",
				appearance: "dark",
				file_stems: { "package.json": "npm" },
				file_suffixes: { "ts": "typescript" },
				file_icons: {
					npm: { path: "npm.svg" },
					typescript: { path: "typescript.svg" }
				}
			}]
		};

		const manifestProvider = new ManifestIconProvider("mock", "Mock", mockTheme, "https://icons.example.com/");
		const resolvedManifest = manifestProvider.resolveFileIcon("package.json");
		expect(resolvedManifest).toEqual({
			type: "url",
			value: "https://icons.example.com/npm.svg"
		});
	});
});
