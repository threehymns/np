import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where a declared server command actually runs from (spec #263, #265).
 *
 * A descriptor names an executable, `vtsls`, and nothing here downloads or
 * manages a binary: the host resolves a name the user already has on the
 * machine, and the bundled package is a *fallback-first* resolution of that same
 * name rather than a second way of configuring a server. Two candidates, in
 * this order:
 *
 * 1. The dependency declared in `apps/desktop/package.json`, resolved against
 *    the packaged `node_modules` — which is what makes the proof of concept
 *    work on a machine with nothing installed.
 * 2. The declared name, resolved by the OS against `PATH` — which is what a
 *    developer who installed vtsls themselves gets, and the only candidate on a
 *    build that did not bundle it.
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

export interface ResolvedServerCommand {
	/** What `spawn` is given as its command. */
	readonly command: string;
	/** Arguments prepended to the descriptor's own. */
	readonly args: readonly string[];
	/** Environment overrides for this spawn only. */
	readonly env: Readonly<Record<string, string>>;
	/** Which of the two candidates answered, for the log line. */
	readonly source: 'bundled' | 'path';
	/** The bundled script, when one answered. Absent on the PATH fallback. */
	readonly script?: string;
}

interface BundledServer {
	/** The npm package the dependency was declared under. */
	readonly package: string;
	/** Path within that package, from its `bin` entry. */
	readonly binary: string;
}

/**
 * Command name to bundled package. This is the *only* place a name becomes a
 * path, so a second server is a second line here rather than a new resolution
 * path — which is the property spec #263 asks for.
 */
const BUNDLED_SERVERS: Readonly<Record<string, BundledServer>> = {
	vtsls: { package: '@vtsls/language-server', binary: 'bin/vtsls.js' }
};

/**
 * How far above the app to look for a hoisted `node_modules`.
 *
 * A workspace hoists, so in development the dependency sits at the repository
 * root rather than beside `apps/desktop`; in a packaged app it sits inside the
 * app itself and no walk is needed. Five levels covers a monorepo without
 * walking to the filesystem root on a machine that simply does not have it.
 */
const MAX_ROOT_WALK = 5;

/**
 * The directories a bundled `node_modules` might live in, most specific first.
 *
 * The `.unpacked` sibling comes before the asar itself and before the walk
 * because a script inside `app.asar` can be read but not executed, and because
 * Node resolves a script's dependencies by walking up from the script's real
 * location: everything `@vtsls/language-server` requires has to be unpacked
 * alongside it or the require fails even though `existsSync` said yes. That is
 * why `asarUnpack` in `apps/desktop/package.json` lists the whole dependency
 * closure rather than just the entry package.
 */
export function bundledSearchRoots(appPath: string): string[] {
	const roots: string[] = [];
	if (appPath.endsWith('.asar')) roots.push(`${appPath}.unpacked`);
	let directory = appPath.endsWith('.asar') ? path.dirname(appPath) : appPath;
	for (let depth = 0; depth <= MAX_ROOT_WALK; depth++) {
		roots.push(directory);
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return roots;
}

/**
 * Resolves one declared command into a spawn plan.
 *
 * Never throws and never returns "nothing": an unresolvable name degrades to
 * itself, so the spawn fails with the ENOENT the client already reports as a
 * start failure. A resolution layer that swallowed the failure would turn a
 * missing server into silence, which is exactly what `words: 'fallback'` exists
 * to prevent.
 *
 * `exists` is injected so the resolution can be asserted against a directory
 * laid out on disk rather than against whatever happens to be installed.
 */
export function resolveLanguageServerCommand(
	command: string,
	appPath: string,
	exists: (candidate: string) => boolean = existsSync
): ResolvedServerCommand {
	const bundled = BUNDLED_SERVERS[command];
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
	return { command, args: [], env: {}, source: 'path' };
}