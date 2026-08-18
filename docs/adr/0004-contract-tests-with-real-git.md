# Contract tests with real git for VCS operations

The VCS layer ships two adapters over `VCSAdapter` — `SpawnGitAdapter` (system git via IPC) and `IsomorphicGitAdapter` (isomorphic-git) — and the destructive operations (discard, hunk indexing, branch switching) are the most bug-prone code in the repo. The existing tests mock the git boundary (hand-written porcelain strings, fake handles), which lets mutually-consistent bugs between fake output and parser pass, and cannot validate real index state. We decided to gate the `feat/vcs-git-panel` merge on a **contract test suite** that runs both adapters against real engines in throwaway repositories (`tests/contract/`), asserting semantic outcomes (contents, status, branch) including the safety paths where destruction must *not* happen.

The suite uses real `git` (floor 2.23, `skipIf` guard below it) and real isomorphic-git over Node `fs` in temp dirs with `GIT_CONFIG_NOSYSTEM` and env-based identity. A failing test under this suite is treated as evidence of a pre-existing implementation bug (fix the implementation or file the test red with a bug) rather than a test defect. Mock tests superseded by contract coverage are pruned; mocks remain only for error paths real git cannot produce (corrupt index, EACCES, missing pathspec) and exact CLI argument pinning. To make room, Playwright moved to `tests/e2e/` with bun's `pathIgnorePatterns` narrowed to that subtree. `SpawnGitAdapter` gains an injectable `gitRunner` (defaulting to the IPC global) as the test seam.

## Considered Options

- **Keep the mocked boundary only**: rejected — fake outputs can drift from real git semantics (the rename/copy/porcelain bug classes) and destructive outcomes are unverifiable.
- **Pin git via Docker**: rejected — a documented floor with `skipIf` is enough; an exact pin fights local dev and adds CI machinery that doesn't exist yet.
- **Share `tests/` with both runners unchanged**: rejected — bun ignores `tests/**` and Playwright's `testDir` is that directory; contract tests there would need both configs altered. Playwright to `tests/e2e/` instead.

## Consequences

- Mock assertions will be deleted as contract coverage lands; this ADR explains the two test styles, so future readers don't "fix" the remaining mocks back into place.
- Red tests during suite construction are expected and are deliverables.
- CI, the Windows matrix, and a follow-up swap of `updateIndexContent` from `hash-object`/`update-index --cacheinfo` to `git apply --cached` are separate tickets, not blocked by this decision.