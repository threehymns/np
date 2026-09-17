import { describe, it, expect } from 'bun:test';
import { isNotFoundError, mapBounded } from './utils';

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
