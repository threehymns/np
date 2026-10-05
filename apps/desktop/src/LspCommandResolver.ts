import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Where a declared server command actually runs from (spec #263, #265).
 *
 * A descriptor names an executable, `vtsls`, and nothing here downloads or
 * manages a binary: the host resolves a name the user already has on the
 * machine, and the bundled package is a *fallback-first* resolution of that same
 * name rather than a second way of configuring a server.
 *
 * Spec #263 rejects reaching into other editors' install directories, and that
 * is a property of the *only* direction this searches: upward from the app's own
 * path, never sideways into a conventional install location. Nothing here lists
 * `/Applications/Code.app` or guesses a per-editor layout, because a list is
 * where a second editor's server would come from — and running another editor's
 * copy, at another editor's version, against this app's documents is worse than
 * not finding a server at all. The walk is asserted in
 * `LspCommandResolver.test.ts` against a layout holding real sibling bundles, so
 * a resolver that grew a second direction fails a test rather than shipping.
 *
 * Two candidates, in this order:
 *
 * 1. The dependency the descriptor declares as `bundled`, resolved against the
 *    packaged `node_modules` — which is what makes the proof of concept work on
 *    a machine with nothing installed.
 * 2. The declared name, resolved by the OS against `PATH` — which is what a
 *    developer who installed vtsls themselves gets, and the only candidate on a
 *    build that did not bundle it.
 *
 * Which package candidate one is comes from the descriptor rather than from a
 * table here, so the second server is a second descriptor entry.
 *
 * It has to be the main process. `@np/core` is platform-neutral by rule
 * (ADR 0006) and a renderer has no filesystem, so the resolution happens where
 * `node:path` and `node:fs` exist and travels back over IPC as a spawn plan.
 *
 * The bundled candidate is a **script**, not an executable: npm's `bin` entry
 * for vtsls is `bin/vtsls.js`, which is CommonJS and needs a Node runtime.
 * `process.execPath` in a packaged app is the Electron binary, and Electron only
 * behaves like Node when `ELECTRON_RUN_AS_NODE` is set, so that is what the
 * bundled plan carries. Setting it on the child rather than the parent is the
 * point: the app itself must stay an Electron app.
 */

/**
 * The descriptor's declaration of which packaged package its server ships in,
 * and which script inside it runs.
 *
 * Declared here rather than imported from `@np/core`, and structurally matched
 * by the preload bridge and the renderer adapter: this is the main process's own
 * boundary type, it is compiled apart from the renderer, and the three
 * declarations are three views of one value crossing IPC rather than a shared
 * type three packages must agree on.
 */
export interface BundledServerCommand {
	readonly package: string;
	readonly binary: string;
}

export interface ResolvedServerCommand {
	/** What `spawn` is given as its command. */
	readonly command: string;
	/** Arguments prepended to the descriptor's own. */
	readonly args: readonly string[];
	/** Environment overrides for this spawn only. */
	readonly env: Readonly<Record<string, string>>;
	/** Which of the two candidates answered, for the log line. */
	readonly source: 'bundled' | 'path';
	/**
	 * The Node script this plan runs, when the command had to become one — the
	 * bundled entry script, or the script a Windows shim named. Absent when the
	 * plan runs the resolved command itself.
	 */
	readonly script?: string;
}

/**
 * How many directories the walk examines, the app's own directory included.
 *
 * A workspace hoists, so in development the dependency sits at the repository
 * root rather than beside `apps/desktop`; in a packaged app it sits inside the
 * app itself and no walk is needed. Six levels reaches a hoisted monorepo
 * without walking to the filesystem root on a machine that simply does not
 * have it — a cap rather than the only thing stopping it, since the loop
 * breaks at the root anyway.
 */
const MAX_WALK_LEVELS = 6;

/**
 * The directories a bundled `node_modules` might live in, most specific first.
 *
 * The `.unpacked` sibling comes before the asar itself and before the walk
 * because a script inside `app.asar` can be read but not executed, and because
 * Node resolves a script's dependencies by walking up from the script's real
 * location: everything the entry package requires has to be unpacked alongside
 * it or the require fails even though `existsSync` said yes. That is why
 * `asarUnpack` in `apps/desktop/package.json` lists the whole dependency closure
 * rather than just the entry package.
 *
* That closure, for the bundled TypeScript server, is:
 *
 * - `@vtsls/language-server` (the entry script) and `@vtsls/language-service`,
 *   which requires `@vtsls/vscode-fuzzy`, `@vscode/l10n`, `semver`,
 *   `vscode-languageserver-protocol`, `vscode-languageserver-textdocument` and
 *   `vscode-uri`;
 * - `vscode-languageserver`, `vscode-jsonrpc` and `vscode-languageserver-types`,
 *   which the entry requires directly;
 * - `typescript`, which the language service resolves at runtime rather than
 *   requiring statically — `createRequire(...).resolve('typescript')` — and which
 *   in turn requires `source-map-support`, `source-map` and `buffer-from` from
 *   its own `tryEnableSourceMapsForHost`. Three more packages that no walk of the
 *   language server's own sources would find;
 * - `jsonc-parser`, a declared runtime dependency of the language service that the
 *   shipped `dist` does not reach today. It is unpacked anyway: the cost is a few
 *   kilobytes, and the alternative is a server that dies on whichever code path
 *   turns out to need it.
 *
 * `LspPackaging.test.ts` asserts that list against the closure rather than
 * against a copy of itself, so a dependency that arrives without being unpacked
 * fails a test instead of failing on a user's machine. To re-derive it by hand:
 * walk `require(` out of `node_modules/@vtsls/language-server/bin/vtsls.js` and
 * every file that reaches, resolving each specifier from the requiring file's own
 * real path, and add every package named in a `dependencies` block of anything on
 * that walk. Two packages are deliberately absent: `@parcel/watcher`, which
 * nothing in the closure needs and which is not installed, and the
 * devDependency `electron-builder`, which never ships.
 */
export function bundledSearchRoots(appPath: string): string[] {
	const roots: string[] = [];
	if (appPath.endsWith('.asar')) roots.push(`${appPath}.unpacked`);
	let directory = appPath.endsWith('.asar') ? path.dirname(appPath) : appPath;
	for (let depth = 0; depth < MAX_WALK_LEVELS; depth++) {
		roots.push(directory);
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return roots;
}

/**
 * Extensions a Windows command can carry, most specific first.
 *
 * `PATHEXT` decides this for an interactive shell, and `spawn` without a shell
 * does not consult it: CreateProcess appends `.exe` and nothing else, so an npm
 * bin installed as `vtsls.cmd` — plus an extensionless POSIX shim beside it — is
 * invisible to a bare `spawn('vtsls')`. The order matters only in that a real
 * executable beats a batch file.
 */
const WINDOWS_COMMAND_EXTENSIONS = ['.exe', '.cmd', '.bat', ''] as const;

/**
 * `path.win32` rather than `path`, named explicitly.
 *
 * On Windows they are the same module, so this changes nothing there. Naming the
 * flavour is what lets the Windows behaviour be asserted from a test running
 * anywhere, which matters because a bug in it is invisible on a machine where
 * `spawn('vtsls')` happens to work.
 */
const windows = path.win32;

/**
 * The PATH entry that holds `command` on Windows, or null when none does.
 *
 * Written out rather than delegated to the OS because the OS lookup is the one
 * thing that cannot find a `.cmd`. Each entry is joined with the command and
 * each extension tried, which is what `where.exe` does; `exists` is injected so
 * the search is assertable without a Windows machine.
 */
export function findCommandOnPath(
	command: string,
	pathValue: string | undefined,
	exists: (candidate: string) => boolean
): string | null {
	if (!pathValue) return null;
	for (const entry of pathValue.split(windows.delimiter)) {
		if (entry.length === 0) continue;
		for (const extension of WINDOWS_COMMAND_EXTENSIONS) {
			const candidate = windows.join(entry, `${command}${extension}`);
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * The Node script an npm shim runs, or null when the shim is not one.
 *
 * npm generates a Windows shim through `cmd-shim`, whose invocation line is
 *
 *   "%_prog%"  "%dp0%\..\pkg\bin\server.js" %*
 *
 * so the target is the first quoted argument on the line that calls `%_prog%`,
 * with `%dp0%` standing for the shim's own directory. That is enough to name the
 * file, and the file is then required to exist before it is used — an
 * unrecognised shim shape returns null rather than a path that would fail later.
 *
 * npm has written this shape for years and both sides are generated by it, which
 * is what makes parsing a closed format rather than guessing at a language.
 */
export function shimScriptTarget(
	shimPath: string,
	readText: (candidate: string) => string | null,
	exists: (candidate: string) => boolean
): string | null {
	const text = readText(shimPath);
	if (text === null) return null;
	const directory = windows.dirname(shimPath);
	for (const line of text.split(/\r?\n/)) {
		if (!line.includes('%_prog%')) continue;
		// Every quoted run on the invocation line, skipping blanks: the token
		// itself is quoted too, so taking the first pair would read `"  "` and
		// stop there.
		for (const quoted of line.matchAll(/"([^"]*)"/g)) {
			const candidate = quoted[1];
			if (candidate.trim().length === 0 || candidate === '%_prog%') continue;
			const target = windows.resolve(directory, candidate.replaceAll('%dp0%', directory));
			if (exists(target)) return target;
		}
	}
	return null;
}

/**
 * The PATH candidate, made runnable.
 *
 * On POSIX a bare name is exactly what `spawn` wants: the OS resolves it against
 * PATH and the shebang in the script picks the interpreter. Windows has no such
 * step for a `.cmd`, so the name is resolved here instead:
 *
 * - an `.exe` runs as it is, with no shell;
 * - a `.cmd`/`.bat` is an npm shim in practice, so the script it names is run
 *   through the same interpreter the bundled candidate uses — which is the
 *   resolution the bundled path already takes, and no shell at all;
 * - a shim whose script cannot be read falls back to `cmd.exe`, because a batch
 *   file cannot be executed any other way. That last case is the only one where
 *   the argument list is interpreted by a shell, so it is the one place a
 *   descriptor's arguments have to be shell-safe: they are repository data, and
 *   a server needing metacharacters belongs in a bundled script, where no shell
 *   is involved at any point.
 */
export function resolvePathCommand(
	command: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	exists: (candidate: string) => boolean = existsSync,
	readText: (candidate: string) => string | null = defaultReadText
): ResolvedServerCommand {
	const bare: ResolvedServerCommand = { command, args: [], env: {}, source: 'path' };
	// A command that already names a path, or a platform where the OS resolves
	// names itself, needs none of this.
	if (platform !== 'win32' || command.includes('/') || command.includes('\\')) return bare;
	const found = findCommandOnPath(command, env.PATH, exists);
	if (!found) return bare;
	if (found.toLowerCase().endsWith('.exe')) return { ...bare, command: found };
	const script = shimScriptTarget(found, readText, exists);
	if (script) {
		return {
			command: process.execPath,
			args: [script],
			env: { ELECTRON_RUN_AS_NODE: '1' },
			source: 'path',
			script
		};
	}
	return {
		command: 'cmd.exe',
		args: ['/d', '/s', '/c', `"${found}"`],
		env: {},
		source: 'path'
	};
}

function defaultReadText(candidate: string): string | null {
	try {
		return readFileSync(candidate, 'utf-8');
	} catch {
		return null;
	}
}

/**
 * Resolves one declared command into a spawn plan.
 *
 * Which package to look for is *not* decided here. The descriptor says which
 * package its server ships as, and this function is handed that, so a second
 * bundled server is a second descriptor rather than a second line in a resolver's
 * private map — the property spec #263 asks for when it says the second server
 * should be configuration only.
 *
 * Never throws and never returns "nothing": a command with no bundled candidate
 * degrades to itself, so the spawn fails with the ENOENT the client already
 * reports as a start failure. A resolution layer that swallowed the failure would
 * turn a missing server into silence, which is exactly what `words: 'fallback'`
 * exists to prevent.
 *
 * `exists` is injected so the resolution can be asserted against a directory
 * laid out on disk rather than against whatever happens to be installed.
 */
export function resolveLanguageServerCommand(
	command: string,
	appPath: string,
	bundled?: BundledServerCommand,
	exists: (candidate: string) => boolean = existsSync
): ResolvedServerCommand {
	if (bundled) {
		const segments = ['node_modules', ...bundled.package.split('/'), ...bundled.binary.split('/')];
		for (const root of bundledSearchRoots(appPath)) {
			const script = path.join(root, ...segments);
			if (!exists(script)) continue;
			return {
				command: process.execPath,
				args: [script],
				env: { ELECTRON_RUN_AS_NODE: '1' },
				source: 'bundled',
				script
			};
		}
	}
	return resolvePathCommand(command, process.platform, process.env, exists);
}
