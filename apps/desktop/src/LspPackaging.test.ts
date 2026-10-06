import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * What the packaged app has to carry for the bundled server to start.
 *
 * A language server is spawned as a plain Node process running a script from
 * `app.asar.unpacked`, so every module that script reaches is resolved from that
 * unpacked tree. Anything left inside the asar is unreachable: Node cannot read
 * it, and the failure is the server dying at startup on a machine that has
 * nothing installed — the exact machine spec #263 promises will work.
 *
 * `asarUnpack` is a hand-written list, and a hand-written list drifts from a
 * dependency tree that moves on its own. So the list is asserted against the
 * closure instead of against a copy of itself: every package reachable from the
 * entry script, by `require` or by a declared runtime dependency, has to match a
 * pattern in `apps/desktop/package.json`.
 *
 * What this cannot check is that electron-builder honours the patterns — that
 * needs a full packaged build, which no test here can perform. What it does check
 * is the part that is wrong in a source checkout: the list and the closure.
 */

const requirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const resolvePattern = /\bresolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * The installed package a file belongs to, or null for anything outside one.
 *
 * Walked up to the directory that sits directly inside a `node_modules`. That
 * directory is normally the package itself, but it may be a scope (`@vtsls`),
 * and then the package is the child *the file is actually under*.
 *
 * The child has to come from the file's own path. Taking the first name the
 * directory happens to list attributes every file in a scope to whichever sibling
 * the filesystem enumerated first, and a scope is not guaranteed to hold one
 * package: bun's store puts `@vtsls/language-service` and
 * `@vtsls/language-server` in the same `@vtsls` directory. That mistake does not
 * merely lose a package, it renames one — the walk reads the sibling's manifest,
 * so it walks the sibling's dependencies and reports the sibling's name, and both
 * answers depend on `readdir` order. ext4 enumerates in hash order, so the same
 * commit produced a passing closure on one machine and a truncated one on another.
 */
function packageRootOf(file: string): string | null {
	let directory = path.dirname(file);
	for (;;) {
		const parent = path.dirname(directory);
		if (path.basename(parent) !== 'node_modules') {
			if (parent === directory) return null;
			directory = parent;
			continue;
		}
		if (!path.basename(directory).startsWith('@')) {
			return existsSync(path.join(directory, 'package.json')) ? directory : null;
		}
		const child = readdirSync(directory).find((name) =>
			file.startsWith(path.join(directory, name) + path.sep)
		);
		const scoped = child ? path.join(directory, child) : null;
		return scoped && existsSync(path.join(scoped, 'package.json')) ? scoped : null;
	}
}

/**
 * A package's name as npm knows it — `@vtsls/language-service`, not the path
 * segments a walk produced. The manifest's own `name` is authoritative, and the
 * node_modules-relative path is the fallback for a package that ships without one.
 */
function packageNameOf(file: string): string | null {
	const manifest = manifestOf(file);
	if (typeof manifest?.name === 'string') return manifest.name;
	const root = packageRootOf(file);
	if (!root) return null;
	const relative = path.relative(path.dirname(path.dirname(root)), root).split(path.sep);
	return relative[0].startsWith('@') ? `${relative[0]}/${relative[1]}` : relative[0];
}

function manifestOf(file: string): Record<string, unknown> | null {
	const root = packageRootOf(file);
	if (!root) return null;
	try {
		return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
	} catch {
		return null;
	}
}

/** The extensions and index files Node itself will settle a bare specifier on. */
const SOURCE_SUFFIXES = ['.js', '.cjs', '.mjs'];
const SOURCE_INDEXES = ['index.js', 'index.cjs', 'index.mjs'];

function fileAt(candidate: string): string | null {
	try {
		const real = realpathSync(candidate);
		return statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}

/** What Node loads when a require names a directory rather than a file. */
function manifestEntryOf(directory: string): string | null {
	try {
		const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf-8')) as {
			main?: unknown;
		};
		return typeof manifest.main === 'string' ? path.resolve(directory, manifest.main) : null;
	} catch {
		return null;
	}
}

