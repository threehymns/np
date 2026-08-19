import { describe, it, expect } from 'bun:test';
import { mapBounded } from './utils';

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
