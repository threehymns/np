# Atomic branch switch with carry-forward

We chose to make `switchBranch` on the VCS adapter an atomic operation that internally handles preserving uncommitted changes (both staged and unstaged), rather than splitting it into a separate pre-flight safety check (`canCheckoutBranch`) followed by a destructive checkout.

The adapter snapshots dirty files (working tree content + index state) before checkout, then restores them after, blocking only on genuine conflicts (a file modified locally that also differs between branches). This carry-forward approach approximates native Git's behavior. In the native/Electron adapter, `git checkout` does this natively; in the browser adapter (isomorphic-git), it's implemented manually because `isomorphic-git`'s checkout unconditionally overwrites the working tree and index.

The operation returns a discriminated union (`switched | noop | blocked | error`) instead of a boolean, so callers get structured information about why a switch failed without needing a separate query. The `blocked` state carries a reason (`conflict` for branch-vs-worktree collisions, `worktree` for untracked collisions, or `unreadable` when file read permissions prevent a safe snapshot) and the list of affected files.

## Considered Options

- **Separate pre-flight + execute**: `canCheckoutBranch()` followed by `switchBranch()`. Rejected because it creates a TOCTOU race and forces callers to orchestrate two calls.
- **Block when dirty**: Refuse any checkout when uncommitted changes exist. Rejected because it degrades the UX — native Git and editors like Zed carry changes forward seamlessly.
- **Full stash-and-restore**: `git stash && git checkout && git stash pop`. Rejected because isomorphic-git has no stash support, and even with native Git, stash pop can produce merge conflicts that are hard to surface in a non-terminal UI.
