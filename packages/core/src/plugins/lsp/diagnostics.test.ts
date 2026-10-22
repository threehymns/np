import { describe, it, expect } from 'bun:test';
import {
	LspDiagnosticsStore,
	parsePublishDiagnostics,
	severityFromCode,
	type LspDiagnostic
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

function report(uri: string, diagnostics: unknown[], server = 'typescript@/repo', version?: number) {
	return parsePublishDiagnostics(server, { uri, diagnostics, version });
}

/** One finding, as a pull files it: the pull's answers are not protocol payloads. */
function finding(server: string, message: string): LspDiagnostic {
	return {
		server,
		range: range(0, 0, 1),
		severity: 'error',
		message,
		source: null,
		code: null
	};
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
			server: 'typescript@/repo',
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
		expect(report(A, [])).toEqual({ uri: A, server: 'typescript@/repo', diagnostics: [] });
	});

	it('keeps the document version the protocol carried, and names none when it carried none', () => {
		expect(parsePublishDiagnostics('typescript@/repo', { uri: A, version: 7, diagnostics: [] })?.version).toBe(7);
		expect(parsePublishDiagnostics('typescript@/repo', { uri: A, diagnostics: [] })?.version).toBeUndefined();
		// A version that is not a number names no revision, rather than a
		// revision of nonsense: the server said nothing about which text it
		// looked at, and the store has to be able to tell that apart.
		expect(
			parsePublishDiagnostics('typescript@/repo', { uri: A, version: 'seven', diagnostics: [] })?.version
		).toBeUndefined();
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

	it('keeps the other server\'s findings for a file both of them report on', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'type error' }], 'ts@/repo')!);
		store.publish(report(A, [{ range: range(2, 0, 3), message: 'lint' }], 'lint@/repo')!);

		// One server stopping erases only its own findings, not the file's.
		store.dropServer('ts@/repo');

		expect(store.read(A).map((d) => d.message)).toEqual(['lint']);
		expect(store.uris()).toEqual([A]);

		// And the survivor is the last one left, so the URI goes with it.
		store.dropServer('lint@/repo');
		expect(store.read(A)).toEqual([]);
		expect(store.uris()).toEqual([]);
	});

	it('replaces one server\'s findings for a shared file without touching the other\'s', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'type error' }], 'ts@/repo')!);
		store.publish(report(A, [{ range: range(2, 0, 3), message: 'lint' }], 'lint@/repo')!);

		// The protocol's publish is per server: the file is clean for one server
		// and still broken for the other, and both statements are true at once.
		store.publish(report(A, [], 'ts@/repo')!);
		expect(store.read(A).map((d) => d.message)).toEqual(['lint']);

		// A later publish from that server replaces only its own slice.
		store.publish(report(A, [{ range: range(4, 0, 1), message: 'other error' }], 'ts@/repo')!);
		expect(store.read(A).map((d) => d.message)).toEqual(['lint', 'other error']);
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

/**
 * The store orders two results for one path and one server by the document
 * revision they were computed against (#353).
 *
 * A result that was already in flight when the text changed was computed
 * against the text before the change, so it lands on top of a fresher answer
 * and the file shows findings for text that is no longer there. The revision
 * each result names is what tells the store which of the two is the newer
 * word.
 */
