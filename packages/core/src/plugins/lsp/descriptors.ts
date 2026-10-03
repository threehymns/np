import type { LspDescriptorContribution } from '../lsp-descriptors';

/**
 * The bundled server descriptors (spec #263).
 *
 * One descriptor serves TypeScript, TSX, JavaScript and JSX, matching the
 * one-package model the language registry already uses for grammars: four
 * extensions, one process, one `tsconfig.json` hierarchy. A descriptor is the
 * whole configuration surface for a server, so adding a language is a line in
 * `languages` and adding a server is another entry in this list.
 *
 * `command` names the executable and is resolved by the transport against
 * `node_modules` first and `PATH` second; nothing here downloads or manages a
 * binary. Bundling vtsls is #265's ticket — the descriptor is declared here so
 * root scoping and lifecycle are exercised against a real descriptor shape, and
 * a machine without the binary simply logs a spawn failure instead of a server.
 *
 * The marker order is the interesting part and is not a set: a `tsconfig.json`
 * is the TypeScript server's own configuration file, a `jsconfig.json` is its
 * JavaScript equivalent, and a `package.json` is the weakest evidence because
 * every JavaScript project has one. A nested package's `package.json` therefore
 * never outranks a `tsconfig.json` above it (see `root.ts`).
 */
export const LSP_DESCRIPTORS: readonly LspDescriptorContribution[] = [
	{
		id: 'typescript',
		command: 'vtsls',
		args: ['--stdio'],
		rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
		languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']
	}
];
