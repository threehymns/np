import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

/**
 * Map `items` through `fn` with at most `limit` calls in flight at once,
 * preserving input order in the returned results.
 */
export async function mapBounded<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError('limit must be a positive integer');
	}
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Checks whether an error represents a missing file or directory (ENOENT / NotFoundError)
 * across browser File System Access API, Node.js fs, and Electron IPC serialized errors.
 *
 * Structured signals (`.code`, `.name`) are authoritative. Message matching is only a
 * last-resort for IPC-serialized errors whose envelope survives but whose
 * code/name is stripped — and it is skipped when a structured code contradicts
 * the classification (e.g. an EACCES whose chained cause happens to mention
 * ENOENT), so a coded failure of a different kind is never treated as missing.
 */
export function isNotFoundError(err: any): boolean {
	if (!err) return false;
	if (err.code === 'ENOENT') return true;
	if (err.name === 'NotFoundError') return true;
	if (err.name === 'ENOENT') return true;
	if (typeof err.code === 'string' && err.code !== 'ENOENT') return false;
	if (typeof err.message === 'string') {
		if (
			err.message.includes('ENOENT') ||
			err.message.includes('NotFoundError') ||
			err.message.includes('no such file or directory')
		) {
			return true;
		}
	}
	return false;
}
