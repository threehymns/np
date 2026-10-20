# Hover and resolve are the client's own requests

The client asks the server two things and declares both in `initialize`. A
hover is its own `textDocument/hover` request with no resolve phase, and a
resolve is a `completionItem/resolve` round trip that fills the part of a
completion item the first reply withheld. The client declares the four
properties the round trip fills and never `textEdit`, because resolving the
edit itself makes completion slow.

The popover is where the resolve happens. The option's `info` function is
where the round trip runs, because CodeMirror calls it when it renders the
option's documentation, which is as close to "the popover is showing this
option" as the API gets. An option whose server sent its documentation in the
first reply gets an `info` that renders the string it already has, with no
round trip. An option whose server withheld the documentation gets an `info`
that asks for it and returns the promise. Nothing else asks the server. A
resolve happens for the option the popover is showing, and for nothing else.

Requests stay bounded. The runtime keeps each reply and asks each item once,
so a later visit to the same option is a cache hit rather than a second round
trip. The cache holds two hundred replies and drops the oldest one, because a
server that puts the position into `data` makes almost every session a new
key. An item without opaque `data` is never asked at all, because there is no
key to send back.

## What the client declares

- `resolveSupport` covers `additionalTextEdits`, `command`, `detail` and
  `documentation`, and not `textEdit`. Only the edit's `newText` is
  re-derived, and the range is never taken from the reply.
- `documentationFormat` is markdown plus plaintext.
- The hover capability is markdown only, and it has no resolve phase.

## What gates each request

Both are per server, read out of each running server's own `initialize`
result. `resolveProvider` gates the resolve round trip and `hoverProvider`
gates the hover. A server that announced neither is not asked. A missing
capability is not an error. It is a server that does not offer the request.

## What lands when

The resolved `documentation` fills the popover's docs panel, and the resolved
`detail` fills it when there is no documentation. The reply's text becomes
what gets inserted: `textEdit.newText` when the server sends one, then
`insertText`, then the item's own text. The original range stays the anchor,
because a resolved range belongs to the revision the server answered for.

`additionalTextEdits` and `command` wait for confirm time. The edits land in a
second transaction and skip anything overlapping the primary insert, and they
are dropped outright if the document moved under a deferred resolve. The
command runs only when the server offers it in `executeCommandProvider`.

The runtime reuses a cached reply's edits rather than dropping them. The
item's own edits are the ones that came with the completion reply for this
document, so they win over a cached reply's, which were computed against an
earlier revision. An item that carries none takes the cached reply's edits,
because those are the only ones the server sent, and dropping them would lose
the server's instruction.

## The capability table is the client's

The client's capabilities are one table in `LspClient`, and a descriptor
cannot add to it. `ClientCapabilities` describes the client rather than the
server. What np implements is what np implements for every server it talks
to, so a second server is configuration rather than a code edit. A server that
needs something the client does not implement is a gap in the client, and it
is closed once for every server. This is the reason ADR 0020 gives for
keeping the table out of the descriptor.

## The hover tooltip covers the symbol's range

CodeMirror hides a point tooltip and shows it again on every inter-character
mouse move, and each showing costs a round trip, so hovering a symbol flickers
across the word. When the server names the symbol's range, the tooltip spans
that range and CodeMirror keeps it while the mouse stays inside. A server that
names no range gets a point tooltip, and the flicker comes back.

## What is asserted, and where

- `client.test.ts`: the four advertised properties with `textEdit` absent,
  markdown plus plaintext documentation, and markdown-only hover.
- `hover.test.ts` and `completions.test.ts`: hover flattening with the fenced
  code kept, a null hover, the resolve data kept, documentation and detail
  merged as soon as the reply arrives with the original ranges kept as
  anchors, and the extras kept for confirm.
- `hover-resolve.test.ts`: the serving, null, inactive and unavailable hover
  outcomes, then the resolve fill, the once-only rule, the cached reply's
  edits and the failure gating, against the stubbed `lazy-docs`, `no-hover`,
  `fail-hover` and `fail-resolve` modes.
- `lsp-hover-resolve.test.ts` in the UI: the tooltip contents, nothing
  elsewhere, and the lazy `info` fills the panel without moving the ranking.
- `lifecycle.test.ts`: the handshake now carries the four-property support
  and the markdown hover.
- `lsp-completions.test.ts` and `completion-composition.test.ts` stay green
  unchanged, so the fallback and the ranking are untouched.
