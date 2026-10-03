import { describe, it, expect } from 'bun:test';
import {
	appendCapped,
	classifyServerOutput,
	LspLogStore,
	splitLogLines,
	DEFAULT_LOG_CAPACITY_PER_SERVER
} from './logs';

/**
 * The log buffer is asserted as pure logic, because a cap that does not cap is
 * invisible until a long session has already exhausted the heap it was written
 * to protect.
 */
describe('Per-server log buffers (#264)', () => {
	it('keeps both feeds apart under the three fields the Logs tab filters on', () => {
		const logs = new LspLogStore();
		logs.appendServerLine('typescript@/repo', 'booting');
		logs.appendProtocolTrace('typescript@/repo', 'sent', '{"method":"initialize"}');
		logs.appendProtocolTrace('typescript@/repo', 'received', '{"result":{}}');

		expect(logs.read({ kind: 'server' }).map((e) => e.message)).toEqual(['booting']);
		const protocol = logs.read({ kind: 'protocol' }).map((e) => e.message);
		expect(protocol).toEqual(['--> {"method":"initialize"}', '<-- {"result":{}}']);
		expect(logs.read({ level: 'trace' })).toHaveLength(2);
		expect(logs.read({ server: 'other@/repo' })).toEqual([]);
	});

	it('reads back in append order across servers, so a trace reads against its own stderr', () => {
		const logs = new LspLogStore();
		logs.appendServerLine('a@/one', 'first');
		logs.appendServerLine('b@/two', 'second');
		logs.appendServerLine('a@/one', 'third');

		expect(logs.read().map((e) => e.message)).toEqual(['first', 'second', 'third']);
		expect(logs.servers()).toEqual(['a@/one', 'b@/two']);
	});

	it('caps each server independently and counts what it dropped', () => {
		const logs = new LspLogStore(3);
		for (const message of ['one', 'two', 'three', 'four']) {
			logs.appendServerLine('a@/one', message);
		}
		logs.appendServerLine('b@/two', 'unaffected');

		expect(logs.read({ server: 'a@/one' }).map((e) => e.message)).toEqual(['two', 'three', 'four']);
		// A second server gets its own full budget: the cap is per server, not a
		// shared ring, because one noisy server must not blind the Logs tab to the
		// others.
		expect(logs.read({ server: 'b@/two' })).toHaveLength(1);
		expect(logs.droppedCount).toBe(1);
	});

	it('drops the oldest entries and never exceeds the cap, whatever the order', () => {
		const entries = Array.from({ length: 5 }, (_unused, index) => ({
			server: 'a',
			kind: 'server' as const,
			level: 'info' as const,
			message: `line ${index}`,
			sequence: index
		}));

		let buffer = entries.slice(0, 2);
		for (const entry of entries.slice(2)) {
			buffer = appendCapped(buffer, entry, 3).entries;
		}
		expect(buffer.map((e) => e.message)).toEqual(['line 2', 'line 3', 'line 4']);

		// A cap of zero keeps nothing rather than keeping everything.
		expect(appendCapped(entries, entries[0], 0)).toEqual({ entries: [], dropped: 6 });
	});

	it('defaults to a bounded buffer rather than an open-ended one', () => {
		expect(DEFAULT_LOG_CAPACITY_PER_SERVER).toBeGreaterThan(0);
		const logs = new LspLogStore();
		for (let i = 0; i < DEFAULT_LOG_CAPACITY_PER_SERVER + 25; i++) {
			logs.appendProtocolTrace('a@/one', 'sent', `{"n":${i}}`);
		}
		expect(logs.read()).toHaveLength(DEFAULT_LOG_CAPACITY_PER_SERVER);
		expect(logs.droppedCount).toBe(25);
	});

	it('classifies server stderr, which carries no level of its own', () => {
		expect(classifyServerOutput('Error: cannot find tsconfig')).toBe('error');
		expect(classifyServerOutput('fatal: missing dependency')).toBe('error');
		expect(classifyServerOutput('WARN slow response')).toBe('warn');
		expect(classifyServerOutput('ready in 42ms')).toBe('info');
	});

	it('splits stderr into whole lines without losing one split across chunks', () => {
		// stderr arrives in arbitrary pieces; a partial line held back and finished
		// by the next chunk is the ordinary case, not an edge case.
		const first = splitLogLines('', 'one\ntw');
		expect(first.lines).toEqual(['one']);
		expect(first.rest).toBe('tw');
		expect(splitLogLines(first.rest, 'o\nthree\n').lines).toEqual(['two', 'three']);
	});

	it('clears one server or every server, which is the Logs tab Clear action', () => {
		const logs = new LspLogStore();
		logs.appendServerLine('a@/one', 'kept until cleared');
		logs.appendServerLine('b@/two', 'also logged');

		logs.clear('a@/one');
		expect(logs.servers()).toEqual(['b@/two']);

		logs.clear();
		expect(logs.read()).toEqual([]);
		expect(logs.servers()).toEqual([]);
	});

	it('bumps its revision so a view can re-read without polling the entries', () => {
		const logs = new LspLogStore();
		const start = logs.revision;
		logs.appendServerLine('a@/one', 'a line');
		expect(logs.revision).toBeGreaterThan(start);
	});
});
