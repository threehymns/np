import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	bundledSearchRoots,
	findCommandOnPath,
	isValidBundledCommand,
	isValidLspCommandName,
	isValidSpawnArgs,
	isValidSpawnCwd,
	resolveLanguageServerCommand,
	resolvePathCommand,
	shimScriptTarget,
} from "./LspCommandResolver";

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

/** The `bundled` declaration the bundled TypeScript descriptor carries. */
const VTSLS = { package: "@vtsls/language-server", binary: "bin/vtsls.js" } as const;

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

	it("never reaches into another editor's install to find its server", () => {
		// Spec #263: "Reaching into other editors' install directories is rejected."
		// True by construction — the walk only goes up from our own app path — but
		// nothing asserted it, so a resolver that grew a second direction, or a
		// fallback that guessed at conventional install paths, would pass every other
		// suite here.
		//
		// Asserted against a layout on disk, and deliberately with **no** copy of our
		// own: the editor's bundle is present and real, so the only way to reach it is
		// to look outside our tree. That is what makes the negative discriminate —
		// with our own copy in place it would pass for the wrong reason, because the
		// walk would have stopped at ours without ever consulting the sibling.
		const root = layout([
			"Code.app/Contents/Resources/app/node_modules/@vtsls/language-server/bin/vtsls.js",
			"Visual Studio Code.app/Contents/Resources/app/node_modules/@vtsls/language-server/bin/vtsls.js",
			"Code.app.unpacked/node_modules/@vtsls/language-server/bin/vtsls.js",
			".vscode-server/bin/node_modules/@vtsls/language-server/bin/vtsls.js"
		]);
		const ours = join(root, "np/resources/app");

		// PATH, and PATH only: no bundled candidate is reachable from our own path.
		const plan = resolveLanguageServerCommand("vtsls", ours, VTSLS);
		expect(plan.source).toBe("path");
		expect(plan.script).toBeUndefined();

		// And the walk itself, stated as the property: every root is our own app
		// directory or an ancestor of it, so nothing sideways is ever a candidate.
		// This is the assertion that fails first if the walk grows a direction.
		for (const candidate of bundledSearchRoots(ours)) {
			expect(ours.startsWith(candidate)).toBe(true);
		}

		// Positive twin, in a layout that has ours: the walk *does* find a bundled
		// server when one is in our own tree, so the negatives above are a rule being
		// honoured rather than a resolver that finds nothing.
		const withOurs = layout(["np/resources/app/node_modules/@vtsls/language-server/bin/vtsls.js"]);
		expect(
			resolveLanguageServerCommand("vtsls", join(withOurs, "np/resources/app"), VTSLS).script
		).toBe(join(withOurs, "np/resources/app/node_modules/@vtsls/language-server/bin/vtsls.js"));
	});

	it("examines a bounded number of directories on a path deep enough to need it", () => {
		// The bound was a constant named for five levels while the loop pushed six,
		// and nothing asserted which, so the count is pinned here: the app's own
		// directory plus five above it, and not the sixth.
		expect(bundledSearchRoots("/a/b/c/d/e/f/g/h/app")).toEqual([
			"/a/b/c/d/e/f/g/h/app",
			"/a/b/c/d/e/f/g/h",
			"/a/b/c/d/e/f/g",
			"/a/b/c/d/e/f",
			"/a/b/c/d/e",
			"/a/b/c/d"
		]);
	});
});

