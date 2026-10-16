# Worktree owns the file snapshot

Today `tree.svelte.ts` (the file explorer model) scans directories and pushes
entries into the passive `Worktree` holder. We invert this: `Worktree`
maintains the live file snapshot (scanner + watcher live here) and the tree
UI subscribes to it. Project search reads the same snapshot instead of
scanning independently.

The inversion is surprising given the current code, which is exactly why it's
recorded: a future reader seeing the tree subscribe to `Worktree` instead of
feeding it will wonder why. The alternative — each consumer scanning and
watching on its own — duplicates the most expensive work in the app once
search exists.
