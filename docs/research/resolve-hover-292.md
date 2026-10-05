# Research: Zed completionItem/resolve and hover contract (#292)

Parent map: #291. Question: what contract do Zed's `completionItem/resolve`
and hover present — when is resolve issued, what fields may it fill, and how
does hover share that path?

Zed sources below are the sparse checkout at `/tmp/opencode/zed`, rev
`708c7ee` (`file_finder: Implement SeedQuerySetting::Selection seed_query
(#64946)`). Line numbers refer to that rev. This repo's side is
`docs/adr/0021-word-fallback-composition.md` ("completionItem/resolve is not
used" section).

## 1. Capabilities advertised (`crates/lsp/src/lsp.rs`)

Client capabilities sent in `initialize` (`crates/lsp/src/lsp.rs:976-1020`):

- `completion.completionItem.resolveSupport.properties` =
  `["additionalTextEdits", "command", "detail", "documentation"]`
  (`lsp.rs:979-988`). `textEdit` is deliberately **excluded**, with the
  comment "Do not have this resolved, otherwise Zed becomes slow to complete
  things".
- Alongside: `snippet_support`, `deprecated_support`, `tag_support`
  (deprecated tag), `insert_replace_support`, `label_details_support`,
  `insert_text_mode_support` (`AS_IS`, `ADJUST_INDENTATION`),
  `documentation_format` (`Markdown`, `PlainText`), `completionList`
  `itemDefaults` (`commitCharacters`, `editRange`, `insertTextMode`,
  `insertTextFormat`, `data`), `context_support`, `dynamic_registration`.
- Hover is advertised separately (`lsp.rs:1029-1032`): `content_format`
  `[Markdown]` only, plus `dynamic_registration`. There is no resolve phase
  for hover in LSP, and Zed issues none — hover is a single
  `textDocument/hover` round trip (see §5).

## 2. Gate: resolve only if the server offers it

`GetCompletions::can_resolve_completions`
(`crates/project/src/lsp_command.rs:3151-3157`) returns true iff the
server's `completionProvider.resolveProvider` is true. It is consulted at
three sites in `crates/project/src/lsp_store.rs`, always through the
dynamic-registration-aware
`text_document_capability_matches_for_server` (`lsp_store.rs:5998-6020`):

1. `resolve_completions` (`lsp_store.rs:8002-8028`) — builds the
   `resolvable_servers` set; completions from other servers are skipped.
2. `apply_additional_edits_for_completion` (`lsp_store.rs:8447-8455`) —
   computes `can_resolve` for the confirm-time re-resolve.
3. `handle_resolve_completion_documentation` (`lsp_store.rs:12172-12180`) —
   the collab-host side; when false it returns the item unchanged instead of
   calling `ResolveCompletionItem`.

## 3. When resolve is issued (editor)

`CompletionsMenu::resolve_visible_completions`
(`crates/editor/src/code_context_menus.rs:662-766`):

- Triggered on menu render/selection change. Resolves the visible window
  plus `RESOLVE_BEFORE_ITEMS = RESOLVE_AFTER_ITEMS = 4` entries
  (`code_context_menus.rs:68-69, 694-715`).
- Skips candidates whose `Completion.documentation` is already `Some`
  (`:720-722`), **except** the current selection, which is always
  re-resolved to handle "out-of-spec language servers that return more
  results later" (`:724-736`).
- `resolve_completions: true` for the normal menu (`:396`), `false` for the
  snippet-choices menu (`:476-477`), which therefore never resolves.
- Markdown pre-parse for nearby entries uses a smaller window
  (`MARKDOWN_CACHE_BEFORE/AFTER_ITEMS = 2`, cache size 16, `:57-65, :769+`).
- The resolve task returns `did_resolve: bool`; on `true` the editor calls
  `cx.notify()` and restarts markdown parsing for nearby entries
  (`:751-766`).

Provider plumbing: `CompletionProvider::resolve_completions` defaults to
`Ok(false)` (`crates/editor/src/completions.rs:1153-1161`); the project
provider forwards to `LspStore::resolve_completions`
(`completions.rs:1476-1488`). Initial items arrive with `resolved: false`
(`lsp_command.rs:3340-3350`); only the `data` item-default is backfilled
(for JDTLS, which wants the item unchanged for resolve, `:3331-3339`).

## 4. Which fields resolve may fill, and what Zed does with each

Local path: `resolve_completion_local` (`lsp_store.rs:8126-8225`) sends the
stored `lsp::CompletionItem` via `lsp::request::ResolveCompletionItem`
(`:8154-8157`) with the global LSP request timeout (`:8031-8035`,
`ProjectSettings::global_lsp_settings.get_request_timeout()`), then swaps in
the returned item and sets `resolved = true` (`:8187-8188`). Once-only:
already-`resolved` items return early (`:8147-8149, :8180-8182`), and both
send and apply sites guard on `server_id` match (`:8150-8153, :8183-8186`).
Non-LSP sources (`BufferWord`, `Dap`, `Custom`) are no-ops (`:8159-8163`).

Per-field consumption:

- `documentation` → `Completion.documentation` via
  `regenerate_completion_labels` (`lsp_store.rs:8227-8248`), using
  `From<lsp::Documentation>` (`lsp_store.rs:16277-16300`): one-line text →
  `SingleLine`, multi-line plain → `MultiLinePlainText`, markdown →
  `MultiLineMarkdown`; absent → `Undocumented`. The menu renders
  single-line docs inline and markdown in the aside
  (`code_context_menus.rs:919-1094, 1240-1281`).
- `detail` → label regeneration through the language adapter's
  `labels_for_completions` (`lsp_store.rs:8250-8280`), explicitly to cover
  servers (e.g. vtsls, cites `yioneko/vtsls#213`) that return `detail`
  lazily via resolve "regardless of the resolvable properties Zed
  advertises"; falls back to `CodeLabel::fallback_for_completion`
  (`:8269-8274`).
- `textEdit`/`insertText` → only the **text content** is re-derived into
  `Completion.new_text` (`:8211-8222`), as a workaround for the VS Code
  TypeScript / vtsls `completeFunctionCalls` flow that adds snippet
  parentheses during resolve (code cites the vscode and vtsls sources).
  The `replace`/`insert` ranges are **not** updated — they were converted to
  anchors from the original response and stay valid across buffer edits
  (stale-range note, cites `#34094`). The code also notes the LSP 3.17 rule
  that `sortText`/`filterText`/`insertText`/`textEdit` are not supposed to
  change during resolve (`:8190-8191`).
- `additionalTextEdits` → **deferred to confirm**, not applied at resolve.
  `apply_additional_edits_for_completion` (`lsp_store.rs:8390-8544`)
  re-resolves first (`:8464-8472`), then converts edits and applies them in
  a separate transaction, skipping ones overlapping the primary edit
  (cites `#26136`, `#56973`, PR `#1871`; `:8496-8527`).
- `command` → executed **post-confirm** as a code action
  (`crates/editor/src/completions.rs:1024-1102`): only if the command name
  appears in the server's `executeCommandProvider.commands` (`:1037-1047`),
  then `apply_code_action` after the additional-edits transaction
  (`:1084-1102`).
- Test seam: `handle_resolve_completion_request` in
  `crates/editor/src/editor_tests.rs:41755` stubs
  `ResolveCompletionItem` to return `additional_text_edits`, and the
  `confirm_completion_*` tests assert the confirm-time application.

Remote (collab guest) path: `resolve_completion_remote` (`lsp_store.rs:8290-
8388`) serializes the item over proto `ResolveCompletionDocumentation` and
applies the host's answer; the host handler is
`handle_resolve_completion_documentation` (`lsp_store.rs:12160-12259`). The
proto comment (`crates/proto/proto/lsp.proto:606-610`) notes the message
"is used to resolve more than just the documentation, but for
backwards-compatibility reasons we can't rename the type": the response
carries `documentation` + `documentation_is_markdown`, the resolved
`lsp_completion` bytes, plus `new_text` and the old replace/insert anchors
(`lsp.proto:611-628`).

## 5. Hover: separate request, shared plumbing

Hover never touches `completionItem/resolve`. It is an independent
`textDocument/hover` request via the `GetHover` `LspCommand`
(`crates/project/src/lsp_command.rs:2921-3119`), gated on
`hoverProvider` (`Simple(true)` or `Options`) (`:2930-2936`), fanned out
locally with `request_multiple_lsp_locally` or proxied over proto for guests
(`lsp_store.rs:9188-9259`), with empty-block filtering and dedup
(`remove_empty_hover_blocks`, `deduplicate_hovers`). The editor consumes it
through `SemanticsProvider::hover` (`crates/editor/src/editor.rs:11818+`).

What hover "shares" with the resolve path:

- The same local-vs-remote fan-out shape (local
  `request_multiple_lsp_locally` vs guest proto proxy + host handler).
- The same capability-matching helper family
  (`text_document_capability_matches_for_server` et al.).
- The same Markdown pipeline for display: completion documentation aside
  uses a `Markdown` entity + LRU cache (`code_context_menus.rs:769-899`)
  analogous to the hover popover, and both negotiate markdown content
  (`documentation_format` vs hover `content_format: [Markdown]`).

## 6. Relevance to this repo (ADR 0021)

`docs/adr/0021-word-fallback-composition.md` ("A named range, and what a
completion item may say") records the opposite decision for our client:
`completionItem/resolve` is **not used**, `initialize` declares
`completionProvider: { resolveProvider: false }`, so lazily-withheld
documentation (e.g. vtsls) simply does not appear; hover is deferred
alongside resolve as a design of its own (spec #263). Adopting Zed's
contract would mean: advertise the four resolve properties (§1) while
keeping `textEdit` excluded; gate per server on `resolveProvider` (§2);
resolve the visible window with once-only semantics (§3); consume
`documentation`/`detail` into docs + regenerated labels, re-derive only
`new_text` from the resolved edit, and defer `additionalTextEdits` +
`command` to confirm time (§4). Hover stays a separate `textDocument/hover`
request sharing only the fan-out/capability/markdown plumbing (§5).
