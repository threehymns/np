# Hover presentation and `completionItem/resolve` (amends ADR 0021)

Spec #280, decided in #295 (hover plus resolve ships first as one slice),
#292 (Zed resolve/hover contract) and #294 (capability table stays
client-owned).

## What this slice does

Hovering a symbol the server recognises shows its type, signature and
documentation in the editor, through a new `textDocument/hover` round trip.
The same Markdown pipeline serves completion docs: vtsls withholds JSDoc until
asked, so the popover's `info` hook asks for it via `completionItem/resolve`.
A symbol the server does not report hovers to nothing rather than to an error,
and diagnostics, completions and note hovers keep their current behaviour.

## The contract (from #292)

- Client advertises `resolveSupport` for `additionalTextEdits`, `command`,
  `detail`, `documentation` — never `textEdit` — with docs formats
  markdown plus plaintext; hover advertises markdown-only with no resolve phase.
- Gated per server on `resolveProvider` (hover on `hoverProvider`), read out
  of each running server's own `initialize` result.
- Visible window plus-minus four with once-only semantics; `documentation` and
  `detail` land in labels immediately, `additionalTextEdits` and `command`
  defer to confirm time (edits in a separate transaction with overlap-skip,
  command gated on `executeCommandProvider`).
- Hover shares only fan-out shape, capability matching and Markdown plumbing
  with resolve; it is a separate request.

## What stays where (#294, ADR 0020)

The capability table stays client-owned in `LspClient`: descriptors stay pure
data (command, args, markers, languages, languageIds, bundled). This slice
flips the table from ADR 0021's declared absence (`resolveProvider: false`
in spirit, no `resolveSupport`) to the four-property advertisement above,
because it implements the round trip. Live trigger honoring stays its own
follow-up (#297), which amends ADR 0021's absent-characters clause.

## What is asserted, and where

- `client.test.ts`: the four properties (never `textEdit`), markdown plus
  plaintext docs, markdown-only hover.
- `hover.test.ts` / `completions.test.ts`: hover flattening with fenced code
  kept, null hovers to nothing; resolve data kept, docs/detail merged
  immediately with ranges kept as anchors, extras kept for confirm.
- `hover-resolve.test.ts`: hover serving/null/inactive/unavailable and resolve
  fill/once-only/window/failure-gating against the stubbed `lazy-docs`,
  `no-hover`, `fail-hover` and `fail-resolve` modes.
- `lsp-hover-resolve.test.ts` (UI): tooltip contents, null elsewhere, lazy
  `info` filling without moving ranking.
- `lifecycle.test.ts`: the handshake now carries the four-property support
  and markdown hover.
- `lsp-completions.test.ts` and `completion-composition.test.ts` stay green
  unchanged: fallback and ranking are untouched.
