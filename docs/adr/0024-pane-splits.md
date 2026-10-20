# The workspace layout is a tree of panes and axes

A workspace that shows one tab strip cannot show two documents side by side,
so the layout becomes a tree: a pane holds tabs, an axis holds two or more
children along one direction, and the root is a pane until the first split.
The pane is what the user reads, and the tree is what makes a second pane
possible.

## What a split does

A split puts a new pane next to the pane being split, or nests a new axis
when the direction is orthogonal to the one that pane already sits in. The
new pane takes the focus. There are three ways to fill it: empty, so it
shows the empty state; move, so the tab the user was on moves into it; and
clone, so the new pane opens a second tab onto the same document. A diff
tab and the language server logs veto cloning, because neither is a view
onto a document session; every other tab allows it, and a vetoed clone
falls back to an empty pane.

## One document, many views

A document session may back tabs in more than one pane. Each pane holds its
own editor view, so the cursor, the selection and the scroll position are
per view, while the content, the dirty state and the save lifecycle stay
per session. The save-or-discard prompt fires only when the last tab
referencing a session closes, so closing a cloned tab while the session
lives on elsewhere closes silently.

## Panes die with their last tab

A pane whose last tab closes is removed, and the tree collapses around it,
with the focus falling back to a neighbouring pane. There is no close-pane
command: the last pane is guarded and survives as an empty pane.

Focus moves by geometric hit-testing rather than by walking the tree. Take
the active pane's rectangle, step one pixel past the requested edge, and
hit-test that point against the panes on screen. That stays right under any
nesting, which tree-walking does not.

## The focused editor owns the focus-sensitive state

A pane that does not have focus still holds a live view of its document: it
keeps its content, its language and its completions in sync, so a cloned
view shows the edits made in the pane the user is typing in. What it does
not own is the state that follows the focus: word wrap, vim mode, and the
keymap contexts. The keymap contexts are global, one set for the whole
application, so exactly one editor may hold them, and it is the editor in
the focused pane. A second owner would clear them when it let go and take
the focused editor's keybindings with it.

## The keyboard follows the pane

Moving the focus between panes hands the keyboard to the editor that ends
up active, so the user keeps typing where they are looking. The keyboard
follows only when the move came from an editor: a command run from the
palette or from a toolbar leaves the focus where it is, because those
still hold the keyboard the user is typing into.

## What a pane looks like

A pane renders its own tab bar. The active pane's bar is drawn at full
opacity and the other panes' bars are dimmed, so the focus is visible
without a border or an accent. A pane with no tabs renders the shared
empty state rather than a blank editor.

## Keys

Split and focus are commands in the keymap registry like any other, so they
are remappable. The ``cmd+k`` chord is the way in: an arrow after it splits
in that direction, and ``cmd`` and an arrow after it moves the focus. There
is no separate one-key split, because ``cmd+\`` already toggles the sidebar
and the two would be the same chord on Linux and Windows, where ``cmd`` is
``ctrl``.

## Persistence

The persisted open files are version-keyed. A record whose version is not
the current one is discarded and the workspace starts fresh and empty,
because there is no migration code and a shape the workspace cannot read
is worse than an empty workspace. State written before the versioning
existed was a bare array; it is read as the current version, so it loads as
it always did and never counts as a mismatch.

## Out of scope

Drag-and-drop splits, pane zoom, moving a tab between panes, persisting the
layout across restarts, and draggable dividers. The model carries a
relative weight per child, so resizing is a UI addition later rather than a
change to the model.
