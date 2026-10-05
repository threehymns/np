import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { LspProcess, LspSpawnOptions, LspPlatform } from '@np/core';

/**
 * A real-process platform for the LSP plugin's tests.
 *
 * Spawns the scripted stub server through Node's `child_process`, so the tests
 * exercise the actual framing path — real pipes, real chunk boundaries, real
 * process lifetime — with only the *choice of executable* swapped for the stub.
 * The command the descriptor declares is recorded and still asserted. Faking the
 * stream instead would prove nothing: a fake cannot produce a chunk boundary
 * inside a multi-byte character, which is the bug this seam exists to prevent,
 * and #265's completion tests would then be asserting against a stub of a stub.
 *
 * The bundled vtsls is not used here even though `apps/desktop` now depends on
 * it. Indexing a real project to answer one query is minutes of work and a
 * machine-dependent answer, where the stub answers the same request in
 * milliseconds and identically on every CI runner — including the Windows one.
 */

export const STUB_SERVER_PATH = join(import.meta.dir, 'lsp-stub-server.ts');

export interface SpawnedServer {
	readonly process: LspProcess;
	/** The command the descriptor asked for, kept for assertion. */
	readonly requestedCommand: string;
	readonly requestedArgs: readonly string[];
	readonly cwd: string;
}

/** Extra argv handed to the stub, e.g. `--mode silent --delay-ms 500`. */
export type StubScript = readonly string[];

export interface RealProcessPlatformOptions {
	readonly script?: StubScript;
	/** Swaps the descriptor's command for the stub binary. Default true. */
	readonly useStubBinary?: boolean;
}

export interface RealProcessPlatform extends LspPlatform {
	readonly spawned: SpawnedServer[];
	/** Every process this platform started, so a test can assert it is gone. */
	readonly pids: number[];
}

export function createRealProcessPlatform(
	options: RealProcessPlatformOptions = {}
): RealProcessPlatform {
	const script = options.script ?? [];
	const useStubBinary = options.useStubBinary ?? true;
	const spawned: SpawnedServer[] = [];
	const pids: number[] = [];

	return {
		spawned,
		pids,
		async fileExists(path) {
			try {
				await access(path);
				return true;
			} catch {
				return false;
			}
		},
		spawn(spawnOptions: LspSpawnOptions): LspProcess {
			const command = useStubBinary ? process.execPath : spawnOptions.command;
			const args = useStubBinary
				? [STUB_SERVER_PATH, ...spawnOptions.args, ...script]
				: [...spawnOptions.args];
			const child = spawn(command, args, {
				cwd: spawnOptions.cwd,
				stdio: ['pipe', 'pipe', 'pipe']
			});
			if (child.pid !== undefined) pids.push(child.pid);
			// Not named `process`: a local by that name shadows the global for the
			// whole block, and `process.execPath` above would then read this
			// uninitialized binding instead of the runtime's.
			const lspProcess = asLspProcess(child);
			spawned.push({
				process: lspProcess,
				requestedCommand: spawnOptions.command,
				requestedArgs: spawnOptions.args,
				cwd: spawnOptions.cwd
			});
			return lspProcess;
		}
	};
}

type ChildProcess = ReturnType<typeof spawn>;

/** Bridges a Node stream to the seam's listener shape, and unsubscribes exactly. */
function forward(
	stream: { on(event: 'data', listener: (chunk: Buffer) => void): unknown; off(event: 'data', listener: (chunk: Buffer) => void): unknown },
	listener: (chunk: Uint8Array) => void
): () => void {
	const wrapped = (chunk: Buffer) => listener(new Uint8Array(chunk));
	stream.on('data', wrapped);
	return () => stream.off('data', wrapped);
}

function asLspProcess(child: ChildProcess): LspProcess {
	return {
		get pid() {
			return child.pid;
		},
		get parentPid() {
			return process.pid;
		},
		stdin: {
			write: (chunk) => {
				child.stdin.write(Buffer.from(chunk));
			},
			end: () => child.stdin.end()
		},
		stdout: { onData: (listener) => forward(child.stdout, listener) },
		stderr: { onData: (listener) => forward(child.stderr, listener) },
		exit: new Promise((resolve) => {
			child.on('close', (code, signal) =>
				resolve({ code: code ?? null, signal: signal ?? null })
			);
			child.on('error', (error) =>
				resolve({ code: -1, signal: null, error: error.message })
			);
		}),
		kill: () => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
	};
}

/** Whether a pid still names a live process. The check a disable has to pass. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Waits for a condition, polling. Never skips: a slow assertion is made reliable. */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	{ timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