describe("resolveLanguageServerCommand", () => {
	it("resolves the declared name against the packaged dependency first", () => {
		const root = layout(["node_modules/@vtsls/language-server/bin/vtsls.js"]);

		const plan = resolveLanguageServerCommand("vtsls", root, VTSLS);

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
		expect(resolveLanguageServerCommand("vtsls", join(root, "apps/desktop"), VTSLS).source).toBe(
			"bundled"
		);
	});

	it("falls back to the declared name when nothing is bundled", () => {
		const root = layout([]);

		const plan = resolveLanguageServerCommand("vtsls", root, VTSLS);

		// Not "unresolvable": an unresolvable answer would have to become a failure
		// somewhere, and the spawn failing with ENOENT is already how a missing
		// server reaches the log.
		expect(plan).toEqual({ command: "vtsls", args: [], env: {}, source: "path" });
		expect(plan.script).toBeUndefined();
	});

	it("resolves nothing for a name with no bundled package declared", () => {
		const root = layout(["node_modules/@vtsls/language-server/bin/vtsls.js"]);

		// A descriptor that declares no package is a PATH-only server, so the
		// resolution has nothing to look for and hands the name straight back.
		expect(resolveLanguageServerCommand("solargraph", root)).toEqual({
			command: "solargraph",
			args: [],
			env: {},
			source: "path"
		});
	});

	it("reads a second server's bundled package off its own declaration", () => {
		const root = layout(["node_modules/some-server/bin/server.js"]);

		const plan = resolveLanguageServerCommand("some-server", root, {
			package: "some-server",
			binary: "bin/server.js",
		});

		// Which package to look for came from the descriptor, so a second bundled
		// server needed nothing from this resolver (spec #263, story 10).
		expect(plan.source).toBe("bundled");
		expect(plan.script).toBe(join(root, "node_modules/some-server/bin/server.js"));
	});

	it("finds the dependency this workspace actually installs", () => {
		// The one assertion about the real install rather than a fixture: the
		// resolution has to point at a file that exists in this checkout, or the
		// acceptance criterion is being claimed for a package that is not there.
		const appPath = join(import.meta.dir);
		const plan = resolveLanguageServerCommand("vtsls", appPath, VTSLS);

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
/**
 * The Windows PATH fallback.
 *
 * `spawn` without a shell cannot find or run what npm installs on Windows — the
 * name carries no extension the OS recognises, and the file that exists is a
 * batch shim. These are asserted against a fake PATH with injected `exists` and
 * `readText`, because the behaviour being pinned is which *plan* is built; there
 * is no Windows here to spawn on.
 */
describe("the PATH candidate on Windows", () => {
	/** npm's own generated shim, the shape `cmd-shim` writes. */
	function npmShim(scriptPath: string): string {
		return [
			"@ECHO off",
			"GOTO start",
			":find_dp0",
			"SET dp0=%~dp0",
			"EXIT /b",
			":start",
			"SETLOCAL",
			'CALL :find_dp0',
			'IF EXIST "%dp0%\\node.exe" (',
			'\tSET "_prog=%dp0%\\node.exe"',
			") ELSE (",
			'\tSET "_prog=node"',
			'\tSET PATHEXT=%PATHEXT:;.JS;=;%',
			")",
			"endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & %_prog%",
			`"%_prog%"  "%dp0%\\${scriptPath}" %*`,
			":endOfScript",
			""
		].join("\r\n");
	}

	it("leaves a bare name alone where the OS resolves names itself", () => {
		const plan = resolvePathCommand("vtsls", "linux", { PATH: "/usr/bin" }, () => true);
		expect(plan).toEqual({ command: "vtsls", args: [], env: {}, source: "path" });
	});

	it("finds an executable on PATH and runs it directly, with no shell", () => {
		const exists = (candidate: string) => candidate === "C:\\npm\\vtsls.exe";
		const plan = resolvePathCommand("vtsls", "win32", { PATH: "C:\\npm" }, exists, () => null);

		expect(plan).toEqual({
			command: "C:\\npm\\vtsls.exe",
			args: [],
			env: {},
			source: "path"
		});
	});

	it("runs the script an npm shim names, through the interpreter, with no shell", () => {
		// The bug this exists for: `spawn('vtsls')` on Windows cannot execute
		// `vtsls.cmd`, so the PATH candidate resolved the real entry script and
		// ran it the way the bundled candidate is run.
		const shim = "C:\\npm\\vtsls.cmd";
		const target = "C:\\npm\\node_modules\\vtsls\\bin\\vtsls.js";
		const exists = (candidate: string) => candidate === shim || candidate === target;
		const plan = resolvePathCommand(
			"vtsls",
			"win32",
			{ PATH: "C:\\npm" },
			exists,
			(candidate) =>
				candidate === shim
					? npmShim("node_modules\\vtsls\\bin\\vtsls.js")
					: null
		);

		expect(plan).toEqual({
			command: process.execPath,
			args: [target],
			env: { ELECTRON_RUN_AS_NODE: "1" },
			source: "path",
			script: target
		});
	});

	it("falls back to a shell only for a shim whose script it cannot read", () => {
		const shim = "C:\\tools\\weird.cmd";
		const exists = (candidate: string) => candidate === shim;
		const plan = resolvePathCommand(
			"weird",
			"win32",
			{ PATH: "C:\\tools" },
			exists,
			() => "@echo off\r\necho nothing to read here\r\n"
		);

		// A batch file cannot run any other way, so this is the one case where a
		// shell interprets the argument list. Quoted, because the path has spaces
		// in it more often than not.
		expect(plan.command).toBe("cmd.exe");
		expect(plan.args).toEqual(["/d", "/s", "/c", `"${shim}"`]);
	});

	it("leaves the name alone when PATH holds nothing for it", () => {
		const plan = resolvePathCommand("vtsls", "win32", { PATH: "C:\\npm" }, () => false, () => null);
		expect(plan).toEqual({ command: "vtsls", args: [], env: {}, source: "path" });
	});
});

describe("findCommandOnPath", () => {
	it("searches every PATH entry and every extension npm writes", () => {
		const seen: string[] = [];
		const found = findCommandOnPath("vtsls", ["C:\\a", "C:\\b"].join(";"), (candidate) => {
			seen.push(candidate);
			return candidate === "C:\\b\\vtsls.cmd";
		});

		expect(found).toBe("C:\\b\\vtsls.cmd");
		expect(seen).toContain("C:\\a\\vtsls.cmd");
	});

	it("returns null without a PATH rather than searching the process directory", () => {
		expect(findCommandOnPath("vtsls", undefined, () => true)).toBeNull();
	});
});

describe("shimScriptTarget", () => {
	it("refuses a target that does not exist rather than naming a path that fails", () => {
		const shim = "C:\\npm\\vtsls.cmd";
		expect(
			shimScriptTarget(shim, () => '"%_prog%"  "%dp0%\\..\\lib\\node_modules\\vtsls\\bin\\vtsls.js" %*', () => false)
		).toBeNull();
	});

	it("returns null for a file it cannot read", () => {
		expect(shimScriptTarget("C:\\npm\\vtsls.cmd", () => null, () => true)).toBeNull();
	});
});

describe("spawn plan validation", () => {
	it("accepts bare command names and rejects paths", () => {
		expect(isValidLspCommandName("vtsls")).toBe(true);
		expect(isValidLspCommandName("/bin/sh")).toBe(false);
		expect(isValidLspCommandName("vtsls; rm")).toBe(false);
		expect(isValidLspCommandName("")).toBe(false);
	});

	it("accepts the bundled declaration and rejects traversal", () => {
		expect(
			isValidBundledCommand({ package: "@vtsls/language-server", binary: "bin/vtsls.js" })
		).toBe(true);
		expect(isValidBundledCommand(undefined)).toBe(true);
		expect(isValidBundledCommand({ package: "../../etc", binary: "bin/vtsls.js" })).toBe(false);
		expect(isValidBundledCommand({ package: "x", binary: "/absolute" })).toBe(false);
		expect(isValidBundledCommand({ package: "x", binary: "../evil" })).toBe(false);
	});

	it("accepts descriptor args and an absolute cwd, rejects shapes", () => {
		expect(isValidSpawnArgs(["--stdio"])).toBe(true);
		expect(isValidSpawnArgs("nope")).toBe(false);
		expect(isValidSpawnCwd("/repo")).toBe(true);
		expect(isValidSpawnCwd("relative")).toBe(false);
	});
});
