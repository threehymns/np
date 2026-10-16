# Project search engine sits behind a seam; desktop v1 first

Project search ships on desktop first; web gets its own design session later.
The v1 engine is a hand-rolled Zed-style TypeScript implementation
(persistent in-process, two-phase scan, streaming results) behind a
`SearchBackend` interface (query → streaming results), so it can be swapped
without touching UI.

This records two deliberate rejections. Ripgrep is not the v1 engine:
spawning it per keystroke pays process-spawn plus full re-walk every search,
which is what feels slow interactively — the matcher was never the problem.
`@ff-labs/fff-node` is rejected too: native-only, search-only (no replace),
main-process-only, nine platform packages to ship. John's
fsearch-crossplatform is the intended eventual engine, but its npm packaging
and missing Windows port are separate infrastructure projects that must not
block search v1 — hence the seam.
