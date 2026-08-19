# VCS Contract Test Merge Gate & Pre-Merge Confidence Check

This document defines the pre-merge confidence check and merge gate for Version Control System (VCS) operations in `np`.

## References

- **ADR 0004**: [`docs/adr/0004-contract-tests-with-real-git.md`](./adr/0004-contract-tests-with-real-git.md)
- **Parent Spec**: GitHub Issue [#39](https://github.com/threehymns/np/issues/39) ("Spec: contract test suite for VCS operations with real git engines")
- **Domain Language**: [`CONTEXT.md`](../CONTEXT.md)

---

## 1. The Merge Gate Principle

Core VCS operations (branch switching with carry-forward, staging/unstaging, discard operations, hunk-level index edits, and diff generation) are destructive and safety-critical.

Per **ADR 0004**, any branch modifying or extending VCS behavior must pass the full contract test suite against **both** real git engines before merging:

1. **`SpawnGitAdapter`** — System git spawned via process runner (desktop engine). Requires Git >= 2.23.
2. **`IsomorphicGitAdapter`** — Pure JavaScript `isomorphic-git` over filesystem handles (browser/web engine).

A passing contract suite is the checkable fact that core VCS operations are solid.

---

## 2. Running the Pre-Merge Confidence Check

Run the full test suite from the repository root:

```bash
bun test
```

To run only the VCS contract suite:

```bash
bun test tests/contract/
```

### Passing Criteria
- **Zero Failures**: All contract tests across both adapters pass.
- **Zero Unexpected Skips**: Only the explicit version-floor guard (`skip guard self-check (impossible floor 99.0)`) skips. If the local system git is below 2.23, `bun test` reports a clear version floor skip message.
- **Typecheck Clean**: `bun run check` exits with code 0.

---

## 3. Surface Coverage Map

The contract suite in [`tests/contract/`](../tests/contract) exercises the entire `VCSAdapter` surface:

| Area | Contract Test File | Key Behaviors Verified |
| :--- | :--- | :--- |
| **Change & Diff Reads** | [`change-diff-reads.test.ts`](../tests/contract/change-diff-reads.test.ts) | Untracked, tracked, deleted, modified, renamed, copied, mixed staging states, diff reconstruction on both engines |
| **Metadata Reads** | [`metadata-reads.test.ts`](../tests/contract/metadata-reads.test.ts) | `getCurrentBranch`, `getBranches`, `getCommits` (author, date, message, file lists, pagination, empty commits), `getUserConfig` |
| **Staging & Unstaging** | [`stage-unstage.test.ts`](../tests/contract/stage-unstage.test.ts) | `stageFile`, `unstageFile`, `stageAll`, `unstageAll`, `updateIndexContent` for additions, deletions, renames, mode preservation |
| **Discard Operations** | [`discard-operations.test.ts`](../tests/contract/discard-operations.test.ts) | `discardChanges` (staged, unstaged, mixed), `discardAll`, preserving edits at destination for RM/CM renames and copies |
| **Branch Switching** | [`branch-switch.test.ts`](../tests/contract/branch-switch.test.ts) | `switchBranch` with atomic carry-forward: clean switch, dirty switch without conflict, dirty switch with collision (blocked), non-existent branch, dryRun |
| **Commit & Branch Creation** | [`commit-branch-creation.test.ts`](../tests/contract/commit-branch-creation.test.ts) | `commit` with custom author, amend, dirty/clean trees, `createBranch` and checkout verification |
| **Hunk Action Composition (Layer 3)** | [`packages/core/src/hunk-actions.test.ts`](../packages/core/src/hunk-actions.test.ts) | Real diff -> hunk range -> splice -> index/worktree write pipeline, single/multi-hunk staging, unstaging, discarding |
| **Runner & Harness** | [`harness.test.ts`](../tests/contract/harness.test.ts) | Hermetic temp repo isolation, synthetic git identity (`GIT_CONFIG_NOSYSTEM=1`), version floor guard |

---

## 4. Test Style Policy (ADR 0004)

- **Contract Tests (`tests/contract/`)**: Assert semantic outcomes (contents, status, branch, index hashes) against real throwaway git repositories. Do not assert exact command strings.
- **Mock Tests (`*.test.ts`)**: Kept **only** for:
  1. Error paths real git cannot easily or reliably trigger (corrupt index file SHA1 signatures, EACCES permission denied, file locks).
  2. Exact CLI argument and performance pinning (e.g. verifying bulk numstat calls rather than N per-file diff invocations, single `-uall` flags).
- **No Competing Sources of Truth**: When a contract test covers a happy path or edge scenario with a real git engine, any synthetic mock simulating that porcelain output must be pruned.

---

## 5. Bug Policy

Failing contract tests discovered during test suite construction or engine verification are treated as **evidence of implementation bugs**, not test defects.
- Either fix the underlying adapter implementation to satisfy git semantics.
- Or file a tracking bug with the failing contract test left red on purpose — never silently delete failing contract tests.
