# Word fallback completion

Completion queries resolve to one of three outcomes: `inactive` (no server claimed the language or LSP is off), `serving` (the server answered), or `unavailable` (the server failed, timed out, or refused to start). Keeping `inactive` distinct from `unavailable` ensures unserved files like Markdown notes receive word completions immediately without degradation warnings.

In `'fallback'` mode, buffer words supply completions only when the language server query finishes as `unavailable`. The buffer-word source evaluates this condition per query after the server source settles, avoiding static configuration guesses.

When `editor.lsp_fetch_timeout_ms` defaults to `0`, the client applies an internal timeout instead of waiting forever. This prevents a frozen server from permanently blocking the word fallback. Explicit non-zero user settings take precedence over the internal default.

Server completion items share the note tier boost of `0`, ordering suggestions against note items by label match quality. Snippets and buffer words rank below both. Resolved completion edit ranges are clamped to current document length at application time to prevent crashes on outdated revisions.
