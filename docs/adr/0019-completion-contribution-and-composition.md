# Completion contribution and composition

Completion sources append to the active language's `data` facet in CodeMirror rather than using `autocompletion({ override })`. Overriding the chain would drop built-in note, table, and wikilink sources. Registering each source as an independent input preserves individual match ranges.

Option ranking uses negative score boosts rather than completion sections. Sections unconditionally promote ranked items ahead of unranked ones, which would push new sources above existing note sources. Score boosts position note sources first, snippets second, and buffer words lowest.

Only one `autocompletion()` instance exists per editor state to avoid configuration merge conflicts in CodeMirror. The host manages this instance in a dedicated compartment where global toggles and keymaps reconfigure it. In Vim insert mode, Enter remains unbound from completion acceptance to prevent accidental accepts, and `Ctrl-y` accepts the active completion.

Snippets are contributed as plain data records in a host registry joined by language name, rather than as editor extensions.
