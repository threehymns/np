# Workspace pane split layout

The workspace layout is structured as a tree of panes and axes. A pane holds a tab list, an axis arranges child panes along a horizontal or vertical direction, and the root starts as a single pane until split.

Document sessions are decoupled from editor views. Multiple panes can host tabs viewing the same document session. Document content, dirty status, and save lifecycles reside in the shared session, while cursors, selections, and scroll positions remain view-local. Closing a cloned view does not prompt to save or discard until the final remaining tab referencing the session closes.

Panes close automatically when their last tab closes, collapsing the surrounding tree while leaving at least one empty pane. Directional pane focus navigation uses screen coordinate hit-testing from the active pane's boundary, avoiding tree-traversal edge cases in deeply nested layouts.

Only the actively focused editor binds global keymap contexts and focus-dependent state like Vim modes. Unfocused panes keep document text and decorations synchronized without overwriting global keyboard contexts.
