import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { LspDescriptorContribution } from '@np/core';
import { LSP_DESCRIPTORS } from '../../../packages/core/src/plugins/lsp/descriptors';
import {
	asarCovers,
	deriveAsarUnpackPatterns,
	findBundledEntry,
	packageRootOf,
	runtimeClosure
} from './lsp-packaging';

/**
 * What the packaged app has to carry for the bundled server to start.
 *
 * A language server is spawned as a plain Node process running a script from
 * `app.asar.unpacked`, so every module that script reaches is resolved from that
 * unpacked tree. Anything left inside the asar is unreachable: Node cannot read
 * it, and the server dies at startup on a machine that has nothing installed.
 *
 * The unpack list is derived from the bundled descriptors rather than maintained
 * by hand. The list is asserted against the closure: every package reachable
 * from the entry script, by require or by a declared runtime dependency, has to
 * match a pattern in `apps/desktop/package.json`.
 */

function asarPatterns(): string[] {
	const manifest = JSON.parse(
		readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf-8')
	) as { build: { asarUnpack?: string[] } };
	return manifest.build.asarUnpack ?? [];
}

describe('the packaged server closure (#263, #265, #281)', () => {
	const entry = findBundledEntry(LSP_DESCRIPTORS[0].bundled!, import.meta.dir);

	it('reaches every runtime package the entry script needs', () => {
		// Guards the guard: if the walk stopped finding the packages below, a list
		// that matched it would prove nothing.
		const { packages } = runtimeClosure(entry);
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

	it('matches the derived unpack patterns generated from bundled descriptors (#281)', () => {
		const patterns = asarPatterns();
		const derived = deriveAsarUnpackPatterns(LSP_DESCRIPTORS, import.meta.dir);
		expect(patterns).toEqual(derived);
	});

	it('covers the installed closure of every bundled descriptor (#281)', () => {
		const patterns = asarPatterns();
		for (const descriptor of LSP_DESCRIPTORS) {
			if (!descriptor.bundled) continue;
			const bundledEntry = findBundledEntry(descriptor.bundled, import.meta.dir);
			const closure = runtimeClosure(bundledEntry);
			const missing = [...closure.packages]
				.filter((name) => !asarCovers(name, patterns))
				.sort();
			expect(missing).toEqual([]);
		}
	});

	it('reads every target it resolves', () => {
		const { unreadable } = runtimeClosure(entry);
		expect(unreadable).toEqual([]);
	});

	it('attributes every file it reads to the package containing it', () => {
		const misattributed = runtimeClosure(entry).files
			.filter((file) => {
				const root = packageRootOf(file);
				return root !== null && !file.startsWith(root + path.sep);
			})
			.sort();
		expect(misattributed).toEqual([]);
	});
});

describe('adding a second server is one descriptor and configuration (#281)', () => {
	it('derives packaging rules for a second server without modifying client or packaging code', () => {
		const fixtureDescriptor: LspDescriptorContribution = {
			id: 'fixture-server',
			command: 'tsc',
			args: ['--stdio'],
			rootMarkers: ['tsconfig.json'],
			languages: ['TypeScript'],
			languageIds: { TypeScript: 'typescript' },
			bundled: { package: 'typescript', binary: 'bin/tsc' }
		};

		// 1. Packaging rules derive automatically for both servers without changing packaging rules.
		const combined = [...LSP_DESCRIPTORS, fixtureDescriptor];
		const derivedPatterns = deriveAsarUnpackPatterns(combined, import.meta.dir);

		const fixtureEntry = findBundledEntry(fixtureDescriptor.bundled!, import.meta.dir);
		const fixtureClosure = runtimeClosure(fixtureEntry);
		expect(fixtureClosure.packages.has('typescript')).toBe(true);

		const missingFromFixture = [...fixtureClosure.packages]
			.filter((name) => !asarCovers(name, derivedPatterns))
			.sort();
		expect(missingFromFixture).toEqual([]);

		// Packaging rules must cover every bundled descriptor, not just whichever
		// happens to be first: a second server is configuration, so the order of
		// LSP_DESCRIPTORS must not matter to this test.
		for (const descriptor of LSP_DESCRIPTORS) {
			if (!descriptor.bundled) continue;
			const bundledEntry = findBundledEntry(descriptor.bundled, import.meta.dir);
			const closure = runtimeClosure(bundledEntry);
			const missing = [...closure.packages]
				.filter((name) => !asarCovers(name, derivedPatterns))
				.sort();
			// The id is part of the expectation so a coverage gap names the server
			// it belongs to.
			expect({ id: descriptor.id, missing }).toEqual({ id: descriptor.id, missing: [] });
		}

		// 2. The typescript descriptor is present, and the registry length is not
		// asserted: a second bundled server is configuration, so adding one must
		// not break this test.
		expect(LSP_DESCRIPTORS.some((descriptor) => descriptor.id === 'typescript')).toBe(true);
	});
});
