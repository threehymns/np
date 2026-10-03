import { describe, it, expect } from 'bun:test';
import { createFrameParser, frameMessage } from './client';
import type { LspProcess } from '../services';
import { LspLogStore } from './logs';

function framed(payload: string): Uint8Array {
	return frameMessage(payload);
}

/** Feeds bytes one at a time, the worst case a pipe read can produce. */
function pushByteByByte(parser: ReturnType<typeof createFrameParser>, bytes: Uint8Array): string[] {
	const messages: string[] = [];
	for (const byte of bytes) messages.push(...parser.push(new Uint8Array([byte])));
	return messages;
}

describe('JSON-RPC framing (#264)', () => {
	it('writes a Content-Length header measured in bytes, not characters', () => {
		// The header counts bytes: `café` is four characters and five bytes, and a
		// header measured in characters would desynchronise the reader by one byte
		// for every non-ASCII character in a payload.
		const framedPayload = framed('{"result":"café"}');
		const separator = framedPayload.indexOf(13);
		const header = new TextDecoder().decode(framedPayload.subarray(0, separator + 4));
		expect(header).toBe('Content-Length: 18\r\n\r\n');
		expect(new TextDecoder().decode(framedPayload.subarray(separator + 4))).toBe(
			'{"result":"café"}'
		);
	});

	it('reassembles a message split across arbitrary chunk boundaries', () => {
		const parser = createFrameParser();
		const payload = framed('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
		expect(parser.push(payload)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}']);
		// Nothing is delivered until the last byte of the body has arrived.
		expect(parser.push(payload.subarray(0, payload.length - 1))).toEqual([]);
		expect(parser.push(payload.subarray(payload.length - 1))).toEqual([
			'{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'
		]);
	});

	it('does not corrupt a multi-byte character split across two chunks', () => {
		// A naive per-chunk decode turns this into `caf<U+FFFD>`, and the damage
		// reaches the server as a source file with a replacement character in it.
		const parser = createFrameParser();
		const payload = framed('{"text":"日本語 — café ✓"}');
		const cut = payload.indexOf(0xe6) + 1; // mid-character, inside the body
		expect(pushByteByByte(parser, payload)).toEqual(['{"text":"日本語 — café ✓"}']);

		const twoChunks = createFrameParser();
		expect(twoChunks.push(payload.subarray(0, cut))).toEqual([]);
		expect(twoChunks.push(payload.subarray(cut))).toEqual(['{"text":"日本語 — café ✓"}']);
	});

	it('reads several messages from one chunk and keeps the remainder', () => {
		const parser = createFrameParser();
		const first = framed('{"id":1}');
		const second = framed('{"id":2}');
		const third = framed('{"id":3}');
		const combined = new Uint8Array(first.length + second.length + third.length);
		combined.set(first, 0);
		combined.set(second, first.length);
		combined.set(third, first.length + second.length);

		expect(parser.push(combined)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
		// A trailing partial frame is held, not lost.
		expect(parser.push(first.subarray(0, 4))).toEqual([]);
		expect(parser.push(first.subarray(4))).toEqual(['{"id":1}']);
	});
});

/** A process whose streams the test drives by hand. */
function fakeProcess(): LspProcess & {
	feedStdout(chunk: Uint8Array): void;
	feedStderr(chunk: Uint8Array): void;
	written(): string[];
	ended: () => boolean;
} {
	let stdout: ((chunk: Uint8Array) => void) | null = null;
	let stderr: ((chunk: Uint8Array) => void) | null = null;
	const writes: string[] = [];
	let isEnded = false;
	return {
		pid: 4242,
		stdin: {
			write: (chunk) => writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)),
			end: () => {
				isEnded = true;
			}
		},
		stdout: { onData: (listener) => ((stdout = listener), () => ((stdout = null), undefined)) },
		stderr: { onData: (listener) => ((stderr = listener), () => ((stderr = null), undefined)) },
		exit: new Promise(() => {}),
		kill: () => {},
		feedStdout: (chunk) => stdout?.(chunk),
		feedStderr: (chunk) => stderr?.(chunk),
		written: () => writes,
		ended: () => isEnded
	};
}

describe('Protocol trace and stderr feeds (#264)', () => {
	it('records every message it sends and receives under the server it belongs to', async () => {
		const logs = new LspLogStore();
		const { LspClient } = await import('./client');
		const process = fakeProcess();
		const client = new LspClient({ process, server: 'typescript@/repo', logs });

		client.notify('textDocument/didOpen', { textDocument: { uri: 'file:///repo/a.ts' } });
		process.feedStdout(framed('{"jsonrpc":"2.0","id":7,"result":{"capabilities":{}}}'));

		const trace = logs.read({ kind: 'protocol' }).map((e) => e.message);
		expect(trace).toHaveLength(2);
		expect(trace[0]).toStartWith('--> {"jsonrpc":"2.0","method":"textDocument/didOpen"');
		expect(trace[1]).toStartWith('<-- {"jsonrpc":"2.0","id":7');
		expect(logs.read({ kind: 'server' })).toEqual([]);
	});

	it('does not corrupt a multi-byte stderr character split across chunks', async () => {
		// stderr is not framed, so a pipe read can end mid-character. Decoding each
		// chunk on its own would put U+FFFD in the middle of a diagnostic, and the
		// Logs tab would show a server's own error message corrupted by the client
		// that captured it.
		const logs = new LspLogStore();
		const { LspClient } = await import('./client');
		const process = fakeProcess();
		const client = new LspClient({ process, server: 'typescript@/repo', logs });

		const bytes = new TextEncoder().encode('Error: café ✓\n');
		const cut = bytes.indexOf(0xc3) + 1;
		process.feedStderr(bytes.subarray(0, cut));
		process.feedStderr(bytes.subarray(cut));

		expect(logs.read({ kind: 'server' }).map((e) => e.message)).toEqual(['Error: café ✓']);
		expect(logs.read()[0].message).not.toContain('\uFFFD');
	});

	it('feeds server stderr into the same buffer, whole lines only', async () => {
		const logs = new LspLogStore();
		const { LspClient } = await import('./client');
		const process = fakeProcess();
		const client = new LspClient({ process, server: 'typescript@/repo', logs });

		process.feedStderr(new TextEncoder().encode('Error: no tsconfig\npartial'));
		process.feedStderr(new TextEncoder().encode(' line\nready\n'));

		expect(logs.read({ kind: 'server' }).map((e) => [e.level, e.message])).toEqual([
			['error', 'Error: no tsconfig'],
			['info', 'partial line'],
			['info', 'ready']
		]);
	});
});
