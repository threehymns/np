import { describe, it, expect } from 'bun:test';
import { isNotFoundError, isDirectoryError, mapBounded, formatRelativeTime, parseRefTags } from './utils';

describe('isNotFoundError', () => {
	it('keeps the Electron main message fallback identical to core', async () => {
		const core = await Bun.file(new URL('./utils.ts', import.meta.url)).text();
		const main = await Bun.file(new URL('../../../apps/desktop/src/main.ts', import.meta.url)).text();
		const pattern = /^\s*(\/\^.*\/)\.test\((?:err|e)\.message\)/m;
		const coreMatcher = core.match(pattern)?.[1];
		const mainMatcher = main.match(pattern)?.[1];
		expect(coreMatcher).toBeDefined();
		expect(mainMatcher).toBe(coreMatcher);
	});

	it.each([
		"ENOENT, open '/foo'",
		"NotFoundError, open '/foo'",
		"Error: ENOENT, open '/foo'",
		"Error invoking remote method 'x': Error: Error invoking remote method 'y': Error: ENOENT: no such file or directory, open '/foo'",
		"Error invoking remote method 'x': Error: Error invoking remote method 'y': Error: NotFoundError: missing",
		'no such file or directory',
		'NotFoundError'
	])('recognizes a missing-file message: %s', (message) => {
		expect(isNotFoundError(new Error(message))).toBe(true);
	});

	it.each([
		"EACCES: permission denied opening '/notes/ENOENT.md'",
		"Error invoking remote method 'x': Error: EACCES: ENOENT: chained cause",
		"Error invoking remote method 'x': Error: Failed to read '/notes/NotFoundError.md'",
		'ENOENT.md',
		'NotFoundErrorBackup',
		'no such file or directory mentioned in a different error'
	])('rejects incidental missing-file text: %s', (message) => {
		expect(isNotFoundError(new Error(message))).toBe(false);
	});

	it('does not treat a filename mentioning NotFoundError as a missing file', () => {
		expect(isNotFoundError(new Error("Failed to read '/notes/NotFoundError.md'"))).toBe(false);
	});

	it('preserves a structured non-missing error despite a NotFoundError filename', () => {
		const error = Object.assign(new Error("Permission denied: '/notes/NotFoundError.md'"), { code: 'EACCES' });
		expect(isNotFoundError(error)).toBe(false);
	});

	it('recognizes the Electron IPC missing-file envelope', () => {
		expect(isNotFoundError(new Error("Error invoking remote method 'fs:readFile': Error: ENOENT: no such file or directory, open '/notes/missing.md'"))).toBe(true);
	});

	it('recognizes structured missing-file signals and bare ENOENT', () => {
		expect(isNotFoundError({ name: 'NotFoundError' })).toBe(true);
		expect(isNotFoundError({ code: 'ENOENT' })).toBe(true);
		expect(isNotFoundError({ name: 'ENOENT' })).toBe(true);
		expect(isNotFoundError(new Error('ENOENT'))).toBe(true);
	});
});

describe('isDirectoryError', () => {
	it.each([
		"EISDIR: illegal operation on a directory, read",
		"Error invoking remote method 'fs:readFile': Error: EISDIR: illegal operation on a directory, read",
		"Error: EISDIR: illegal operation on a directory, read",
		'illegal operation on a directory',
		'EISDIR'
	])('recognizes a directory-read message: %s', (message) => {
		expect(isDirectoryError(new Error(message))).toBe(true);
	});

	it('recognizes structured directory signals from Node and the File System Access API', () => {
		expect(isDirectoryError({ code: 'EISDIR' })).toBe(true);
		expect(isDirectoryError({ name: 'TypeMismatchError' })).toBe(true);
	});

	it('does not treat a filename mentioning EISDIR as a directory', () => {
		// The mid-string trap: the marker is a filename, not a failure code.
		expect(isDirectoryError(new Error("Failed to read '/notes/EISDIR.md'"))).toBe(false);
	});

	it('preserves a structured non-directory error despite a directory-mentioning cause', () => {
		// "A code that is present and says something else wins" -- a coded failure
		// of a different kind is never reclassified just because a chained cause
		// mentions a directory.
		//
		// The message here is written so the regex fallback WOULD match it, so
		// this case fails if the contradicting-code guard is dropped rather than
		// passing for the unrelated reason that the message is not anchored on
		// the marker.
		const error = Object.assign(
			new Error("Error invoking remote method 'fs:readFile': Error: EISDIR: illegal operation on a directory"),
			{ code: 'EACCES' }
		);
		expect(isDirectoryError(error)).toBe(false);
	});

	it.each([
		"EACCES: permission denied, open '/notes'",
		"Error invoking remote method 'fs:readFile': Error: ENOENT: EISDIR: chained cause",
		'EISDIR.md',
		'EISDIRBackup',
		'permission denied on a directory entry'
	])('rejects incidental directory text: %s', (message) => {
		expect(isDirectoryError(new Error(message))).toBe(false);
	});

	it('is false for a value that carries no error signal at all', () => {
		expect(isDirectoryError(undefined)).toBe(false);
		expect(isDirectoryError(null)).toBe(false);
		expect(isDirectoryError({})).toBe(false);
	});
});

