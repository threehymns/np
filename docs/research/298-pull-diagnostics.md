# Research: Zed pull diagnostics and workspace refresh (#298, part of #291)

**Question:** How do Zed's `textDocument/diagnostic` pull, `workspace/diagnostic`
grouping, and diagnostic refresh compose — capability gates, debounce,
disk-based versus buffer sources?

**Primary sources:** `/tmp/opencode/zed` (`crates/project`, `crates/editor`,
`crates/diagnostics`), LSP 3.17 § Diagnostic Pull, and this repo's
`packages/core/src/plugins/lsp/diagnostics.ts`,
`diagnostic-decorations.ts`, ADR 0022. Every claim below cites its source.
Line numbers refer to the Zed checkout at `/tmp/opencode/zed` unless prefixed
with `repo:`.

**One-line answer:** Zed treats push (`publishDiagnostics`) and pull
(`textDocument/diagnostic`, `workspace/diagnostic`) as two writers into one
per-path diagnostic store, tagged `Pushed` / `Pulled` / `Other`; pull fires
per-buffer on edit with a 50 ms editor debounce plus a 100 ms cross-buffer
background queue, workspace pull runs in a perpetual per-server refresh loop
with 2 s repull delay and exponential backoff, and `workspace/diagnostic/refresh`
re-arms both loops; capability gates are static `diagnosticProvider` plus dynamic
`textDocument/diagnostic` registrations (identifier + result-id caching +
`interFileDependencies`), and disk-based sources are range-shifted through
unsaved edits while buffer sources are clipped in place. Display layers
(buffer sets → worktree summaries → editor inline/gutter → diagnostics panel)
all consume the merged store, never the protocol directly.

---

## 1. Push and pull compose in one store via `DiagnosticSourceKind`

- Push arrives on `lsp::notification::PublishDiagnostics` per running server and
  is merged with kind `Pushed`; the merge closure keeps old diagnostics only
  when the adapter says to retain them (`retain_old_diagnostic`), and always
  evicts old `Pulled` entries for that path
  (`crates/project/src/lsp_store.rs:897-927`).
- Document pull (`pull_diagnostics_for_buffer`) merges with kind `Pulled`; the
  closure keeps an old `Pulled` entry only when its `registration_id` differs
  or it was reported `Unchanged`, and always evicts `Pushed`/`Other` entries
  (`lsp_store.rs:9094-9116`).
- Workspace pull (`apply_workspace_diagnostic_report`) merges with kind
  `Pulled` under the same rule (`lsp_store.rs:14490-14505`).
- Net effect: **a fresh pull of any kind wins over a stale push for the paths
  it reports**, while a stale pull never clobbers a different registration's
  verdict — per-registration `result_id` caches make `Unchanged` cheap
  (`lsp_store.rs:14204-14277`, `lsp_store.rs:3074-3083`).
