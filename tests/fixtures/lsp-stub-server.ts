/**
 * Scripted stub stdio language server, standing in for vtsls.
 *
 * Speaks the real thing: `Content-Length` framed JSON-RPC 2.0 over stdin and
 * stdout, the `initialize` / `initialized` handshake, `shutdown` / `exit`, and
 * stderr diagnostics. It is spawned as a real process by the tests through the
 * real transport, because a hand-written fake stream proves nothing about
 * framing (ADR 0004 sets the precedent with real `git` in the contract suite).
 *
 * Scripted by argv, so one fixture covers every mode the lifecycle has to
 * survive:
 *
 *   --mode answer   answer every request (default)
 *   --mode silent   never answer, so a timeout is reachable
 *   --mode fail     exit immediately with a code, so a failed start is reachable
 *   --mode no-shutdown  answer everything but ignore `shutdown`, so the client
 *                   has to kill the process to avoid an orphan
 *   --stderr <text> write a line to stderr on startup (multi-byte by default)
 *   --echo-text     include a multi-byte string in the `initialize` reply
 *
 * `--delay-ms <n>` holds every reply back, which is how a slow server is staged
 * without making the suite slow.
 */

interface StubOptions {
	mode: 'answer' | 'silent' | 'fail' | 'no-shutdown';
	delayMs: number;
	stderr: string | null;
	echoText: boolean;
}

function readOption(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : undefined;
}

function parseOptions(argv: string[]): StubOptions {
	const mode = readOption(argv, 'mode');
	const delay = readOption(argv, 'delay-ms');
	return {
		mode:
			mode === 'silent' || mode === 'fail' || mode === 'no-shutdown' ? mode : 'answer',
		delayMs: delay ? Number(delay) : 0,
		stderr: readOption(argv, 'stderr') ?? null,
		echoText: argv.includes('--echo-text')
	};
}

interface JsonRpcMessage {
	id?: number | string | null;
	method?: string;
	params?: any;
	result?: unknown;
	error?: unknown;
}

const CRLF = 13;
const LF = 10;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

// Written in pieces so the client is forced to reassemble a message that
// arrives split mid-body. Framing is only proven if the split lands inside the
// payload, not just between two whole messages.
const SPLIT_AFTER_HEADER = 7;
const SPLIT_AFTER_BODY = 11;

class FrameReader {
	private buffered = new Uint8Array(0);
	private contentLength = -1;

	push(chunk: Uint8Array): string[] {
		const merged = new Uint8Array(this.buffered.length + chunk.length);
		merged.set(this.buffered, 0);
		merged.set(chunk, this.buffered.length);
		this.buffered = merged;

		const messages: string[] = [];
		for (;;) {
			if (this.contentLength < 0) {
				const separator = this.findSeparator();
				if (separator < 0) break;
				const header = decoder.decode(this.buffered.subarray(0, separator));
				const match = /content-length:\s*(\d+)/i.exec(header);
				if (!match) {
					this.buffered = this.buffered.slice(separator + 4);
					continue;
				}
				this.contentLength = Number(match[1]);
				this.buffered = this.buffered.slice(separator + 4);
			}
			if (this.buffered.length < this.contentLength) break;
			const body = this.buffered.slice(0, this.contentLength);
			this.buffered = this.buffered.slice(this.contentLength);
			this.contentLength = -1;
			messages.push(decoder.decode(body));
		}
		return messages;
	}

	private findSeparator(): number {
		for (let i = 0; i <= this.buffered.length - 4; i++) {
			if (
				this.buffered[i] === CRLF &&
				this.buffered[i + 1] === LF &&
				this.buffered[i + 2] === CRLF &&
				this.buffered[i + 3] === LF
			) {
				return i;
			}
		}
		return -1;
	}
}

const options = parseOptions(process.argv.slice(2));

if (options.mode === 'fail') {
	// A server that cannot start at all: one diagnostic line, then a non-zero
	// exit, exactly like a missing binary or a bad flag.
	process.stderr.write('stub server: refusing to start (mode=fail)\n');
	process.exit(3);
}

if (options.stderr !== null) {
	// Default text carries a multi-byte character so the stderr path is also a
	// UTF-8 boundary test: a naive per-chunk decode would mangle it.
	process.stderr.write(`${options.stderr} — café ✓\n`);
}

let stdoutBroken = false;

function send(message: JsonRpcMessage, chunked = false): void {
	if (stdoutBroken) return;
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
	const framed = new Uint8Array(header.byteLength + body.byteLength);
	framed.set(header, 0);
	framed.set(body, header.byteLength);
	if (!chunked) {
		process.stdout.write(Buffer.from(framed));
		return;
	}
	process.stdout.write(Buffer.from(framed.subarray(0, SPLIT_AFTER_HEADER)));
	process.stdout.write(Buffer.from(framed.subarray(SPLIT_AFTER_HEADER, SPLIT_AFTER_BODY)));
	process.stdout.write(Buffer.from(framed.subarray(SPLIT_AFTER_BODY)));
}

function delayed(fn: () => void): void {
	if (options.delayMs <= 0) {
		fn();
		return;
	}
	setTimeout(fn, options.delayMs).unref?.();
}

const reader = new FrameReader();

process.stdin.on('data', (chunk: Buffer) => {
	for (const raw of reader.push(new Uint8Array(chunk))) {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(raw) as JsonRpcMessage;
		} catch {
			continue;
		}
		handle(message);
	}
});

process.stdin.on('end', () => {
	// End of input means the client is gone; exit rather than linger.
	process.exit(0);
});

function handle(message: JsonRpcMessage): void {
	if (message.method === 'initialize') {
		// `silent` withholds the handshake too: a server that answers
		// `initialize` and then nothing is not a silent server, it is a working
		// one, and the timeout this mode stages would never be reached.
		if (options.mode === 'silent') return;
		const rootUri = (message.params as { rootUri?: string } | undefined)?.rootUri;
		delayed(() => {
			send(
				{
					id: message.id,
					result: {
						capabilities: { textDocumentSync: 1 },
						serverInfo: { name: 'stub-ls', version: '0.0.0' },
						// Echoed so a test can read the resolved root straight out of the
						// protocol rather than trusting the side that resolved it.
						echo: { rootUri, ...(options.echoText ? { note: 'café ✓' } : {}) }
					}
				},
				true
			);
		});
		return;
	}
	if (message.method === 'initialized') return;
	if (message.method === 'shutdown') {
		if (options.mode === 'no-shutdown') return;
		delayed(() => send({ id: message.id, result: null }));
		return;
	}
	if (message.method === 'exit') {
		process.exit(0);
		return;
	}
	if (options.mode === 'silent') return;
	if (message.method === 'textDocument/didOpen') {
		const text = (message.params as { textDocument?: { text?: string } } | undefined)?.textDocument?.text;
		process.stderr.write(`stub server: opened a document of ${text?.length ?? 0} chars\n`);
		return;
	}
	if (typeof message.id === 'number' || typeof message.id === 'string') {
		delayed(() => send({ id: message.id, result: {} }));
	}
}

process.stdout.on('error', () => {
	// The client killed us mid-write; nothing left to say and no way to say it.
	stdoutBroken = true;
});