describe('mapBounded', () => {
	it('throws RangeError when limit is 0', async () => {
		await expect(mapBounded([1, 2, 3], 0, async x => x * 2)).rejects.toThrow(RangeError);
	});

	it('throws RangeError when limit is negative', async () => {
		await expect(mapBounded([1, 2, 3], -1, async x => x * 2)).rejects.toThrow(RangeError);
	});

	it('throws RangeError when limit is not an integer', async () => {
		await expect(mapBounded([1, 2, 3], 1.5, async x => x * 2)).rejects.toThrow(RangeError);
		await expect(mapBounded([1, 2, 3], NaN, async x => x * 2)).rejects.toThrow(RangeError);
	});

	it('maps items in order with bounded concurrency', async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		const results = await mapBounded([10, 20, 30, 40, 50], 2, async (x) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise(resolve => setTimeout(resolve, 5));
			inFlight--;
			return x * 2;
		});

		expect(results).toEqual([20, 40, 60, 80, 100]);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it('returns empty array when items is empty and limit is positive', async () => {
		const results = await mapBounded([], 5, async (x: number) => x * 2);
		expect(results).toEqual([]);
	});
});

describe('formatRelativeTime', () => {
	const nowMs = 1700000000 * 1000; // Reference timestamp in ms

	it('returns just now for timestamps under a minute ago', () => {
		expect(formatRelativeTime(1700000000 - 30, nowMs)).toBe('just now');
		expect(formatRelativeTime(1700000000, nowMs)).toBe('just now');
	});

	it('returns minutes ago for timestamps under an hour ago', () => {
		expect(formatRelativeTime(1700000000 - 65, nowMs)).toBe('1 minute ago');
		expect(formatRelativeTime(1700000000 - 300, nowMs)).toBe('5 minutes ago');
	});

	it('returns hours ago for timestamps under a day ago', () => {
		expect(formatRelativeTime(1700000000 - 3600, nowMs)).toBe('1 hour ago');
		expect(formatRelativeTime(1700000000 - 7200, nowMs)).toBe('2 hours ago');
	});

	it('returns days ago for timestamps under a month ago', () => {
		expect(formatRelativeTime(1700000000 - 86400, nowMs)).toBe('1 day ago');
		expect(formatRelativeTime(1700000000 - 3 * 86400, nowMs)).toBe('3 days ago');
	});

	it('returns months ago for timestamps under a year ago', () => {
		expect(formatRelativeTime(1700000000 - 35 * 86400, nowMs)).toBe('1 month ago');
		expect(formatRelativeTime(1700000000 - 90 * 86400, nowMs)).toBe('3 months ago');
	});

	it('returns years ago for timestamps over a year ago', () => {
		expect(formatRelativeTime(1700000000 - 400 * 86400, nowMs)).toBe('1 year ago');
		expect(formatRelativeTime(1700000000 - 800 * 86400, nowMs)).toBe('2 years ago');
	});

	it('handles future or zero timestamps gracefully', () => {
		expect(formatRelativeTime(1700000000 + 100, nowMs)).toBe('just now');
		expect(formatRelativeTime(0, nowMs)).toBe('');
	});
});

describe('parseRefTags (Ticket #346)', () => {
	it('returns empty array when refDecoration is undefined or empty', () => {
		expect(parseRefTags(undefined)).toEqual([]);
		expect(parseRefTags('')).toEqual([]);
		expect(parseRefTags('   ')).toEqual([]);
	});

	it('returns empty array when decoration contains only branches, HEAD, or remotes', () => {
		expect(parseRefTags('HEAD -> feat/history-tag-chips, origin/feat/git-history-tab, master')).toEqual([]);
		expect(parseRefTags('main, origin/main, origin/HEAD')).toEqual([]);
	});

	it('extracts a single tag from ref decoration', () => {
		expect(parseRefTags('HEAD -> main, tag: v1.0.0')).toEqual(['v1.0.0']);
		expect(parseRefTags('tag: release-2024')).toEqual(['release-2024']);
	});

	it('extracts multiple tags in order and ignores non-tag decorations', () => {
		expect(
			parseRefTags('HEAD -> main, tag: v1.0.0, origin/main, tag: v1.0.1, feat/branch')
		).toEqual(['v1.0.0', 'v1.0.1']);
	});

	it('handles decoration with surrounding parentheses', () => {
		expect(parseRefTags('(HEAD -> main, tag: v2.0-rc1, origin/main)')).toEqual(['v2.0-rc1']);
	});

	it('handles whitespace around tags and entries cleanly', () => {
		expect(parseRefTags(' tag: v3.0 ,  tag: v3.1  ')).toEqual(['v3.0', 'v3.1']);
	});

	it('ignores empty tag names', () => {
		expect(parseRefTags('tag: , tag:  ')).toEqual([]);
	});
});

