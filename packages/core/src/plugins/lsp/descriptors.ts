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
 * The names in `languages` are the **registry's** names, because that is the
 * identity descriptors join on — the same rule `getContributionsForType` and the
 * snippet registry follow. That is not the same as the protocol's own id:
 * `@codemirror/language-data` publishes the TSX description as `TSX`, and
 * spelling it `typescriptreact` here would leave every `.tsx` file claimed by
 * nothing. The protocol id is derived separately, where the document is synced
 * (`LspRuntime.languageIdFor`).
 *
 * `command` names the executable and is resolved by the transport against the
 * bundled dependency first and `PATH` second; nothing here downloads or manages a
 * binary. Bundling vtsls is what makes the proof of concept work on a machine
 * with nothing installed (see `LspCommandResolver`).
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
		languages: ['TypeScript', 'TSX', 'JavaScript', 'JSX']
	}
];
