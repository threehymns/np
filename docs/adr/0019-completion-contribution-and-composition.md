# Completion contribution and composition

Completion sources append to the active language's `data` facet in CodeMirror rather than using `autocompletion({ override })`. Overriding the chain would drop built-in note, table, and wikilink sources. Registering each source as an independent input preserves individual match ranges.

Option ranking uses negative score boosts rather than completion sections. Sections unconditionally promote ranked items ahead of unranked ones, which would push new sources above existing note sources. Score boosts position note sources first, snippets second, and buffer words lowest.

Only one `autocompletion()` instance exists per editor state to avoid configuration merge conflicts in CodeMirror. The host manages this instance in a dedicated compartment where global toggles and keymaps reconfigure it.

The trigger and the acceptance key are KeymapRegistry bindings, so a user keymap can rebind them: `Ctrl-Space` opens the popup and `Enter` accepts it, while in Vim insert mode `Ctrl-y` accepts and Enter stays the mode's. Both are scoped to a focused editor, so the window-level capture listener cannot open a popup over a sidebar, a modal, or a tooltip the user is not editing. Acceptance leaves the keystroke to the editor when no popup is open, so Enter still inserts a newline. The popup's selection keys stay in CodeMirror's keymap, which is the only pipeline that can scope them to the dialog's own state.

Snippets are contributed as plain data records in a host registry joined by language name, rather than as editor extensions.
