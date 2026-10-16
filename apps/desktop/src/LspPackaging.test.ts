import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { LspDescriptorContribution } from '@np/core';
import { LSP_DESCRIPTORS } from '../../../packages/core/src/plugins/lsp/descriptors';
import {
	asarCovers,
	deriveAsarUnpackPatterns,
	findBundledEntry,
	packageRootOf,
	runtimeClosure
} from './lsp-packaging';

/**
 * What the packaged app has to carry for the bundled server to start.
 *
 * A language server is spawned as a plain Node process running a script from
 * `app.asar.unpacked`, so every module that script reaches is resolved from that
 * unpacked tree. Anything left inside the asar is unreachable: Node cannot read
 * it, and the server dies at startup on a machine that has nothing installed.
 *
 * The unpack list is derived from the bundled descriptors rather than maintained
 * by hand. The list is asserted against the closure: every package reachable
 * from the entry script, by require or by a declared runtime dependency, has to
 * match a pattern in `apps/desktop/package.json`.
 */

function asarPatterns(): string[] {
	const manifest = JSON.parse(
		readFileSync(path.join(import.meta.dir, '..', 'package.json'), 'utf-8')
	) as { build: { asarUnpack?: string[] } };
	return manifest.build.asarUnpack ?? [];
}

describe('the packaged server closure (#263, #265, #281)', () => {
	const entry = findBundledEntry(LSP_DESCRIPTORS[0].bundled!, import.meta.dir);

	it('reaches every runtime package the entry script needs', () => {
		// Guards the guard: if the walk stopped finding the packages below, a list
		// that matched it would prove nothing.
		const { packages } = runtimeClosure(entry);
		const missing = [
			'@vtsls/language-service',
			'@vtsls/vscode-fuzzy',
			'@vscode/l10n',
			'vscode-languageserver',
			'vscode-jsonrpc',
			'jsonc-parser',
			'semver',
			'typescript'
		].filter((name) => !packages.has(name));
		expect(missing).toEqual([]);
	});

	it('unpacks every package the entry script needs', () => {
		const patterns = asarPatterns();
		const missing = [...runtimeClosure(entry).packages]
			.filter((name) => !asarCovers(name, patterns))
			.sort();

		// A package left inside the asar cannot be read by the process running the
		// unpacked script, so the server dies at startup with nothing installed.
		expect(missing).toEqual([]);
	});

	it('matches the derived unpack patterns generated from bundled descriptors (#281)', () => {
		const patterns = asarPatterns();
		const derived = deriveAsarUnpackPatterns(LSP_DESCRIPTORS, import.meta.dir);
		expect(patterns).toEqual(derived);
	});

	it('covers the installed closure of every bundled descriptor (#281)', () => {
		const patterns = asarPatterns();
		for (const descriptor of LSP_DESCRIPTORS) {
			if (!descriptor.bundled) continue;
			const bundledEntry = findBundledEntry(descriptor.bundled, import.meta.dir);
			const closure = runtimeClosure(bundledEntry);
			const missing = [...closure.packages]
				.filter((name) => !asarCovers(name, patterns))
				.sort();
			expect(missing).toEqual([]);
		}
	});

	it('reads every target it resolves', () => {
		const { unreadable } = runtimeClosure(entry);
		expect(unreadable).toEqual([]);
	});

	it('attributes every file it reads to the package containing it', () => {
		const misattributed = runtimeClosure(entry).files
			.filter((file) => {
				const root = packageRootOf(file);
				return root !== null && !file.startsWith(root + path.sep);
			})
			.sort();
		expect(misattributed).toEqual([]);
	});
});

describe('adding a second server is one descriptor and configuration (#281)', () => {
	it('derives packaging rules for a second server without modifying client or packaging code', async () => {
		const fixtureDescriptor: LspDescriptorContribution = {
			id: 'fixture-server',
			command: 'tsc',
			args: ['--stdio'],
			rootMarkers: ['tsconfig.json'],
			languages: ['TypeScript'],
			languageIds: { TypeScript: 'typescript' },
			bundled: { package: 'typescript', binary: 'bin/tsc' },
			capabilities: {
				textDocument: {
					synchronization: {
						dynamicRegistration: true,
						change: 2
					}
				},
				textDocumentSync: 2
			}
		};

		// 1. Packaging rules derive automatically for both servers without changing packaging rules.
		const combined = [...LSP_DESCRIPTORS, fixtureDescriptor];
		const derivedPatterns = deriveAsarUnpackPatterns(combined, import.meta.dir);

		const fixtureEntry = findBundledEntry(fixtureDescriptor.bundled!, import.meta.dir);
		const fixtureClosure = runtimeClosure(fixtureEntry);
		expect(fixtureClosure.packages.has('typescript')).toBe(true);

		const missingFromFixture = [...fixtureClosure.packages]
			.filter((name) => !asarCovers(name, derivedPatterns))
			.sort();
		expect(missingFromFixture).toEqual([]);

		const vtslsEntry = findBundledEntry(LSP_DESCRIPTORS[0].bundled!, import.meta.dir);
		const vtslsClosure = runtimeClosure(vtslsEntry);
		const missingFromVtsls = [...vtslsClosure.packages]
			.filter((name) => !asarCovers(name, derivedPatterns))
			.sort();
		expect(missingFromVtsls).toEqual([]);

		// 2. Client initialize params carry the second server capabilities without modifying LspClient.
		const { LspClient, frameMessage } = await import('../../../packages/core/src/plugins/lsp/client');
		const { LspLogStore } = await import('../../../packages/core/src/plugins/lsp/logs');
		let writtenMessage: Record<string, unknown> | null = null;
		let stdoutCallback: ((chunk: Uint8Array) => void) | null = null;
		const fakeProc = {
			pid: 9999,
			parentPid: 9999,
			stdin: {
				write: (chunk: string | Uint8Array) => {
					const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
					const headerEnd = text.indexOf('\r\n\r\n');
					if (headerEnd >= 0) {
						const body = JSON.parse(text.slice(headerEnd + 4)) as Record<string, unknown>;
						if (body.method === 'initialize') {
							writtenMessage = body;
							const reply = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { capabilities: {} } });
							stdoutCallback?.(frameMessage(reply));
						}
					}
				},
				end: () => {}
			},
			stdout: {
				onData: (listener: (chunk: Uint8Array) => void) => {
					stdoutCallback = listener;
					return () => {
						stdoutCallback = null;
					};
				}
			},
			stderr: { onData: () => () => {} },
			exit: new Promise<never>(() => {}),
			kill: () => {}
		};

		const client = new LspClient({
			process: fakeProc as any,
			server: 'fixture-server@/repo',
			logs: new LspLogStore(),
			capabilities: fixtureDescriptor.capabilities
		});

		try {
			await client.initialize({ rootUri: 'file:///repo', capabilities: {} });
		} finally {
			client.dispose();
		}

		expect(writtenMessage).not.toBeNull();
		const clientCapabilities = (writtenMessage!.params as Record<string, unknown>).capabilities as Record<string, unknown>;
		expect(clientCapabilities.textDocumentSync).toBe(2);
		const sync = (clientCapabilities.textDocument as Record<string, unknown>).synchronization as Record<string, unknown>;
		expect(sync.dynamicRegistration).toBe(true);
		expect(sync.change).toBe(2);

		// 3. The typescript descriptor is registered (without asserting the
		// registry length, so a second bundled server can be added via
		// configuration without breaking this packaging test).
		expect(LSP_DESCRIPTORS.some((descriptor) => descriptor.id === 'typescript')).toBe(true);
	});
});
