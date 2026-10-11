import { appendFileSync, existsSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
/**
 * Scripted stub stdio language server, standing in for vtsls.
 *
 * Speaks the real thing: `Content-Length` framed JSON-RPC 2.0 over stdin and
 * stdout, the `initialize` / `initialized` handshake, `shutdown` / `exit`, and
 * stderr diagnostics. It is spawned as a real process by the tests through the
 * real pipes, because a hand-written fake stream proves nothing about
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
 *   --mode fail-completion  answer the handshake, then refuse every
 *                   `textDocument/completion`, so a request-level failure is
 *                   reachable on a server that *is* running
 *   --mode stall-completion  answer the handshake, then never answer
 *                   `textDocument/completion` at all, so the *wedged* server is
 *                   reachable: no error, no exit, no late answer — the request
 *                   simply never settles, which is the one failure no bound of
 *                   its own can report
 *   --mode gated  answer everything as `answer` does, but withhold the
 *                   `initialize` reply until `--gate-file` exists, so a document
 *                   can be presented to a server that is provably still starting
 *   --gate-file <path>  the file `--mode gated` waits for before it replies. The
 *                   gate is a file the stub watches rather than a delay it sleeps
 *                   through: these tests are about the order two documents are
 *                   presented in, and a delay long enough to usually cover the
 *                   handshake is a race that passes on a fast machine and fails on
 *                   a slow one
 *   --stderr <text> write a line to stderr on startup (multi-byte by default)
 *   --echo-text     include a multi-byte string in the `initialize` reply
 *   --diagnostics   publish one error and one warning for every document that
 *                   is opened or changed, which is the notification the
 *                   diagnostics slice renders
 *   --diagnostic-uri <uri>  publish the same error and warning for this file
 *                   right after the handshake completes, without the client ever
 *                   having opened it. Models the project-wide server that indexes
 *                   a workspace and reports on files it was not asked about —
 *                   which is how a report reaches a client whose `lsp` is off for
 *                   that file's language
 *   --log-file <path>  append every message the stub received, so a test can
 *                   assert what actually arrived on the wire. The protocol trace
 *                   deliberately does not retain document bodies, so this is the
 *                   only place full-content sync is observable
 *
 * `--delay-ms <n>` holds every reply back, which is how a slow server is staged
 * without making the suite slow: a `textDocument/completion` that arrives later
 * than the fetch timeout is the #265 timeout path.
 */

const MODES = [
	'silent',
	'fail',
	'no-shutdown',
	'fail-completion',
	'stall-completion',
	'gated'
] as const;
type StubMode = (typeof MODES)[number];

interface StubOptions {
	mode: StubMode;
	delayMs: number;
	stderr: string | null;
	echoText: boolean;
	diagnostics: boolean;
	diagnosticUri: string | null;
	logFile: string | null;
	gateFile: string | null;
}

function readOption(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : undefined;
}

function parseOptions(argv: string[]): StubOptions {
	const mode = readOption(argv, 'mode');
	const delay = readOption(argv, 'delay-ms');
	return {
		mode: MODES.find((known) => known === mode) ?? 'answer',
		delayMs: delay ? Number(delay) : 0,
		stderr: readOption(argv, 'stderr') ?? null,
		echoText: argv.includes('--echo-text'),
		diagnostics: argv.includes('--diagnostics'),
		diagnosticUri: readOption(argv, 'diagnostic-uri') ?? null,
		logFile: readOption(argv, 'log-file') ?? null,
		gateFile: readOption(argv, 'gate-file') ?? null
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

/**
 * Resolves once `path` exists, by watching the directory that holds it.
 *
 * The directory rather than the file, because the file is what the test is about to
 * create and watching a path that does not exist yet is not portable.
 *
 * Existence is checked twice, before and after the watch is armed, because the
 * create this waits for can land in the gap between the two: a file that appears
 * there produces no event for a watch that had not started, so without the second
 * check the handshake waits for a test that has already gone. That race is not
 * hypothetical — it is what a test whose only evidence of the handshake is the wire
 * log is guaranteed to hit, since the stub logs the message before it watches.
 *
 * Never rejects and never falls through to a delay. A gate that cannot be watched
 * has to fail the test loudly, because letting the handshake through unblocked would
 * make a test about ordering pass for the wrong reason.
 */
function waitForGate(path: string): Promise<void> {
	return new Promise((resolve) => {
		if (existsSync(path)) {
			resolve();
			return;
		}
		const dir = dirname(path);
		const name = basename(path);
		let watcher: ReturnType<typeof watch> | undefined;
		const open = (): void => {
			watcher?.close();
			resolve();
		};
		try {
			watcher = watch(dir, (_event, changed) => {
				if (changed !== null && changed !== name) return;
				// Re-checked rather than trusted from the event: events coalesce, and a
				// create that was not this one is not a release.
				if (!existsSync(path)) return;
				open();
			});
		} catch (error) {
			process.stderr.write(`stub server: cannot watch the gate (${String(error)})\n`);
			return;
		}
		if (existsSync(path)) open();
	});
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
		if (options.logFile !== null) appendFileSync(options.logFile, raw + '\n');
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
		const reply = (): void => {
			send(
				{
					id: message.id,
					result: {
						capabilities: {
							textDocumentSync: 1,
							// Declared so the reply describes the server this really is:
							// one that answers completions and would need a resolve
							// round trip for documentation.
							completionProvider: { resolveProvider: true, triggerCharacters: ['.', '"', '/', "'"] }
						},
						serverInfo: { name: 'stub-ls', version: '0.0.0' },
						// Echoed so a test can read the resolved root straight out of the
						// protocol rather than trusting the side that resolved it.
						echo: { rootUri, ...(options.echoText ? { note: 'café ✓' } : {}) }
					}
				},
				true
			);
		};
		// Gated rather than delayed: the client gets the `initialize` on the wire and
		// then waits for the test, which is the only way to hold a server provably in
		// `starting` while a test presents documents to it.
		if (options.gateFile !== null) {
			void waitForGate(options.gateFile).then(reply);
			return;
		}
		delayed(reply);
		return;
	}
	if (message.method === 'initialized') {
		// After the handshake rather than before: a report for a file the client has
		// not opened yet would race the client's own subscription to it.
		if (options.diagnosticUri !== null) publishDiagnostics(options.diagnosticUri);
		return;
	}
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
	if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange') {
		const document = (message.params as { textDocument?: { uri?: string; text?: string } } | undefined)
			?.textDocument;
		if (options.diagnostics) publishDiagnostics(document?.uri);
		if (message.method === 'textDocument/didOpen') {
			process.stderr.write(`stub server: opened a document of ${document?.text?.length ?? 0} chars\n`);
		}
		return;
	}
	if (message.method === 'textDocument/completion') {
		if (options.mode === 'stall-completion') {
			// Not a delay: a delay long enough to still be pending is a race, and a
			// shorter one is a late answer, which is a different failure. Nothing is
			// sent at all, so the request is pending for as long as the client waits.
			return;
		}
		if (options.mode === 'fail-completion') {
			// A running server that refuses one method: the JSON-RPC error path,
			// which is a different failure from a server that never started.
			delayed(() =>
				send({
					id: message.id,
					error: { code: -32603, message: 'stub server: completions are unavailable' }
				})
			);
			return;
		}
		// A real `CompletionList` with the three fields the source reads:
		// a signature in `detail`, JSDoc in `documentation`, and the range the
		// server would replace. `isIncomplete` stays false so the popover keeps
		// this list until the user moves off the word.
		delayed(() =>
			send({
				id: message.id,
				result: {
					isIncomplete: false,
					items: [
						{
							label: 'Widget',
							kind: 7,
							detail: '(class) Widget',
							documentation: { kind: 'markdown', value: 'A thing with an id and a label.' },
							insertText: 'Widget',
							textEdit: {
								range: {
									start: completionRange(message, 5),
									end: completionRange(message, 0)
								},
								newText: 'Widget'
							}
						},
						{
							label: 'WidgetFactory',
							kind: 7,
							detail: '(class) WidgetFactory',
							documentation: 'Builds widgets.',
							insertText: 'WidgetFactory'
						},
						{
							label: 'widgetId',
							kind: 6,
							detail: '(property) string widgetId',
							insertText: 'widgetId'
						}
					]
				}
			})
		);
		return;
	}
	if (typeof message.id === 'number' || typeof message.id === 'string') {
		delayed(() => send({ id: message.id, result: {} }));
	}
}

/**
 * The range the stub answers with: deliberately *wider* than the typed suffix,
 * so the two `lsp_insert_mode` values are distinguishable in a test.
 *
 * A real server narrows this to the expression it recognised — `wid` inside
 * `obj.wid` — which happens to coincide with the suffix and would leave
 * `replace_range` indistinguishable from `replace_suffix`. Reaching five
 * characters back covers `= wid` in `const widgetId = wid`, so accepting an item
 * under `replace_range` visibly eats text the user did not type and
 * `replace_suffix` visibly does not. The start is derived from the request, so a
 * test can point the request anywhere and still get a well-formed range.
 */
function completionRange(message: JsonRpcMessage, back: number): {
	line: number;
	character: number;
} {
	const position = (
		message.params as { position?: { line?: number; character?: number } } | undefined
	)?.position;
	const line = typeof position?.line === 'number' ? position.line : 0;
	const at = typeof position?.character === 'number' ? position.character : 0;
	return { line, character: Math.max(0, at - back) };
}

/**
 * One error on the first line and one warning on the second, at fixed offsets,
 * so a test can assert exact marks rather than "something was marked". Chunked
 * like every other reply: a notification is framed exactly like a request, and
 * the framing is what is under test.
 */
function publishDiagnostics(uri: string | undefined): void {
	if (!uri) return;
	send({
		method: 'textDocument/publishDiagnostics',
		params: {
			uri,
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					severity: 1,
					code: 2304,
					source: 'stub',
					message: 'stub server: cannot find name'
				},
				{
					range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
					severity: 2,
					source: 'stub',
					message: 'stub server: unused variable'
				}
			]
		}
	}, true);
}

process.stdout.on('error', () => {
	// The client killed us mid-write; nothing left to say and no way to say it.
	stdoutBroken = true;
});