/**
 * The source file a resolved target names, or null when it names none.
 *
 * A resolved target is not always that file: a relative specifier compiled to
 * `./connection` is `connection.js` on disk, and a directory is its index or its
 * manifest's `main`. Node settles those shapes itself, so a walk that reads source
 * has to accept them too — a target dropped here is not one missing file but
 * everything that file would have required, which on this tree was 72 targets
 * spread over six packages.
 */
function readableFile(target: string): string | null {
	const direct = fileAt(target);
	if (direct) return direct;
	for (const suffix of SOURCE_SUFFIXES) {
		const file = fileAt(target + suffix);
		if (file) return file;
	}
	for (const index of SOURCE_INDEXES) {
		const file = fileAt(path.join(target, index));
		if (file) return file;
	}
	const entry = manifestEntryOf(target);
	return entry ? fileAt(entry) : null;
}

/** Node's own modules, which no packaging decision can affect. */
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** What a walk over the entry script reached, and what it could not. */
interface Closure {
	/** Every package name the walk reached. */
	packages: Set<string>;
	/** Every file the walk read, in the order it read them. */
	files: string[];
	/**
	 * Every target the walk resolved but could not read. Non-empty means the walk
	 * stopped short, and a stopped walk reports an absent package rather than the
	 * path it gave up on.
	 */
	unreadable: string[];
}

/**
 * Every package reachable from the entry script.
 *
 * Three ways in, because the server uses all three: a direct `require`, a
 * `createRequire(...).resolve('typescript')` that no `require(` walk would find,
 * and a declared runtime dependency the shipped `dist` happens not to reach today.
 * Resolution is from the requiring file's own directory, which is what Node does
 * and why the answer is about a package tree rather than about a single folder.
 */
function runtimeClosure(entry: string): Closure {
	const found = new Set<string>();
	const files: string[] = [];
	const unreadable: string[] = [];
	const queue = [path.resolve(entry)];
	const seen = new Set<string>();
	const resolveFrom = (specifier: string, from: string): string | null => {
		if (BUILTINS.has(specifier)) return null;
		try {
			return Bun.resolveSync(specifier, from);
		} catch {
			return null;
		}
	};
	while (queue.length > 0) {
		// Read through the real path, because Node does: a workspace install puts
		// the package behind a symlink into a store where its own dependencies
		// live, and resolving from the link would report packages that a packaged
		// build — real directories — has.
		const target = queue.pop()!;
		const file = readableFile(target);
		if (!file) {
			// The same target can be queued from two packages' dependency lists, so
			// report each loss once.
			if (!unreadable.includes(target)) unreadable.push(target);
			continue;
		}
		if (seen.has(file)) continue;
		seen.add(file);
		files.push(file);
		const name = packageNameOf(file);
		if (name) found.add(name);
		const manifest = manifestOf(file);
		for (const dependency of Object.keys(manifest?.dependencies ?? {})) {
			const resolved = resolveFrom(dependency, path.dirname(file));
			if (resolved) queue.push(resolved);
			else found.add(dependency);
		}
		let source: string;
		try {
			source = readFileSync(file, 'utf-8');
		} catch {
			continue;
		}
		for (const pattern of [requirePattern, resolvePattern]) {
			for (const match of source.matchAll(pattern)) {
				const specifier = match[1];
				const resolved = specifier.startsWith('.')
					? path.resolve(path.dirname(file), specifier)
					: resolveFrom(specifier, path.dirname(file));
				if (resolved) queue.push(resolved);
				else if (!BUILTINS.has(specifier)) found.add(specifier);
			}
		}
	}
	return { packages: found, files, unreadable };
}

