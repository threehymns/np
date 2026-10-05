# Research: Zed code actions, executeCommand, and additionalTextEdits (#293, part of #291)

Question: how do Zed's `codeAction`/`resolve`, `workspace/executeCommand`, and
completion `additionalTextEdits` compose — what must the client advertise, and
what must it apply?

Primary sources: Zed source at `/tmp/opencode/zed` (read 2026-10-05),
LSP 3.17 spec
(`microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/`),
and this repo's `packages/core/src/plugins/lsp/`.
All Zed line numbers below are against that checkout.

## 1. What the client must advertise (`initialize`)

Zed builds one `ClientCapabilities` in `crates/lsp/src/lsp.rs` (`initialize`
params, ~lines 888–1120). The pieces relevant here:

- `workspace.applyEdit: true` (line 935) — client handles
  `workspace/applyEdit`. Zed's handler (`on_lsp_workspace_edit`,
  `crates/project/src/lsp_store.rs:3993-4027`) applies the edit, emits
  `WorkspaceEditApplied`, stashes the transaction in
  `last_workspace_edits_by_language_server[server_id]`, and always replies
  `{ applied: true }`.
- `workspace.executeCommand: { dynamicRegistration: true }` (936–938).
- `workspace.workspaceEdit: { resourceOperations: [Create, Rename, Delete],
  documentChanges: true, snippetEditSupport: true }` (919–928) — needed
  because code-action edits arrive as `WorkspaceEdit` with
  `documentChanges` ops, not just `changes`.
- `textDocument.codeAction` (952–975):
  - `codeActionLiteralSupport.codeActionKind.valueSet =
    [Refactor, QuickFix, Source]` — servers may only send these kinds when the
    client asks with `context.only`;
  - `dataSupport: true` — the client round-trips opaque `data`, which is what
    makes lazy resolve possible;
  - `resolveSupport.properties =
    [kind, diagnostics, isPreferred, disabled, edit, command]` — the client
    accepts actions missing `edit`/`command` and fills them via
    `codeAction/resolve`;
  - `dynamicRegistration: true`.
