# The Worktree snapshot is the whole project file set

The `Worktree` snapshot (ADR 0025) always holds every file in the project,
whatever triggered the scan. The file explorer's expanded-versus-collapsed
state is display only: the tree filters the snapshot for display and never
narrows what the snapshot contains.

The alternative, every scan caller passing the same options, puts the
contract in each caller's hands. A watcher's rescan then publishes fewer
files than the tree's scan, and project search, which reads only the
snapshot, silently stops finding nested files. One canonical snapshot shape
keeps the tree and the search results in agreement no matter who rescanned.

So a scan always walks the whole project, and the expansion state a scan
carries only marks the published nodes as expanded. A scan that carries no
expansion state reuses the last one the file explorer handed over, so a
watcher's rescan keeps the display state the tree already had.