- All three funnels exit through `merge_diagnostic_entries`, which is the
  single fan-out to buffer sets, worktree diagnostics, summaries, and
  downstream (collab) propagation (`lsp_store.rs:10163+`; comment at
  `lsp_store.rs:10132-10155` names buffer sets, worktree diagnostics,
  summaries, downstream propagation as one call's effects).

## 2. Document pull path (`textDocument/diagnostic`)

- `LspStore::pull_diagnostics` (`lsp_store.rs:8547+`) builds one
  `GetDocumentDiagnostics` request per (server × provider):
  - Remote/collab branch: if there is an upstream client, it sends proto
    `GetDocumentDiagnostics` upstream and lets the host pull and propagate
    back; local processing is skipped (`lsp_store.rs:8561-8583`).
  - Local branch: gathers static capability providers
    (`initial_server_capabilities[server].diagnostic_provider`) plus dynamic
    registrations under `text_documents["textDocument/diagnostic"]`, skipping
    registrations whose document selector does not match the buffer
    (`lsp_store.rs:8591-8650`).
  - Each request carries `identifier` (server's diagnostic identifier),
    `registration_id`, and `previous_result_id` from the per-buffer cache, so
    servers can answer `Unchanged` (`lsp_store.rs:8630-8645`).
- `GetDocumentDiagnostics` command (`crates/project/src/lsp_command.rs:324+`):
  `check_capabilities` requires `diagnostic_provider.is_some()`
  (`lsp_command.rs:5392-5398` approx — `check_capabilities` on
  `GetDocumentDiagnostics`); `to_lsp` sends uri + identifier +
  previous_result_id; `response_from_lsp` handles Full / Unchanged / Partial
  reports plus `related_documents` (`lsp_command.rs:5416-5488`).
- `pull_diagnostics_for_buffer` (`lsp_store.rs:8996+`):
  - Retries `ServerCancelled`-style failures up to 3 times with 100 ms delay
    (`DOCUMENT_DIAGNOSTICS_RETRIGGER_LIMIT/DELAY`, `lsp_store.rs:181-182`,
    used at `lsp_store.rs:9003-9023`); other errors are logged or swallowed.
  - Drops responses whose registration no longer exists
    (`diagnostic_registration_exists` filter, `lsp_store.rs:9100+`).
  - `Unchanged { result_id }` reports refresh the result-id cache and
    contribute no diagnostics; `Changed` reports are rebuilt into
    `PublishDiagnosticsParams` with the adapter's `disk_based_sources` and
    merged as `Pulled` (`lsp_store.rs:9040-9116`).
- Buffer application (`update_buffer_diagnostics`, `lsp_store.rs:2974+`):
  sorts (position, then primary, then disk-based, then severity, then
  message), clips to the current snapshot, expands empty ranges by one
  codepoint, stores per-server `DiagnosticSet` on the buffer, and records the
  new `result_id` (`lsp_store.rs:2984-3088`).

## 3. Workspace pull path (`workspace/diagnostic`)

- A perpetual refresh task is spawned per server **only if** the provider
  opts into `workspace_diagnostics` (`workspace_diagnostic_identifier`
  returns `None` otherwise, `lsp_store.rs:15600+`; task created at
  `lsp_store.rs:13470-13484` and built by `lsp_workspace_diagnostics_refresh`,
  `lsp_store.rs:15317+`).
- The loop (`lsp_store.rs:15342-15560`):
  - Sleeps on `refresh_rx`; coalesces queued refreshes so one attempt serves
    all waiters.
  - Sends `previous_result_ids` from `result_ids_for_workspace_refresh`
    (`lsp_store.rs:14249+`) with a `partial_result_token`
    `workspace/diagnostic/{server}/{n}/id:{registration}` and streams partial
    results over the `progress_rx` channel (`lsp::ProgressParamsValue::WorkspaceDiagnostic`,
    matched by token in `on_lsp_progress`, `lsp_store.rs:11953-11980`).
  - Backoff `50 * 2^attempts` ms clamped to 30–1000 ms, up to 50 attempts
    then 3 more after a pause; server-closed requests are re-triggered per the
    LSP spec comment at `lsp_store.rs:15477-15479`.
  - Successful reports go through `apply_workspace_diagnostic_report`
    (`lsp_store.rs:14382+`), which (a) drops reports for dead registrations,
    (b) records workspace result-ids, and (c) **skips paths with open buffers**
    — "diagnostics from a document pull should win over diagnostics from a
    workspace pull" (`lsp_store.rs:14442-14480`).
  - After success with no pending refresh, idles on a 2 s repull timer
    (`WORKSPACE_DIAGNOSTICS_REPULL_DELAY`, `lsp_store.rs:179`).
- Signalling: `pull_workspace_diagnostics` (`lsp_store.rs:14278+`) pokes every
  refresh task's `refresh_tx`; `pull_workspace_diagnostics_once`
  (`lsp_store.rs:14298+`) attaches oneshot waiters so callers (e.g. agent
  tooling) can await fresh diagnostics.

## 4. Refresh: `workspace/diagnostic/refresh` and edit triggers

- Server → client `workspace/diagnostic/refresh` handler
  (`lsp_store.rs:1164-1190`): pulls workspace diagnostics, forwards a
  `PullWorkspaceDiagnostics` proto message downstream for remote peers, then
  pulls document diagnostics for all of that server's open buffers via
  `pull_document_diagnostics_for_server`. It responds before pulling because
  "awaiting a round-trip to the same server here can deadlock servers that
  bound their request concurrency" (comment at `lsp_store.rs:1182-1184`).
- Remote side: `handle_pull_workspace_diagnostics` (`lsp_store.rs:12289-12296`)
  re-runs the workspace pull on the host.
- `pull_document_diagnostics_for_server` (`lsp_store.rs:14329+`): refreshes
  every open buffer of that server except the originating one, through the
  background queue below.
- Edit trigger with `interFileDependencies` gate
  (`pull_document_diagnostics_for_buffer_edit`, `lsp_store.rs:14348+`): after
  an edit pull, if the server's `diagnostic_provider` sets
  `interFileDependencies`, all *other* open buffers of that server are
  re-pulled (checked per buffer at `crates/editor/src/diagnostics.rs:576+`
  call site context — the capability predicate itself is
  `diagnostics_inter_file_dependencies`, `lsp_store.rs:15568+`).
- Background queue (`refresh_background_diagnostics_for_buffers`,
  `lsp_store.rs:5234+`): dedupes buffer ids through
  `buffers_to_refresh_hash_set/queue` and drains one buffer per 100 ms tick
  (`CROSS_BUFFER_DIAGNOSTICS_PULL_DELAY`, `lsp_store.rs:180`, worker at
  `lsp_store.rs:5267-5280`). Buffer reload also re-pulls
  (`on_buffer_reloaded`, `lsp_store.rs:5282+`).
- Editor entry point (`crates/editor/src/diagnostics.rs:542-584`):
  `Editor::pull_diagnostics` runs on display-map/buffer changes
  (`crates/editor/src/editor.rs:11370`, `DiagnosticsUpdated` →
  `update_diagnostics_state` at `editor.rs:10226`), gated on
  `diagnostics.lsp_pull_diagnostics.enabled`, debounced by
  `debounce_ms`, then calls `pull_diagnostics_for_buffer` followed by the
  inter-file fan-out.

## 5. Capability gates

| Gate | Location | Rule |
| --- | --- | --- |
| Static document pull | `lsp_command.rs` `check_capabilities` | `server_capabilities.diagnostic_provider.is_some()` |
| Dynamic document pull | `lsp_store.rs:8603-8628` | registration under `text_documents["textDocument/diagnostic"]` whose document selector matches the buffer (`dynamic_text_document_registration_allows_buffer`); unmatched registrations skipped |
| Identifier | `lsp_store.rs:8630`, `buffer_diagnostic_identifier` (`lsp_store.rs:15580+`) | per-provider `identifier` sent; distinguishes parallel providers |
| Result id | `lsp_store.rs:14204-14227` | per (server, registration, abs-path) cache; sent as `previous_result_id` |
| Workspace pull | `workspace_diagnostic_identifier` (`lsp_store.rs:15595+`) | provider must set `workspace_diagnostics: true`, else no refresh task exists; `server_pulls_workspace_diagnostics` (`lsp_store.rs:1452+`) is true iff such tasks exist |
| Inter-file fan-out | `lsp_store.rs:14348-14379` | only when provider sets `interFileDependencies` |
| Remote | `is_capable_for_proto_request` (`lsp_store.rs:5762+`, used at `lsp_store.rs:8561+`) | proto request path checks capability before forwarding upstream |
| Master kill-switch | `project_settings.rs:661-671` | `diagnostics.lsp_pull_diagnostics.enabled` (default true); `enabled: false` makes `Editor::pull_diagnostics` return early (`diagnostics.rs:557-559`) |

## 6. Debounce and timing settings

- `diagnostics.lsp_pull_diagnostics.debounce_ms`, default **50 ms**, "minimum
  time to wait before pulling" (`project_settings.rs:661-671`); consumed by
  `Editor::pull_diagnostics` (`diagnostics.rs:560`).
- `diagnostics.inline.update_debounce_ms`, default **150 ms**
  (`project_settings.rs:635-657`); consumed by
  `refresh_inline_diagnostics(debounce: true, …)` (`diagnostics.rs:473-482`) —
  display-side only, not a pull throttle.
- `CROSS_BUFFER_DIAGNOSTICS_PULL_DELAY` **100 ms** between background-queue
  buffers (`lsp_store.rs:180, 5267-5280`).
- `DOCUMENT_DIAGNOSTICS_RETRIGGER_DELAY` **100 ms** × up to **3** retriggers
  on cancellable pull races (`lsp_store.rs:181-182, 9003-9023`).
- `WORKSPACE_DIAGNOSTICS_REPULL_DELAY` **2 s** idle repull
  (`lsp_store.rs:179`); per-attempt backoff 30–1000 ms inside the loop.
- Request timeout: workspace loop clamps to at least
  `DEFAULT_LSP_REQUEST_TIMEOUT` (`lsp_store.rs:15334-15340`).

## 7. Disk-based vs buffer sources

- Adapters declare which diagnostic `source` strings are disk-based, e.g.
  rust-analyzer's `disk_based_diagnostic_sources` plus a
  `disk_based_diagnostics_progress_token` (`crates/languages/src/rust.rs:311-315`;
  consumed at `lsp_store.rs:906, 9068, 14442`).
- Classification happens at merge: `is_disk_based =
  source ∈ disk_based_sources` (`lsp_store.rs:13324-13400`); stored on
  `Diagnostic.is_disk_based` and used for sort (after `is_primary`) and for
  the progress UI.
- Coordinate handling differs (`update_buffer_diagnostics`,
  `lsp_store.rs:3019-3032`): **disk-based** ranges are mapped from saved to
  current text via `edits_since_save.old_to_new` (they describe the file on
  disk); **buffer** ranges are used as-is. Both are then clipped to the
  snapshot; reused (anchor-stored) diagnostics skip the mapping.
- Progress: `window/progress` notifications whose token matches the adapter's
  disk token flip `is_disk_based_diagnostics_progress`, emitting
  `DiskBasedDiagnosticsStarted/Finished` events and status-bar state
  (`lsp_store.rs:11987-12050`, `lsp_store.rs:11644-11684`); servers without a
  token get a simulated completion
  (`simulate_disk_based_diagnostics_events_if_needed`, `lsp_store.rs:11695+`).
- Lifetime: closing a buffer drops its **pulled document** diagnostics but
  keeps pushed ones and keeps workspace-owned verdicts
  (`lsp_store.rs:5344-5375` — pushed stay because "a running server may still
  describe the file"; pulled document diagnostics "need an open document to be
  refreshed").

## 8. Display layers consume the store, never the protocol

- `Buffer::update_diagnostics(server_id, DiagnosticSet)` per server
  (`lsp_store.rs:3083`); `MultiBuffer/DisplayMap` filters by
  `diagnostics_max_severity` (`crates/editor/src/display_map.rs:1528-1530`).
- `MultiBuffer::Event::DiagnosticsUpdated` → `Editor::update_diagnostics_state`
  (`editor.rs:10226`, `diagnostics.rs:585-600`): refreshes the active diagnostic,
  re-renders inline diagnostics (debounced), and dirties scrollbar markers.
- Inline: `refresh_inline_diagnostics` (`diagnostics.rs:450-540`) filters by
  `max_severity` (setting or per-editor override), debounces, and writes
  `(Anchor, InlineDiagnostic)` pairs; can be disabled per editor
  (`disable_inline_diagnostics`, `diagnostics.rs:270+`).
- Gutter/scrollbar: diagnostic severity flows through `DisplayMap` and
  `scrollbar_marker_state`; the panel's `update_diagnostic_summary` reads
  `project.diagnostic_summary` (`crates/diagnostics/src/diagnostics.rs:720+`).
- Panel: `ProjectDiagnosticsEditor::refresh` (`diagnostics.rs:451+`)
  rebuilds excerpts from worktree diagnostics; `include_warnings` toggle and
  `toggle_diagnostics_refresh` (auto-refresh on/off, `diagnostics.rs:148, 423+`)
  control what it shows; it observes the same summary updates
  (`diagnostic_summary_update` task, `diagnostics.rs:195+`).

## 9. What this means for this repo (feeds #299)

This repo today is **push-only**, matching ADR 0022's scope:

- `repo:packages/core/src/plugins/lsp/diagnostics.ts:91-104` parses
  `textDocument/publishDiagnostics`; `LspDiagnosticsStore.publish/read/uris/dropServer/dropUri`
  (`diagnostics.ts:166-256`) is keyed by URI → server, mirroring Zed's
  per-server merge but without `registration_id`, `result_id`, or source-kind
  dimensions.
- `repo:packages/core/src/plugins/lsp/diagnostic-decorations.ts:54-75` renders
  inline marks from `store.revision` + shown URI, stamps + maps through edits —
  the equivalent of Zed's buffer-set → display-map half, with no pull trigger.
- ADR 0022 (`repo:docs/adr/0022-lsp-diagnostics-through-decorations.md`)
  describes only the publish → decoration-replay path; pull, refresh, and the
  panel are out of scope.

A pull implementation here would need, at minimum: advertise
`diagnosticProvider` in client capabilities; a `textDocument/diagnostic`
request path with per-(server, uri) `previousResultId` cache and `identifier`
handling; a `workspace/diagnostic/refresh` handler that re-pulls open buffers;
debounce + kill-switch settings analogous to `lsp_pull_diagnostics`
(enabled/50 ms); disk-based source shifting for servers that report against
saved files; and a panel/summary consumer over `uris()` (currently only the
editor decoration reads the store). Open design questions for #299: whether
`LspDiagnosticsStore` gains a `Pulled` dimension or a parallel cache, and
whether workspace-pull's "document pull wins for open buffers" rule is adopted
verbatim.

## Sources

- Zed `crates/project/src/lsp_store.rs`: push handler 897-927; doc-pull
  8547-8665; `pull_diagnostics_for_buffer` 8996-9125; background queue
  5234-5280; workspace loop 15317-15560; `apply_workspace_diagnostic_report`
  14382-14510; refresh handler 1164-1190; `pull_workspace_diagnostics[_once]`
  14278-14327; `pull_document_diagnostics_for_server[_for_buffer_edit]`
  14329-14379; result-id caches 14204-14277; disk-based 11644-11730,
  11987-12050, 13324-13400; constants 179-182; settings use 561-563.
- Zed `crates/project/src/lsp_command.rs`: `GetDocumentDiagnostics` 324+,
  `check_capabilities`/`to_lsp`/`response_from_lsp` 5383-5490,
  proto round-trip 5490-5575.
- Zed `crates/project/src/project_settings.rs`:
  `LspPullDiagnosticsSettings` 661-671, `InlineDiagnosticsSettings` 635-657.
- Zed `crates/editor/src/diagnostics.rs`: `pull_diagnostics` 542-584,
  `refresh_inline_diagnostics` 450-540, `update_diagnostics_state` 585-600.
- Zed `crates/editor/src/editor.rs`: pull trigger 11370, diagnostics-updated
  10226.
- Zed `crates/diagnostics/src/diagnostics.rs`: panel `refresh` 451+,
  summary 720+, refresh toggle 148/423+.
- Zed `crates/languages/src/rust.rs:311-315`: disk-based adapter example.
- LSP 3.17: `DiagnosticServerCapabilities` (`identifier`,
  `interFileDependencies`, `workspaceDiagnostics`), `DocumentDiagnosticParams`
  (`identifier`, `previousResultId`), `WorkspaceDiagnosticParams`
  (`previousResultIds`), `workspace/diagnostic/refresh` ("If a server closes a
  workspace diagnostic pull request the client should re-trigger" — quoted in
  Zed at `lsp_store.rs:15477-15479`).
- This repo: `packages/core/src/plugins/lsp/diagnostics.ts` (full file, 256
  lines), `diagnostic-decorations.ts` (180 lines),
  `docs/adr/0022-lsp-diagnostics-through-decorations.md` (54 lines).
