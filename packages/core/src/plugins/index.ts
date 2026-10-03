export * from './editor';
export * from './types';
export * from './errors';
export * from './commands';
export * from './events';
export * from './hooks';
export * from './services';
export * from './settings';
export * from './ui-contributions';
export * from './host.svelte';
// NOTE: boundary-check is intentionally NOT re-exported here. It imports
// typescript + node:fs (dev/test tooling) which Vite externalizes for browser
// compatibility, crashing client code. Import it directly ('./boundary-check')
// from node runtimes (tests, scripts) instead.
export * from './languages';
export * from './language-scope';
export * from './completions';
export * from './lsp-descriptors';
export * from './lsp/completions';
export * from './lsp/logs';
export {
	LspRuntime,
	LSP_RUNTIME_SERVICE_KEY,
	lspServerKey,
	type LspCompletionOutcome,
	type LspCompletionRequest,
	type LspDocumentInput,
	type LspServerState,
	type LspServerStatus
} from './lsp/lifecycle';
export { manifest as gitManifest } from './git/manifest';
export { gitRegistration } from './git/registration';
export { manifest as svelteLanguageManifest } from './svelte-language/manifest';
export { svelteLanguageRegistration } from './svelte-language/registration';
export { manifest as lspManifest } from './lsp/manifest';
export { lspRegistration } from './lsp/registration';