/**
 * Whether `asarUnpack` unpacks a package.
 *
 * electron-builder's patterns name *files inside* a directory, so what matters
 * for a package is whether a pattern's literal prefix reaches it: the trailing
 * recursive wildcard after `node_modules/vscode-uri/` already covers every file
 * in that package. The prefix is read up to the first wildcard and matched from
 * the start and to a path boundary, which is what makes `node_modules/vscode-`
 * count for `vscode-uri` and `node_modules/source-map/` *not* count for
 * `source-map-support`.
 */
function asarCovers(name: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		// Everything before the recursive wildcard is the directory the pattern
		// covers, and it may itself end in a wildcard — `node_modules/vscode-*`
		// is what makes one line count for six packages.
		const directory = pattern.split('/**')[0];
		const source = directory.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+$/, '[^/]*');
		return new RegExp(`^${source}(?:/|$)`).test(`node_modules/${name}`);
	});
}

function asarPatterns(): string[] {
	const manifest = JSON.parse(
		readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf-8')
	) as { build: { asarUnpack?: string[] } };
	return manifest.build.asarUnpack ?? [];
}

function findEntry(): string {
	// The workspace hoists, so the package sits at the repository root in
	// development and inside the app in a packaged build; this walks up for it.
	let directory = import.meta.dir;
	for (;;) {
		const candidate = path.join(directory, 'node_modules', '@vtsls', 'language-server', 'bin', 'vtsls.js');
		try {
			readFileSync(candidate, 'utf-8');
			return candidate;
		} catch {
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	throw new Error(
		'The bundled language server entry script was not found.\n' +
			'Action: Run `bun install`, which installs apps/desktop\'s @vtsls/language-server dependency.'
	);
}

describe('the packaged server closure (#263, #265)', () => {
	const entry = findEntry();

	it('reaches every runtime package the entry script needs', () => {
		// Guards the guard: if the walk stopped finding the packages below, a list
		// that matched it would prove nothing.
		const { packages } = runtimeClosure(entry);
		// One assertion naming what is absent, rather than eight identical ones.
		// Every way this walk can come up short — `Bun.resolveSync`,
		// `realpathSync` and `readFileSync` are each wrapped in a bare catch that
		// reports nothing — otherwise surfaces as the same
		// `Expected length: 1 / Received length: 0`, which cannot say which package
		// went missing or why. The set holds a name once, so `filter(...).length`
		// was already 0 or 1 and this asserts exactly what it did.
		const missing = [
			'@vtsls/language-service',
			'@vtsls/vscode-fuzzy',
			'@vscode/l10n',
			'vscode-languageserver',
			'vscode-jsonrpc',
			'jsonc-parser',
			'semver',
			'typescript'
		].filter((name) => !packages.has(name));
		expect(missing).toEqual([]);
	});

	it('unpacks every package the entry script needs', () => {
		const patterns = asarPatterns();
		const missing = [...runtimeClosure(entry).packages]
			.filter((name) => !asarCovers(name, patterns))
			.sort();

		// A package left inside the asar cannot be read by the process running the
		// unpacked script, so the server dies at startup with nothing installed.
		expect(missing).toEqual([]);
	});

	it('reads every target it resolves', () => {
		// A walk that drops a target drops everything that target required, and
		// reports the loss as an absent package name — which reads as a package
		// that is not installed rather than a path this walk could not open. The
		// paths are the diagnosis; assert on them instead of on the symptom.
		const { unreadable } = runtimeClosure(entry);
		expect(unreadable).toEqual([]);
	});

	it('attributes every file it reads to the package containing it', () => {
		// The scope step used to take a scope directory's first child, so a file in
		// one package was reported as a sibling. Nothing else in the suite can see
		// that: the walk still returned a plausible name, and a closure that happens
		// to contain the right set of names passes either way — it passed on ext4
		// here and failed on the runner. A root that does not contain the file is
		// the defect stated directly, and it is independent of `readdir` order.
		const misattributed = runtimeClosure(entry).files
			.filter((file) => {
				const root = packageRootOf(file);
				return root !== null && !file.startsWith(root + path.sep);
			})
			.sort();
		expect(misattributed).toEqual([]);
	});
});
