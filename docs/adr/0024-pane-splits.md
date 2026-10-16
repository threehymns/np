# ADR 0024: Pane Splits

*   **Status:** Accepted
*   **Decider:** threehymns
*   **Date:** 2026-10-15

## Context and Problem Statement

The editor is a single pane: one `Workspace` holds a flat `tabs` array and one
`activeTabId`. Users cannot view two documents side by side, or two views of
the same document. This ADR introduces panes and splits.

## Glossary

*   **Pane:** a tab container. Holds an ordered list of tabs, one of which is
    active, and renders its own tab bar. The unit the user splits and focuses.
*   **Split:** the action of dividing one pane into two, side by side
    (horizontal axis) or stacked (vertical axis).
*   **Axis:** an interior layout node holding two or more panes (or nested
    axes) along one direction, with a relative flex weight per child.
*   **Split tree:** the layout model. A node is either a pane or an axis;
    the workspace root is a single pane until the first split.
*   **Document session:** the open-document model (`DocumentSession`). One
    session may now back tabs in multiple panes; each pane holds its own
    editor view onto the shared session.
*   **Tab:** a view onto a document session (or diff view) inside one pane.
    Closing a tab never destroys its session while another tab still
    references it.
*   **Empty pane:** a pane with zero tabs. Renders the shared `Empty`
    component, not a blank editor.

## Decision

### Layout model: tree of axes

The split tree replaces the flat `tabs` array. Splitting inserts adjacent in
a matching axis or nests a new axis; removing a pane collapses single-child
axes. The root is never removed: the workspace always has at least one pane.
Sizes are relative flex weights; v1 splits are fixed 50/50, so the flex field
exists in the model but no resize UI ships yet.

### Split modes

Three modes, all shipping in v1:

*   **Empty:** the new pane starts with zero tabs and shows the `Empty`
    component.
*   **Move:** the active tab moves into the new pane.
*   **Clone:** the new pane opens a second tab onto the same document
    session. The diff viewer and LSP logs tabs veto cloning (per-tab
    `canSplit`); every other tab type allows it.

The new pane always takes focus after a split.

### Shared sessions, per-pane views

One `DocumentSession` may back tabs in several panes. Each pane owns its
editor view (cursor, scroll, and selection are per-view; content, dirty
state, and save lifecycle are per-session). The save/discard prompt fires
only when the last tab referencing a session closes — closing a cloned tab
while the session lives on elsewhere closes silently.

### Pane lifecycle

Implicit death: a pane whose last tab closes is removed and the tree
collapses, with focus falling back to a neighbor. There is no close-pane
command. The last pane is guarded and survives as an empty pane.

### Focus navigation

Directional focus commands (`pane.focusLeft` / `Right` / `Up` / `Down`)
resolve via geometric hit-testing from day one: take the active pane's
bounding rect, step one pixel past the requested edge, and hit-test against
known pane rects. This stays correct under arbitrary nesting, unlike
tree-walking.

### Keybindings

Split and focus commands are registered in the keymap registry like any
other command, so they are remappable:

*   `cmd-\` / `ctrl-\`: split right
*   `cmd-k` then arrow: split in that direction
*   `cmd-k cmd-arrow`: move focus between panes

### Active pane indication

The active pane's tab bar renders at full opacity; inactive panes' tab bars
are dimmed. No borders or accent chrome.

## Out of scope for v1

Drag-and-drop splits, pane zoom, move-item-between-panes, layout
persistence across restarts, and draggable dividers. The model carries flex
weights so resizing is a pure UI addition later.

## Persistence migration

There is no migration path for pre-split persisted workspace state. The
persisted state is version-keyed; on a version mismatch the workspace starts
fresh (empty) instead of attempting to read the old shape. This keeps a stale
tab strip from blocking new tabs without requiring the user to clear state
manually, and avoids carrying migration code as tech debt.

## Consequences

*   `Workspace.tabs` / `activeTabId` migrate into the root pane; every
    existing call site that assumes a single tab strip must go through the
    active pane.
*   `DocumentSession` gains multi-view attachment; anything that assumes one
    view per session (scroll restore, cursor tracking) must become per-tab.
*   The tab bar component becomes per-pane; the workspace renders the split
    tree instead of one strip.
