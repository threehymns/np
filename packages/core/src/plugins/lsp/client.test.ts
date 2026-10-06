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
function fakeProcess(
	overrides: Partial<LspProcess> = {}
): LspProcess & {
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
		parentPid: 4242,
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
		ended: () => isEnded,
		...overrides
	};
}

/** Every JSON message the client has written, decoded back out of its frames. */
function sentMessages(process: { written(): string[] }): Record<string, unknown>[] {
	const parser = createFrameParser();
	const bodies: string[] = [];
	for (const chunk of process.written()) bodies.push(...parser.push(new TextEncoder().encode(chunk)));
	return bodies.map((body) => JSON.parse(body) as Record<string, unknown>);
}

/**
 * Runs one `initialize` handshake and returns the request as it went out.
 *
 * Answers the request itself, so the client's promise settles and the test does
 * not leak a pending waiter — and asserts on the request rather than on anything
 * internal, because what the server receives is the whole of the claim.
 */
async function handshakeParams(process: ReturnType<typeof fakeProcess>): Promise<Record<string, unknown>> {
	const { LspClient } = await import('./client');
	const client = new LspClient({ process, server: 'typescript@/repo', logs: new LspLogStore() });
	const settled = client.initialize({ rootUri: 'file:///repo', capabilities: {} });
	const sent = () => sentMessages(process).find((m) => m.method === 'initialize');
	// Polled rather than a fixed number of microtasks: a transport that names its
	// process late settles the pid on a macrotask, and the count of ticks that
	// takes is not something this test should encode.
	for (let attempt = 0; attempt < 500 && !sent(); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	const request = sent();
	if (!request) throw new Error('The client never sent initialize.');
	process.feedStdout(
		framed(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }))
	);
	await settled;
	return request.params as Record<string, unknown>;
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

/**
 * What the client claims about itself in `initialize`.
 *
 * Asserted on the request that goes out on the wire, because the declaration is
 * a claim made to the server: the defect these cover was invisible from inside
 * the client and fatal to it, since a server is entitled to answer "I do not do
 * completions" for a client that never advertised that it wanted any.
 */
describe('The initialize handshake declares what the client will do (#264)', () => {
	it('declares completion support, because it issues textDocument/completion', async () => {
		const capabilities = (await handshakeParams(fakeProcess())).capabilities as Record<string, unknown>;
		const textDocument = capabilities.textDocument as Record<string, unknown>;
		expect(textDocument.completion).toBeDefined();
	});

	it('declares the four-property resolveSupport the visible-window round trip implements', async () => {
		// Spec #280, Zed contract #292, amending ADR 0021's declared absence:
		// `documentation` and `detail` land in labels immediately,
		// `additionalTextEdits` and `command` defer to confirm time. `textEdit`
		// is never advertised — "otherwise Zed becomes slow" — so only its
		// `newText` is ever re-derived, never its range.
		const capabilities = (await handshakeParams(fakeProcess())).capabilities as Record<string, unknown>;
		const completion = (capabilities.textDocument as Record<string, unknown>).completion as Record<
			string,
			unknown
		>;
		const item = (completion.completionItem ?? {}) as Record<string, unknown>;
		const support = (item.resolveSupport ?? {}) as Record<string, unknown>;
		expect(support.properties).toEqual(['additionalTextEdits', 'command', 'detail', 'documentation']);
		expect(support.properties).not.toContain('textEdit');
		expect(item.documentationFormat).toEqual(['markdown', 'plaintext']);
	});

	it('declares markdown-only hover with no resolve phase', async () => {
		// Hover is its own `textDocument/hover` request sharing only the
		// Markdown pipeline with resolve (#292).
		const capabilities = (await handshakeParams(fakeProcess())).capabilities as Record<string, unknown>;
		const hover = (capabilities.textDocument as Record<string, unknown>).hover as Record<
			string,
			unknown
		>;
		expect(hover.contentFormat).toEqual(['markdown']);
	});

	it('sends client-capability names, never the server ones they replaced', async () => {
		// The defect these cover was invisible from inside the client and fatal to
		// it: `textDocumentSync` and `completionProvider` are ServerCapabilities,
		// so a spec-correct server ignores them in the client slot and answers as
		// if no completion support had been declared at all.
		const capabilities = (await handshakeParams(fakeProcess())).capabilities as Record<string, unknown>;
		expect(capabilities).not.toHaveProperty('textDocumentSync');
		expect(capabilities).not.toHaveProperty('completionProvider');
		const completion = (capabilities.textDocument as Record<string, unknown>).completion as Record<
			string,
			unknown
		>;
		// Trigger characters arrive in the server's `completionProvider`; there is
		// no client-capability field for them, so there is nothing to declare.
		expect(completion).not.toHaveProperty('triggerCharacters');
	});

	it('declares the client process id, so a server can notice the client died', async () => {
		// A server told `null` cannot watch its parent, so a crashed editor leaves it
		// running for the rest of the login — the orphan `initialize` exists to
		// prevent. The seam already carries the parent pid; this is what consumes it.
		expect((await handshakeParams(fakeProcess())).processId).toBe(4242);
	});

	it('declares the parent pid rather than the spawned server pid', async () => {
		// `pid` is the server for status and orphan checks; `processId` must be
		// the client the server watches, not itself.
		expect((await handshakeParams(fakeProcess({ pid: 1111, parentPid: 2222 }))).processId).toBe(2222);
	});

	it('waits for a transport that names its parent late rather than sending nothing', async () => {
		// The desktop transport learns the parent over IPC, two round trips after
		// `spawn()` returned. Reading `parentPid` while building the params finds nothing,
		// and `processId: undefined` vanishes from the JSON entirely — which is a
		// *worse* lie than null, because the server sees no field at all.
		let nameIt!: (pid: number | undefined) => void;
		const process = fakeProcess({
			pid: 4242,
			parentPid: undefined,
			ready: new Promise<number | undefined>((resolve) => {
				nameIt = resolve;
			})
		});
		const pending = handshakeParams(process);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sentMessages(process)).toEqual([]);
		nameIt(31337);
		expect((await pending).processId).toBe(31337);
	});

	it('declares the spec null when the transport never names a parent', async () => {
		// `null` is LSP's own "no process id available", so it is the honest answer
		// rather than an omission — and a missing field is not. A known server pid
		// must not stand in for an unknown parent.
		expect((await handshakeParams(fakeProcess({ pid: 4242, parentPid: undefined }))).processId).toBeNull();
	});
});
