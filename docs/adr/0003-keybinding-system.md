# Keybinding system architecture

The editor routes all keyboard events through a global keydown pipeline in `@np/core` before events reach DOM elements or CodeMirror. This unified interception enables multi-stroke chords (such as `cmd+k m` or `space f n`) and routes Vim leader keys through the application keymap rather than internal editor state.

Keybinding definitions pair context expressions with key-to-command mappings. A Pratt parser evaluates context predicates against active editor states (such as `editor && vim_mode == normal`), supporting boolean operators, equality comparisons, and grouping. The registry evaluates bindings in declaration order with last-match-wins precedence, allowing user configurations to override system defaults.

A reactive key buffer tracks in-progress chords. When a chord begins, the `KeymapRegistry` matches valid continuations and supplies command labels to render the WhichKey guidance overlay. Keybindings persist to `keymap.json` through Electron IPC on desktop and `localStorage` in web environments.
