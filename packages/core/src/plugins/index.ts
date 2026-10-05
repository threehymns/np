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
export {
	LSP_RUNTIME_SERVICE_KEY,
	lspServerKey,
	type LspDocumentInput,
	type LspRuntime
} from './lsp/lifecycle';
// Types only. The UI layer's LSP components read the plugin's own services and
// render its decoded items, and nothing outside the plugin needs its client, its
// process, its buffers or the functions that parse a reply — so those stay behind
// the plugin's lazy import. A `export *` here would publish all of them as values
// and quietly make the claim false, which is why the service keys below are named
// one by one instead: a key is a string convention, not an implementation, and it
// is what a consumer needs in order to look up an opaque service (ADR 0008).
export { LSP_LOG_STORE_SERVICE_KEY } from './lsp/logs';
export type {
	LspLogStore,
	LspLogEntry,
	LspLogFilter,
	LspLogKind,
	LspLogLevel,
	LspLogsFocus
} from './lsp/logs';
// Command ids, as bare strings: the status menu has to name the commands it
// dispatches, and importing the constants is what stops a rename in `commands`
// from leaving the menu pointing at nothing — a literal in a component compiles
// either way and fails only when a user opens it.
export {
	LSP_RESTART_SERVER_COMMAND,
	LSP_STOP_SERVER_COMMAND,
	LSP_RESTART_ALL_SERVERS_COMMAND,
	LSP_STOP_ALL_SERVERS_COMMAND,
	LSP_VIEW_LOGS_COMMAND
} from './lsp/commands';
export type { ServerCompletionItemKind, ServerCompletionList } from './lsp/completions';
export type {
	LspServerState,
	LspServerStatus,
	LspServerStatusApi,
	LspStatusDetail
} from './lsp/status';
export { manifest as gitManifest } from './git/manifest';
export { gitRegistration } from './git/registration';
export { manifest as svelteLanguageManifest } from './svelte-language/manifest';
export { svelteLanguageRegistration } from './svelte-language/registration';
export { manifest as lspManifest } from './lsp/manifest';
export { lspRegistration } from './lsp/registration';
