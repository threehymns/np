import type { LspDescriptorContribution } from '../lsp-descriptors';

/**
 * The bundled LSP descriptors (spec #263).
 *
 * One descriptor serves TypeScript, TSX, JavaScript and JSX, matching the
 * one-package model the language registry already uses for grammars: four
 * extensions, one process, one `tsconfig.json` hierarchy. A descriptor is the
 * whole configuration surface for a server, so adding a language is a line in
 * `languages` and adding a server is another entry in this list.
 *
 * The names in `languages` are the **registry's** names, because that is the
 * identity descriptors join on — the same rule `getContributionsForType` and the
 * snippet registry follow. That is not the same as the protocol's own id:
 * `@codemirror/language-data` publishes the TSX description as `TSX`, so
 * spelling it `typescriptreact` here would leave every `.tsx` file claimed by
 * nothing. `languageIds` is where the two vocabularies meet: the registry name
 * on the left, the id the server answers to on the right. It is not optional in
 * practice — TSX and JSX lowercase to ids no server recognises — which is
 * exactly why it is descriptor data rather than a derivation in the runtime.
 *
 * `command` names the executable and is resolved by the transport against the
 * bundled dependency first and `PATH` second; nothing here downloads or manages a
 * binary. `bundled` says which packaged dependency that first candidate is, so
 * the platform's resolver needs no per-server map of its own and a second server
 * is a second entry here (spec #263, story 10).
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
		languages: ['TypeScript', 'TSX', 'JavaScript', 'JSX'],
		languageIds: {
			TypeScript: 'typescript',
			TSX: 'typescriptreact',
			JavaScript: 'javascript',
			JSX: 'javascriptreact'
		},
		bundled: { package: '@vtsls/language-server', binary: 'bin/vtsls.js' }
	}
];
