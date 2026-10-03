import { describe, it, expect } from 'bun:test';
import {
	LspDiagnosticsStore,
	parsePublishDiagnostics,
	severityFromCode
} from './diagnostics';
import { toFileUri } from './root';

/**
 * The protocol half of server diagnostics (spec #263, ticket #266).
 *
 * Plain data in, plain data out, asserted directly: the store is what the editor
 * half reads, and a bug here shows up as marks on the wrong characters rather
 * than as anything a rendered editor would explain.
 */

const A = toFileUri('/repo/src/a.ts');
const B = toFileUri('/repo/src/b.ts');

function range(line: number, from: number, to: number) {
	return { start: { line, character: from }, end: { line, character: to } };
}

function report(uri: string, diagnostics: unknown[], server = 'typescript@/repo') {
	return parsePublishDiagnostics(server, { uri, diagnostics });
}

describe('publishDiagnostics payloads (#266)', () => {
	it('reads a report and attributes it to the server that sent it', () => {
		const parsed = report(A, [
			{
				range: range(0, 0, 5),
				severity: 1,
				message: 'Cannot find name "x".',
				source: 'ts',
				code: 2304
			}
		]);

		expect(parsed).toEqual({
			uri: A,
			diagnostics: [
				{
					server: 'typescript@/repo',
					range: range(0, 0, 5),
					severity: 'error',
					message: 'Cannot find name "x".',
					source: 'ts',
					code: '2304'
				}
			]
		});
	});

	it('maps every protocol severity and treats anything else as an error', () => {
		expect(severityFromCode(1)).toBe('error');
		expect(severityFromCode(2)).toBe('warning');
		expect(severityFromCode(3)).toBe('info');
		expect(severityFromCode(4)).toBe('hint');
		// Omitted and out-of-range are both the client's choice, and every client
		// in the ecosystem answers "error" — showing a build failure as a hint
		// would hide the line the user came for.
		expect(severityFromCode(undefined)).toBe('error');
		expect(severityFromCode(0)).toBe('error');
		expect(severityFromCode(99)).toBe('error');
	});

	it('keeps the readable entries of a partly malformed report', () => {
		const parsed = report(A, [
			null,
			'message',
			{ message: 'no range, nowhere to put it' },
			{ range: { start: { line: 0 } }, message: 'half a position' },
			{ range: range(2, 1, 4), message: 'usable', severity: 2 },
			{ range: range(2, 1, 4), severity: 3 }
		]);

		expect(parsed?.diagnostics.map((d) => [d.message, d.severity])).toEqual([
			['usable', 'warning'],
			['', 'info']
		]);
	});

	it('rejects a report with no URI to file it under', () => {
		expect(report(undefined as unknown as string, [])).toBeNull();
		expect(parsePublishDiagnostics('typescript@/repo', { diagnostics: [] })).toBeNull();
		expect(parsePublishDiagnostics('typescript@/repo', null)).toBeNull();
		expect(parsePublishDiagnostics('typescript@/repo', { uri: '', diagnostics: [] })).toBeNull();
	});

	it('reads a clean report as an empty list rather than a failure', () => {
		expect(report(A, [])).toEqual({ uri: A, diagnostics: [] });
	});
});

describe('Diagnostics store (#266)', () => {
	it('files reports per URI and replaces them on the next publish', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'first' }])!);
		store.publish(report(A, [{ range: range(1, 0, 1), message: 'second' }])!);

		expect(store.read(A).map((d) => d.message)).toEqual(['second']);
		expect(store.read(B)).toEqual([]);
		expect(store.uris()).toEqual([A]);
	});

	it('treats an empty report as a clean file, not as an empty underline', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'boom' }])!);
		expect(store.read(A)).toHaveLength(1);

		store.publish(report(A, [])!);

		expect(store.read(A)).toEqual([]);
		expect(store.uris()).toEqual([]);
	});

	it('drops only the reports of one server, which is what a stop makes stale', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'from a' }], 'one@/repo')!);
		store.publish(report(B, [{ range: range(0, 0, 1), message: 'from b' }], 'two@/repo')!);

		store.dropServer('one@/repo');

		expect(store.read(A)).toEqual([]);
		expect(store.read(B).map((d) => d.message)).toEqual(['from b']);
	});

	it('bumps its revision on a real change only, and notifies subscribers', () => {
		const store = new LspDiagnosticsStore();
		const seen: number[] = [];
		const unsubscribe = store.subscribe(() => seen.push(store.revision));
		const start = store.revision;

		// Republishing the same clean file is not a change, so a view that
		// re-reads on every notification is not woken for nothing.
		store.publish(report(A, [])!);
		expect(store.revision).toBe(start);
		expect(seen).toEqual([]);

		store.publish(report(A, [{ range: range(0, 0, 1), message: 'boom' }])!);
		store.publish(report(A, [])!);
		expect(seen).toEqual([start + 1, start + 2]);

		unsubscribe();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'again' }])!);
		expect(seen).toHaveLength(2);
	});
});