import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundledSearchRoots, resolveLanguageServerCommand } from "./LspCommandResolver";

/**
 * Bundled command resolution (spec #263, #265).
 *
 * The claim is the acceptance criterion's first half: a TypeScript server runs
 * on a machine with nothing installed. That rests on one function — a declared
 * name resolving to a spawn plan — so the function is asserted directly, against
 * layouts built on disk rather than against whatever happens to be installed on
 * the machine running the suite.
 *
 * What is *not* asserted here is that a packaged Electron app contains the
 * dependency: that is `asarUnpack` in `apps/desktop/package.json` plus an
 * electron-builder run, which this suite has no way to perform.
 */

const roots: string[] = [];

function layout(files: readonly string[]): string {
	const root = mkdtempSync(join(tmpdir(), "lsp-resolution-"));
	roots.push(root);
	for (const relative of files) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "#!/usr/bin/env node\n");
	}
	return root;
}

function cleanup(): void {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}

afterEach(cleanup);

describe("bundledSearchRoots", () => {
	it("prefers the unpacked sibling of an asar, because a script inside one cannot run", () => {
		expect(bundledSearchRoots("/opt/np/resources/app.asar")[0]).toBe(
			"/opt/np/resources/app.asar.unpacked"
		);
		// Then the walk, which is what a hoisted workspace layout needs.
		expect(bundledSearchRoots("/opt/np/resources/app.asar")).toEqual([
			"/opt/np/resources/app.asar.unpacked",
			"/opt/np/resources",
			"/opt/np",
			"/opt",
			"/",
		]);
	});

	it("walks up from the app directory in development, where the repository hoists", () => {
		const roots = bundledSearchRoots("/repo/apps/desktop");
		expect(roots[0]).toBe("/repo/apps/desktop");
		expect(roots).toContain("/repo");
		// A workspace hoist lands two levels up, and the walk has to reach it.
		expect(roots.indexOf("/repo")).toBeLessThan(roots.indexOf("/repo/apps/desktop") + 3);
	});

	it("stops at the filesystem root instead of looping", () => {
		expect(bundledSearchRoots("/").at(-1)).toBe("/");
	});
});

describe("resolveLanguageServerCommand", () => {
	it("resolves the declared name against the packaged dependency first", () => {
		const root = layout(["node_modules/@vtsls/language-server/bin/vtsls.js"]);

		const plan = resolveLanguageServerCommand("vtsls", root);

		expect(plan.source).toBe("bundled");
		expect(plan.script).toBe(
			join(root, "node_modules/@vtsls/language-server/bin/vtsls.js")
		);
		// A Node script, so it needs an interpreter and the one variable that turns
		// the Electron binary into one. Spawning the script directly would either
		// start a second Electron app or fail outright.
		expect(plan.command).toBe(process.execPath);
		expect(plan.args).toEqual([plan.script]);
		expect(plan.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
	});

	it("finds a hoisted dependency from a nested app directory", () => {
		const root = layout(["node_modules/@vtsls/language-server/bin/vtsls.js"]);

		// Development shape: `apps/desktop` is the app and the workspace hoisted the
		// dependency to the repository root.
		expect(resolveLanguageServerCommand("vtsls", join(root, "apps/desktop")).source).toBe(
			"bundled"
		);
	});

	it("falls back to the declared name when nothing is bundled", () => {
		const root = layout([]);

		const plan = resolveLanguageServerCommand("vtsls", root);

		// Not "unresolvable": an unresolvable answer would have to become a failure
		// somewhere, and the spawn failing with ENOENT is already how a missing
		// server reaches the log.
		expect(plan).toEqual({ command: "vtsls", args: [], env: {}, source: "path" });
		expect(plan.script).toBeUndefined();
	});

	it("resolves nothing for a name it has no bundled package for", () => {
		const root = layout(["node_modules/@vtsls/language-server/bin/vtsls.js"]);

		expect(resolveLanguageServerCommand("solargraph", root)).toEqual({
			command: "solargraph",
			args: [],
			env: {},
			source: "path"
		});
	});

	it("finds the dependency this workspace actually installs", () => {
		// The one assertion about the real install rather than a fixture: the
		// resolution has to point at a file that exists in this checkout, or the
		// acceptance criterion is being claimed for a package that is not there.
		const appPath = join(import.meta.dir);
		const plan = resolveLanguageServerCommand("vtsls", appPath);

		if (plan.source !== "bundled") {
			throw new Error(
				"The bundled vtsls dependency was not resolvable from apps/desktop.\n" +
					"Action: Run `bun install` so apps/desktop/node_modules contains @vtsls/language-server."
			);
		}
		expect(existsSync(plan.script!)).toBe(true);
		expect(plan.script).toContain("@vtsls/language-server");
	});
});