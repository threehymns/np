# Project search engine sits behind a seam; desktop v1 first

Project search ships on desktop first; web gets its own design session later.
The v1 engine is a hand-rolled Zed-style TypeScript implementation
(persistent in-process, two-phase scan, streaming results) behind a
`SearchBackend` interface (query → streaming results).

The seam is real, not hypothetical: the web backend is committed and must be
architecturally different — the File System Access API's per-file overhead
and lack of mmap rule out reusing the desktop engine, forcing a worker
pipeline with a warm OPFS index instead. One adapter today, a known-divergent
second adapter on the roadmap: that is what earns the seam.

This records two deliberate rejections. Ripgrep is not the v1 engine:
spawning it per keystroke pays process-spawn plus full re-walk every search,
which is what feels slow interactively — the matcher was never the problem.
`@ff-labs/fff-node` is rejected too: native-only, search-only (no replace),
main-process-only, nine platform packages to ship. A future
fsearch-crossplatform integration would also plug into the seam, but its npm
packaging and missing Windows port are separate infrastructure projects that
must not block search v1.
