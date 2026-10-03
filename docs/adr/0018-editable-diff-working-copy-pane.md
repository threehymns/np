# Editable Working-copy pane in Diff Viewer

The Diff Viewer showed detached snapshots, so making it editable forked a choice: mirror edits into the shared file Document or write snapshots straight to disk. We bind the Working-copy pane to the shared Document for its filepath (keystrokes are ordinary unsaved Document edits; save routes through the normal file-save path) and resolve Hunk Actions against current Document content with range clamping, no-op on non-matching hunks, and optimistic index writes with rollback — because a second write path would stale the open tab, bypass dirty-tracking and branch-switch guards, and misapply hunks shifted by unsaved edits.

## Considered Options

- Snapshot pane with direct disk writes on edit: rejected — bypasses the Document's dirty tracking, safety checks, and single save path.
- Disabling Hunk Actions while dirty: rejected — forces a save-first round trip in the middle of review for no safety gain once the splice base is current text.

## Consequences

- Refresh and branch-switch handling re-diff around in-memory edits instead of overwriting them; typing never moves the index.
