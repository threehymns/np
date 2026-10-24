# LSP hover and completion item resolve

The language client issues hover and completion item resolve requests on demand based on server capabilities declared in `initialize`. Hover requests (`textDocument/hover`) execute without a resolve phase, while completion item resolution (`completionItem/resolve`) fetches deferred documentation and details for items already returned.

Completion item resolution runs lazily inside CodeMirror's `info` renderer only when the popover displays an item. The runtime caches up to 200 resolved items using an LRU strategy to prevent repeated requests during list navigation. Items without opaque `data` payloads skip resolution.

When a hover reply includes a symbol range, the client spans the tooltip across the range so mouse movement within the symbol does not re-trigger hover round-trips or flicker. Additional text edits returned during completion resolution apply at confirmation time in a separate transaction, discarding conflicting edits if the document changed during resolution.
