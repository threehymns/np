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
// The merged diagnostics store, for the diagnostics tab (#309). The tab reads
// the store's public surface and never the protocol behind it, so the types it
// needs are published by name — the store, the diagnostics it holds, and the
// severity they carry.
export { LSP_DIAGNOSTICS_STORE_SERVICE_KEY } from './lsp/diagnostics';
export type {
	LspDiagnostic,
	LspDiagnosticSeverity,
	LspDiagnosticsStore,
	LspPosition,
	LspRange
} from './lsp/diagnostics';
// The inverse of the file URI the protocol addresses documents with, so a
// consumer can match a diagnostic's URI against a local path.
export { fromFileUri } from './lsp/root';
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
export { LSP_UI_COMPONENTS_KEY, getLspUIComponents } from './lsp/ui';
export type { LspUIComponents } from './lsp/ui';
// The diagnostics display plan (issue #310). A surface that shows diagnostics —
// the diagnostics list of #309, which is a UI component and so can only reach
// the core through this package — reads the same narrowing the editor's own
// surfaces read, so that a severity ceiling means one thing in all of them.
// The module is plain: it reads diagnostics, never the protocol, and knows
// nothing about the editor.
export {
	DEFAULT_DIAGNOSTIC_DISPLAY_SETTINGS,
	isDiagnosticSeverity,
	isMoreSevere,
	planDiagnosticDisplay,
	readDiagnosticDisplaySettings,
	visibleDiagnostics
} from './lsp/diagnostic-display';
export type {
	DiagnosticDisplayPlan,
	DiagnosticDisplaySettings,
	DiagnosticGutterMark
} from './lsp/diagnostic-display';
export {
	diagnosticHoverSource,
	diagnosticHoverTooltip,
	diagnosticTitle
} from './lsp/diagnostic-decorations';
export {
	DIAGNOSTIC_SEVERITIES,
	INLINE_DIAGNOSTICS_SETTING,
	LSP_SCHEMA,
	LSP_SETTINGS_NAMESPACE,
	MAX_SEVERITY_SETTING
} from './lsp/settings';
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
