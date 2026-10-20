# Watch the git directory for git UI refresh instead of polling

np's git UI has to stay trustworthy when commits happen outside the app, because the CLI is a
first-class way to commit. Git offers no push notifications, but every commit rewrites
`.git/refs/heads/<branch>`, a branch switch rewrites `.git/HEAD`, and gc rewrites
`.git/packed-refs`.

The git plugin subscribes to those paths through the shared `@parcel/watcher` backend, the same
one the desktop worktree watcher uses, debounces the events, and refetches the git state the
History tab shows on change. There is no polling anywhere in the git UI.

Polling on an interval is rejected outright, because an explicit user requirement is
event-driven refresh with no polling. Refetching on a tab switch or after an in-app commit is
rejected too, because it leaves the views stale for the CLI commits that drive the requirement.

## Consequences

- The git plugin depends on the watcher backend's lifecycle. The watcher module owns
  `@parcel/watcher` start, stop, and dispose, and exposes a small subscribe interface.
- The real git directory is resolved first, with `git rev-parse --git-dir`. In a linked worktree
  `.git` is a file pointing elsewhere, so watching `<root>/.git/refs` would watch the wrong
  directory.
- A linked worktree keeps its branch refs in the common directory rather than in the
  per-worktree directory, so `git rev-parse --git-common-dir` is resolved as well and both
  directories are subscribed to when they differ.
- Remote-tracking refs are watched too. A push or a fetch only moves `refs/remotes/*`, so
  without them the unpushed indicator would stay wrong after a terminal push.
- `packed-refs` churn on gc and `index` writes on staging also fire the watcher. Debouncing
  keeps the refetches cheap, and the filter drops the events that cannot change the history.