- `textDocument.completion.completionItem.resolveSupport.properties =
  [additionalTextEdits, command, detail, documentation]` (979–988) with an
  explicit comment: `textEdit` is deliberately **not** listed ("otherwise Zed
  becomes slow"). Plus `insertReplaceSupport`, `labelDetailsSupport`,
  `completionList.itemDefaults =
  [commitCharacters, editRange, insertTextMode, insertTextFormat, data]`
  (1008–1016).
- `general.positionEncodings: [UTF16]` (891).

Server side Zed reads (`ServerCapabilities`): `codeActionProvider`
(`Simple(bool)` vs `Options{ codeActionKinds?, resolveProvider? }`),
`executeCommandProvider.commands`, `completionProvider.resolveProvider`.

Gap in this repo: `packages/core/src/plugins/lsp/client.ts:225-261`
`initialize()` sends `capabilities: { textDocumentSync: 1,
completionProvider: { resolveProvider: false, /* no triggerCharacters */ },
...params.capabilities }` — those are **server**-capability names in the
**client** slot, so a spec-correct server sees no
`textDocument.codeAction`, no `workspace.executeCommand`/`applyEdit`, and no
completion `resolveSupport`. `lifecycle.ts:609-613` passes
`capabilities: {}` through, and `completions.ts:96-127`
`parseServerCompletions` drops `additionalTextEdits`, `command`, and `data`
entirely. Any code-action work here starts with fixing that advertisement.

## 2. `textDocument/codeAction` request (`GetCodeActions`)

`crates/project/src/lsp_command.rs:240-243, 3502-3744`.

- Gate (`check_capabilities`, 3511–3534): false when
  `codeActionProvider` is absent or `Simple(false)`. When the caller passes
  `kinds` **and** the server advertises `codeActionKinds` (either inline in
  `Options` or via adapter `code_action_kinds`, 3717–3732), the request is only
  sent if some requested kind prefix-matches a supported kind
  (`code_action_kind_matches`, line 44; prefix match, so `refactor` covers
  `refactor.extract`).
- Params (`to_lsp`, 3536–3574): `textDocument`, `range`, and
  `context: { diagnostics (clipped to range, UTF-16, markup downgraded for
  foreign servers), only: kinds }`.
- Response filter (`response_from_lsp`, 3576–3639), two independent drops:
  1. an action whose `command` is set but **not** in the server's current
     `executeCommandProvider.commands` is dropped; a bare `Command` response
     is wrapped as `LspAction::Command` and marked `resolved = true` only if
     advertised, else dropped;
  2. if `only` was requested, actions whose `kind` does not match are dropped.
  Survivors become `CodeAction { server_id, range, lsp_action, resolved }`
  (`crates/project/src/project.rs:781-805`; `LspAction =
  Action(CodeAction) | Command(Command) | CodeLens(CodeLens)`).

## 3. `codeAction/resolve`

- Capability predicate: `GetCodeActions::can_resolve_actions`
  (`lsp_command.rs:3734-3743`) = `codeActionProvider.Options.resolve_provider
  == true` (`Simple` never resolves). Checked per buffer/server including
  dynamic registrations (`can_resolve_lsp_action_for_buffer`,
  `lsp_store.rs:6516-6541`; `Command` actions return false — never resolved).
- Resolve itself: `try_resolve_code_action` (`lsp_store.rs:2840-2875`).
  For `Action` it sends `codeAction/resolve` **iff** `!resolved &&
  can_resolve && data.is_some() && (command.is_none() || edit.is_none())`,
  then sets `resolved = true` unconditionally (even when skipped, so it is
  never retried). `CodeLens` resolves when `!resolved && can_resolve`;
  `Command` is a no-op.
- Public wrapper `resolve_code_action` (6723–6775) short-circuits on
  `resolved`, marks unresolvable actions resolved without a round trip, and
  otherwise resolves locally or via `proto::ResolveCodeAction` (remote/collab
  path, handler at 6777–6797).

Net rule: servers may return skeletal actions (title + kind + data) and fill
`edit`/`command` lazily; the client must send `data` back verbatim.

## 4. Applying: edit first, then command (`apply_code_action`)

`apply_code_action` (`lsp_store.rs:6543-6660`); batch twin
`execute_code_actions_on_server` (3487–3590); same sequence inside the
format path (`format_locally`, ~2118–2434).

1. Resolve (above).
2. If `action.edit` has `changes` or `documentChanges`, apply via
   `deserialize_workspace_edit` (3718–3990): `documentChanges` (`Edits` or full
   `Operations`: Create / Rename / Delete with parent-dir creation,
   dirty-buffer flush-before-rename, entry-id preservation) wins over the
   legacy `changes` map. Returns a `ProjectTransaction`.
3. Else, if `action.command` exists: re-check it against
   `executeCommandProvider.commands` — skip with a log if unlisted
   (the standalone `execute_lsp_command`, 6662–6721, instead **errors**:
   `"command … is not advertised by the language server"`). Then clear
   `last_workspace_edits_by_language_server[server]`, send
   `workspace/executeCommand { command, arguments ?? [] }`, and return whatever
   edits the command produced **via `workspace/applyEdit` notifications**
   during the call (collected by `on_lsp_workspace_edit`, 3993–4027).
   A command is therefore never applied as a return value — only through the
   applyEdit channel, which is why `applyEdit: true` is mandatory.

So `edit` and `command` compose as alternatives with a fixed order
(edit-then-command), and commands that touch files only land if the client
implements `workspace/applyEdit` and attributes the resulting transaction to
the commanding server.

## 5. Completion `additionalTextEdits`

- Predicate: `GetCompletions::can_resolve_completions`
  (`lsp_command.rs:3150-3157`) = `completionProvider.resolveProvider == true`.
- Resolve: `resolve_completion_local` (`lsp_store.rs:8126-8225`). Skips when
  `!can_resolve`, already `resolved`, or non-LSP source; asserts the resolving
  server owns the item; sends `completionItem/resolve`. Per spec it must **not**
  use `sortText/filterText/insertText/textEdit` to re-derive identity — but
  Zed still refreshes `new_text` from the resolved `textEdit`/`insertText`
  (8211–8222) as a targeted workaround for the vtsls
  `completeFunctionCalls` snippet-parentheses flow, keeping the original
  anchor ranges (stale LSP ranges are kept off the `Completion`).
- Apply: `apply_additional_edits_for_completion` (8390–8545; remote handler
  12509–12559 via `proto::ApplyCompletionAdditionalEdits`).
  1. Resolve first (same predicate).
  2. Read `lsp_completion.additional_text_edits`; `None` → no transaction.
  3. Convert with `edits_from_lsp` (clip to snapshot, merge adjacent /
     newline-separated edits à la rust-analyzer whole-file rewrites, fine-diff
     multiline edits to preserve anchors).
  4. Apply in **one** buffer transaction, skipping edits that overlap the
     primary commit ranges — zero-width insertions only when strictly inside a
     commit range, range edits on boundary touch (fixes `zed#26136`,
     `zed#56973`; base rule from `zed#1871`). `push_to_history=false` forgets
     the transaction (undo-merge behaviour callers control).

Note the asymmetry the client advertises: completion resolve covers
`additionalTextEdits` but the client applies the primary `textEdit` from the
original response and only the *additional* edits from resolve — hence not
advertising `textEdit` resolve (perf) while still accepting servers that send
it eagerly.

## 6. Implications for this repo (map #291)

1. Fix `initialize` capabilities to the §1 shape (real `ClientCapabilities`:
   `textDocument.codeAction.{literalSupport,dataSupport,resolveSupport}`,
   `textDocument.completion.completionItem.resolveSupport` incl.
   `additionalTextEdits`, `workspace.{applyEdit,executeCommand,workspaceEdit}`).
2. Implement request → filter (drop commands the server didn't advertise) →
   conditional resolve (`data`-gated) → edit-then-executeCommand apply, with an
   `applyEdit` handler that attributes command-produced edits to the commanding
   server.
3. Implement completion resolve-before-apply for `additionalTextEdits` with the
   overlap-skip and single-transaction rules, since the current decoder drops
   the field.

## Sources

- `/tmp/opencode/zed/crates/lsp/src/lsp.rs:888-1020` (client capabilities)
- `/tmp/opencode/zed/crates/project/src/lsp_command.rs:44, 233-243,
  3150-3158, 3502-3744` (GetCompletions/GetCodeActions)
- `/tmp/opencode/zed/crates/project/src/lsp_store.rs:2840-2875` (try_resolve),
  `3487-3590` (batch execute), `3718-4027` (workspace-edit apply + applyEdit
  capture), `6516-6775` (can_resolve/apply/execute/resolve),
  `8100-8545` (completion resolve + additional edits),
  `12509-12559` (remote additional-edits handler),
  `14117-14170` (code-action proto round-trip)
- `/tmp/opencode/zed/crates/project/src/project.rs:775-843`
  (`CodeAction`/`LspAction`)
- LSP 3.17: `textDocument/codeAction`, `codeAction/resolve`,
  `workspace/executeCommand`, `workspace/applyEdit`,
  `completionItem/resolve` (+ `additionalTextEdits`)
- This repo: `packages/core/src/plugins/lsp/client.ts:225-261`,
  `lifecycle.ts:609-613`, `completions.ts:96-127`,
  `client.test.ts`, `lifecycle.test.ts:340-341`