describe('Diagnostics store, ordered by document revision (#353)', () => {
	const server = 'typescript@/repo';

	it('refuses a result computed against an older revision, and the newer one stays', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'at 5' }], server, 5)!);
		store.publish(report(A, [{ range: range(1, 0, 1), message: 'at 3' }], server, 3)!);

		expect(store.read(A).map((d) => d.message)).toEqual(['at 5']);
	});

	it('takes a result computed against a newer revision', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'at 3' }], server, 3)!);
		store.publish(report(A, [{ range: range(1, 0, 1), message: 'at 5' }], server, 5)!);

		expect(store.read(A).map((d) => d.message)).toEqual(['at 5']);
	});

	it('refuses a stale push against a fresh pull', () => {
		const store = new LspDiagnosticsStore();
		store.pull({ uri: A, server, diagnostics: [finding(server, 'pulled at 5')], version: 5 });
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'pushed at 3' }], server, 3)!);

		expect(store.read(A).map((d) => d.message)).toEqual(['pulled at 5']);
	});

	it('refuses a stale pull against a fresh push', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'pushed at 5' }], server, 5)!);
		store.pull({ uri: A, server, diagnostics: [finding(server, 'pulled at 3')], version: 3 });

		expect(store.read(A).map((d) => d.message)).toEqual(['pushed at 5']);
	});

	it('a result that names no revision does not displace a pull that names one', () => {
		// The push says nothing about which text it looked at, and the source
		// order says a push is not the newer word for a path a pull has spoken
		// for.
		const store = new LspDiagnosticsStore();
		store.pull({ uri: A, server, diagnostics: [finding(server, 'pulled at 5')], version: 5 });
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'no revision' }], server)!);

		expect(store.read(A).map((d) => d.message)).toEqual(['pulled at 5']);
	});

	it('a result that names a revision displaces one that names no revision, when its source is the newer word', () => {
		// The receipts for dropping the middle branch: a server that pushes
		// without naming a version must not be able to keep the file on its own
		// answer, or the pull mechanism only works on the servers that happen
		// to name a version on every publish.
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'no revision' }], server)!);
		store.pull({ uri: A, server, diagnostics: [finding(server, 'pulled at 5')], version: 5 });

		expect(store.read(A).map((d) => d.message)).toEqual(['pulled at 5']);
	});

	it('a push computed against the same revision as a pull is refused', () => {
		// Two answers about the same text are the same age, not one older than
		// the other, so the revision is a tie and the source decides: a push
		// never replaces a pull.
		const store = new LspDiagnosticsStore();
		store.pull({ uri: A, server, diagnostics: [finding(server, 'pulled at 5')], version: 5 });
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'pushed at 5' }], server, 5)!);

		expect(store.read(A).map((d) => d.message)).toEqual(['pulled at 5']);
	});

	it('two pushes are ordered by arrival, not by revision', () => {
		// The cost of the rule: a result that names no revision is not held
		// back by one that does, so two pushes are ordered by when they
		// landed — as they were before the revision existed — and a server
		// that names a version on some publishes and not on others gets the
		// later one either way.
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'at 5' }], server, 5)!);
		store.publish(report(A, [{ range: range(1, 0, 1), message: 'no revision' }], server)!);

		expect(store.read(A).map((d) => d.message)).toEqual(['no revision']);

		const other = new LspDiagnosticsStore();
		other.publish(report(A, [{ range: range(0, 0, 1), message: 'no revision' }], server)!);
		other.publish(report(A, [{ range: range(1, 0, 1), message: 'at 5' }], server, 5)!);

		expect(other.read(A).map((d) => d.message)).toEqual(['at 5']);
	});

	it('a refused result leaves the store\'s revision unchanged, so a view is not woken', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'at 5' }], server, 5)!);
		const revision = store.revision;
		let woken = 0;
		store.subscribe(() => {
			woken++;
		});

		// A stale push and a stale pull are both refused, and a refused result
		// is not a change.
		store.publish(report(A, [{ range: range(1, 0, 1), message: 'at 3' }], server, 3)!);
		store.pull({ uri: A, server, diagnostics: [finding(server, 'pulled at 3')], version: 3 });

		expect(store.revision).toBe(revision);
		expect(woken).toBe(0);
	});

	it('a push-only server keeps the per-server slices it had', () => {
		// A server that names no revision is unaffected by the rule: its next
		// push replaces its own slice and leaves the other server's alone.
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'from ts' }], 'ts@/repo')!);
		store.publish(report(A, [{ range: range(2, 0, 3), message: 'from lint' }], 'lint@/repo')!);

		store.publish(report(A, [{ range: range(4, 0, 1), message: 'from ts again' }], 'ts@/repo')!);
		expect(store.read(A).map((d) => d.message)).toEqual(['from ts again', 'from lint']);

		store.publish(report(A, [], 'ts@/repo')!);
		expect(store.read(A).map((d) => d.message)).toEqual(['from lint']);
	});

	it('a newer empty pull followed by an older push leaves diagnostics absent', () => {
		const store = new LspDiagnosticsStore();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'error at 1' }], server, 1)!);
		expect(store.read(A).map((d) => d.message)).toEqual(['error at 1']);

		store.pull({ uri: A, server, diagnostics: [], version: 2 });
		expect(store.read(A)).toEqual([]);

		store.publish(report(A, [{ range: range(0, 0, 1), message: 'stale error at 1' }], server, 1)!);
		expect(store.read(A)).toEqual([]);
	});

	it('clearing metadata allows subsequent reports after dropServer, dropUri, and clear', () => {
		const store = new LspDiagnosticsStore();
		store.pull({ uri: A, server, diagnostics: [], version: 2 });
		store.dropServer(server);
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'after dropServer' }], server, 1)!);
		expect(store.read(A).map((d) => d.message)).toEqual(['after dropServer']);

		store.pull({ uri: A, server, diagnostics: [], version: 2 });
		store.dropUri(A);
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'after dropUri' }], server, 1)!);
		expect(store.read(A).map((d) => d.message)).toEqual(['after dropUri']);

		store.pull({ uri: A, server, diagnostics: [], version: 2 });
		store.clear();
		store.publish(report(A, [{ range: range(0, 0, 1), message: 'after clear' }], server, 1)!);
		expect(store.read(A).map((d) => d.message)).toEqual(['after clear']);
	});
});
