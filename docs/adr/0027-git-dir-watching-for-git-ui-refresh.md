# ADR 0027: Watch `.git` for git UI refresh instead of polling

*   **Status:** Accepted
*   **Decider:** threehymns
*   **Date:** 2026-10-16

## Context

np's git UI must stay trustworthy when commits happen outside the app — the CLI is a first-class way to commit. Git offers no push notifications, but every commit rewrites `.git/refs/heads/<branch>`, branch switches rewrite `.git/HEAD`, and gc rewrites `.git/packed-refs`.

## Decision

The git plugin subscribes to those `.git` paths through the shared `@parcel/watcher` backend (the same backend as the desktop worktree watcher), debounced, and refetches git state on change. No polling anywhere in the git UI.

## Considered Options

*   **Polling on an interval:** rejected outright — an explicit user requirement is event-driven refresh with no polling.
*   **Refetch on tab switch / after in-app commits only:** rejected — leaves views stale for CLI commits, which is the actual use case driving this.

## Consequences

*   The git plugin depends on the watcher backend's lifecycle; the watcher module owns `@parcel/watcher` start/stop/dispose and exposes a small subscribe interface.
*   The real git dir must be resolved first (`git rev-parse --git-dir`): in a linked worktree `.git` is a file pointing elsewhere, so watching `<root>/.git/refs` would watch the wrong directory.
*   `packed-refs` churn on gc and `index` writes on staging also fire the watcher; debouncing keeps refetches cheap and correct.
