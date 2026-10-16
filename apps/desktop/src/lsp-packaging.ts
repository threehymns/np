import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import type { LspBundledCommand, LspDescriptorContribution } from '@np/core';

const requirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const resolvePattern = /\bresolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Returns the package directory containing a file, or null when the file sits
 * outside an installed package.
 */
export function packageRootOf(file: string): string | null {
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
 * Returns the npm package name for a file, preferring the manifest name and
 * falling back to the path relative to node_modules.
 */
export function packageNameOf(file: string): string | null {
	const manifest = manifestOf(file);
	if (typeof manifest?.name === 'string') return manifest.name;
	const root = packageRootOf(file);
	if (!root) return null;
	const relative = path.relative(path.dirname(path.dirname(root)), root).split(path.sep);
	return relative[0].startsWith('@') ? `${relative[0]}/${relative[1]}` : relative[0];
}

export function manifestOf(file: string): Record<string, unknown> | null {
	const root = packageRootOf(file);
	if (!root) return null;
	try {
		return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));
	} catch {
		return null;
	}
}

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

export function readableFile(target: string): string | null {
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

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export interface Closure {
	packages: Set<string>;
	files: string[];
	unreadable: string[];
}

/**
 * Computes all packages reachable from the entry script by require, resolve, or
 * declared dependencies.
 */
export function runtimeClosure(entry: string): Closure {
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
		const target = queue.pop()!;
		const file = readableFile(target);
		if (!file) {
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
 * Tests whether an asarUnpack pattern covers the given package name.
 */
export function asarCovers(name: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => {
		const directory = pattern.split('/**')[0];
		const source = directory.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+$/, '[^/]*');
		return new RegExp(`^${source}(?:/|$)`).test(`node_modules/${name}`);
	});
}

/**
 * Resolves the entry script for a bundled command by walking up directories
 * from a starting path until node_modules contains the package and binary.
 */
export function findBundledEntry(bundled: LspBundledCommand, fromDir: string = import.meta.dir): string {
	let directory = fromDir;
	const segments = ['node_modules', ...bundled.package.split('/'), ...bundled.binary.split('/')];
	for (;;) {
		const candidate = path.join(directory, ...segments);
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(
		`The bundled language server entry script for "${bundled.package}" was not found.\n` +
			`Action: Run \`bun install\`, which installs dependencies.`
	);
}

/**
 * Derives asarUnpack glob patterns from descriptor bundled commands by
 * collecting each bundled package's runtime dependency closure.
 */
export function deriveAsarUnpackPatterns(
	descriptors: readonly LspDescriptorContribution[],
	fromDir: string = import.meta.dir
): string[] {
	const packages = new Set<string>();
	for (const descriptor of descriptors) {
		if (!descriptor.bundled) continue;
		const entry = findBundledEntry(descriptor.bundled, fromDir);
		const closure = runtimeClosure(entry);
		for (const pkg of closure.packages) {
			packages.add(pkg);
		}
	}
	return [...packages]
		.sort((a, b) => a.localeCompare(b))
		.map((pkg) => `node_modules/${pkg}/**/*`);
}
