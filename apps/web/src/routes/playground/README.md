# Git Diff Playground (PROTOTYPE branch — not shipped)

> This route is part of `prototype/diff-reconfigure-harness` and is **not** part of PR #19. See that branch for context.

Manually exercises `DiffViewer`'s compartment reconfiguration path: editable HEAD/worktree content, a "Recreate objects" action that simulates a `repository.refresh()` replacing the `changes` array, and a Reset action. Scenes live in `apps/web/src/lib/git-playground.ts`.

**Standalone** — it never touches a real repository.