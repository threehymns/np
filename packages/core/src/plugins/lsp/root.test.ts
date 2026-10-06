import { describe, it, expect } from 'bun:test';
import { dirnameOf, findProjectRoot, toFileUri, type RootProbe } from './root';

/** A probe over a fixed set of absolute paths, so the walk needs no disk. */
function probeFor(paths: readonly string[]): RootProbe {
	const known = new Set(paths);
	return { fileExists: async (path) => known.has(path) };
}

describe('Project-root scoping (#264)', () => {
	it('resolves the nearest directory holding a marker', async () => {
		const result = await findProjectRoot({
			startDir: '/repo/packages/app/src',
			markers: ['tsconfig.json'],
			probe: probeFor(['/repo/packages/app/tsconfig.json', '/repo/tsconfig.json'])
		});
		expect(result.root).toBe('/repo/packages/app');
		expect(result.marker).toBe('tsconfig.json');
		expect(result.usedFallback).toBe(false);
	});

	it('takes the marker order as the root order, not the nearest directory', async () => {
		// The descriptor declares `tsconfig.json` before `package.json` because a
		// TypeScript configuration file says more than the package manifest every
		// JavaScript project has. Honouring the declaration is what makes the field
		// a list rather than a set: the nearer `package.json` must not win.
		const result = await findProjectRoot({
			startDir: '/repo/packages/app/src',
			markers: ['tsconfig.json', 'package.json'],
			probe: probeFor(['/repo/tsconfig.json', '/repo/packages/app/package.json'])
		});
		expect(result.root).toBe('/repo');
		expect(result.marker).toBe('tsconfig.json');
	});

	it('prefers the earlier marker inside one directory and the nearest of equals', async () => {
		const inOneDirectory = await findProjectRoot({
			startDir: '/repo/src',
			markers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
			probe: probeFor(['/repo/package.json', '/repo/jsconfig.json', '/repo/tsconfig.json'])
		});
		expect(inOneDirectory.marker).toBe('tsconfig.json');
		expect(inOneDirectory.root).toBe('/repo');

		// Same marker at two depths: the nearer directory is the project.
		const nearestOfEquals = await findProjectRoot({
			startDir: '/repo/packages/app/src',
			markers: ['tsconfig.json'],
			probe: probeFor(['/repo/tsconfig.json', '/repo/packages/app/tsconfig.json'])
		});
		expect(nearestOfEquals.root).toBe('/repo/packages/app');
	});

	it('falls back to the document directory when no marker exists', async () => {
		// The open document's own root: a lone file outside any project still has a
		// directory to scope a server to.
		const result = await findProjectRoot({
			startDir: '/elsewhere/loose',
			markers: ['tsconfig.json'],
			probe: probeFor([])
		});
		expect(result).toEqual({ root: '/elsewhere/loose', marker: null, usedFallback: true });
	});

	it('stops at the workspace boundary rather than walking into another project', async () => {
		// Without a bound the walk would climb out of the open folder and adopt a
		// neighbouring repository's `tsconfig.json`.
		const result = await findProjectRoot({
			startDir: '/work/app/src',
			markers: ['tsconfig.json'],
			probe: probeFor(['/tsconfig.json', '/work/tsconfig.json']),
			boundary: '/work'
		});
		expect(result.root).toBe('/work');
	});

	it('checks containment, not width, at the boundary', async () => {
		// `/work/other/src` and the boundary `/work/app` are the same width and one
		// is not under the other. A length compare would walk on from `/work/other`
		// and claim `/work`'s configuration for a file that has nothing to do with
		// the open project.
		const result = await findProjectRoot({
			startDir: '/work/other/src',
			markers: ['tsconfig.json'],
			probe: probeFor(['/work/tsconfig.json', '/tsconfig.json']),
			boundary: '/work/app'
		});
		expect(result).toEqual({ root: '/work/other/src', marker: null, usedFallback: true });
	});

	it('does not reach the parent directory the boundary excludes', async () => {
		// The two cases above only differ from a width compare when nothing is
		// found in the directory the wrong walk would have reached. A document
		// outside the boundary still has a parent, and a project configuration
		// there belongs to whatever that parent is for — not to this file. So the
		// marker has to sit exactly one level up, where only a walk that ignored
		// containment would land.
		const result = await findProjectRoot({
			startDir: '/elsewhere/project/src',
			markers: ['tsconfig.json'],
			probe: probeFor(['/elsewhere/project/tsconfig.json', '/elsewhere/tsconfig.json']),
			boundary: '/work/app'
		});
		expect(result).toEqual({
			root: '/elsewhere/project/src',
			marker: null,
			usedFallback: true
		});
	});

	it('does not let a boundary with a shared prefix claim a sibling directory', async () => {
		const result = await findProjectRoot({
			startDir: '/repo/application/src',
			markers: ['tsconfig.json'],
			// `/repo/app/tsconfig.json` is the open project's own marker and is not
			// under `/repo/application`, so it may not be adopted.
			probe: probeFor(['/repo/app/tsconfig.json']),
			boundary: '/repo/app'
		});
		expect(result.root).toBe('/repo/application/src');

		// The same boundary does contain the project it names.
		const contained = await findProjectRoot({
			startDir: '/repo/app/src',
			markers: ['tsconfig.json'],
			probe: probeFor(['/repo/app/tsconfig.json']),
			boundary: '/repo/app'
		});
		expect(contained.root).toBe('/repo/app');
	});

	it('treats a filesystem root boundary as containing everything', async () => {
		const result = await findProjectRoot({
			startDir: '/deep/nested/src',
			markers: ['tsconfig.json'],
			probe: probeFor(['/deep/tsconfig.json']),
			boundary: '/'
		});
		expect(result.root).toBe('/deep');
	});

	it('derives parent directories on both path separators', () => {
		expect(dirnameOf('/repo/packages/app/src')).toBe('/repo/packages/app/src'.replace('/src', ''));
		expect(dirnameOf('/repo/a.ts')).toBe('/repo');
		expect(dirnameOf('a.ts')).toBe('a.ts');
		expect(dirnameOf('/a.ts')).toBe('/');
		expect(dirnameOf('C:\\repo\\a.ts')).toBe('C:\\repo');
		expect(dirnameOf('C:\\a.ts')).toBe('C:\\');
	});

	it('addresses documents as file URIs, escaping what a URI cannot carry', () => {
		expect(toFileUri('/repo/src/a.ts')).toBe('file:///repo/src/a.ts');
		expect(toFileUri('/repo/my notes/a b.ts')).toBe('file:///repo/my%20notes/a%20b.ts');
		expect(toFileUri('/repo/a#b.ts')).toBe('file:///repo/a%23b.ts');
		expect(toFileUri('C:\\repo\\a.ts')).toBe('file:///C:/repo/a.ts');
	});
});
