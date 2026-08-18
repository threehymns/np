# PRD: Platform Abstraction Refactor (Storage, VCS, Persistence)

## Problem Statement

"np" is a Svelte 5 text editor that currently runs only as a web app using the browser's File System Access API and `isomorphic-git` for version control. The user wants to eventually ship an Electron version that uses native Node.js `fs` and native `git`, and wants to preserve the authentic "no data loss" branch-switching experience today's native editors provide (where locally-modified files are carried forward when you switch branches, rather than silently overwritten).

Right now every layer from storage down to VCS is hardwired to browser-specific types:

- `FileOrigin` is `{ handle: FileSystemFileHandle, name }` — no Electron path can satisfy this.
- The `Storage` interface returns and accepts `FileSystemDirectoryHandle` in its method signatures.
- `workspace.svelte.ts` calls `.git` detection via `rootHandle.getDirectoryHandle('.git')` and permission checks via `rootHandle.queryPermission(...)` — all of which are browser-only APIs.
- `isomorphic-git`'s `checkout()` unconditionally overwrites the working directory, destroying any staged or unstaged changes on branch switch.
- `persistence.ts` stores raw `FileSystemHandle` objects directly in IndexedDB and would need an entirely different mechanism for Electron.

The result: a platform lock-in that makes an Electron port a rewrite rather than a configuration change, and a branch-switching experience that degrades as soon as the user actually edits files.

---

## Solution

A layered, platform-dual architecture where **every system boundary sits on an abstract interface**, not a concrete browser API:

1. **Storage** becomes a path-based URI scheme (`file:///`, `browser://`, `git://` …) routed by a `MultiSchemeStorage` coordinator. The `BrowserStorage` adapter translates URIs to `FileSystemHandle` operations internally.
2. **`FileOrigin`** becomes a serializable URI-like record `{ scheme, path, name }`. Any (de)serializer works, any platform can construct one.
3. **Persistence** (`SessionPersistence`) saves and restores workspace state as plain URIs — IndexedDB on web, a local JSON file on Electron.
4. **VCS** (`VCSAdapter`) grows a `detect(rootPath)` method (replacing workspace-level `.git` probing) and its `switchBranch` becomes atomic, returning a discriminated union instead of a boolean. The browser adapter implements carry-forward (snapshot dirty files, checkout, restore). The native adapter uses the system `git` CLI (via `simple-git`) and receives standard carry-forward behavior for free.
5. **Permissions** move to the Storage Provider layer — `ElectronStorage` always returns `'granted'`; `BrowserStorage` queries the W3C `navigator.storage` permission API.

The current codebase requires roughly these structural moves (granular sequencing below in User Stories / Implementation Decisions). The eventual monorepo split (`@np/core`, `@np/vcs-browser`, `@np/vcs-electron`, `@np/storage-browser`, `@np/storage-electron`) is made economical by the adapter isolation done now — but the monorepo split itself is explicitly out-of-scope for this PRD.

---

## User Stories

1. As a **browser user who has edited a file**, I want `isomorphic-git` to carry my working tree and staged changes to the new branch when I switch branches (matching `git checkout` on the command line), so that I don't lose work.
2. As a **browser user switching branches**, I want the editor to block the switch and show a conflicting-file list only when a file I have modified also differs between branches — not just when the tree is dirty.
3. As an **Electron user who will eventually use native `git`**, I want the branch-switch interface to be identical to what the browser sees, so that native Git's built-in carry-forward behavior works without an extra adapter.
4. As a **power user with multiple storage backends**, I want the workspace to keep read-only `git://` history previews and `untitled://` scratchpads open alongside my `file://` or `browser://` workspace, so I never lose a context view while navigating.
5. As a **developer extending the editor**, I want `StorageProvider` to be a registerable, URI-scheme-keyed component, so that adding a new backend (SSH, cloud storage, virtual filesystem) requires implementing one interface and registering once rather than touching workspace logic.
6. As a **user restoring a session across app restarts**, I want the workspace to re-open the exact same Documents with the same active tab — without depending on browser `FileSystemHandle` serialization — whether I'm on web or Electron.
7. As a **user whose root directory changes to a folder the OS does not belong to them**, I want the permission UI to reflect the actual provider state rather than throwing a browser-specific error.
8. As a **browser user on a private tab or with cleared permissions**, I want a re-grant flow that restores access without losing unsaved document state.
9. As an **Electron user whose entire app folder is writable**, I want permission checks to always short-circuit to `'granted'` without hitting the filesystem unnecessarily.
10. As a **developer writing unit tests**, I want `SessionPersistence` and `StorageProvider` to be interface-shaped concerns with no browser globals in their implementation, so they can be tested in pure Node without Playwright.
11. As a **developer writing VCS adapter tests**, I want to swap in a mock `VCSAdapter` that records calls to `detect`, `getStatus`, and `switchBranch` without touching the filesystem, so that workspace branch-switch logic is testable in isolation.
12. As a **user who accidentally opened a branch with local changes**, I want the switch to happen cleanly without accidentally clearing their working tree — the current "silent destroy" behaviour is a data-loss risk.
13. As a **developer building a future mobile or sandboxed renderer**, I want the permission model to be pluggable at the Storage Provider level so that a sandboxed backend can prompt for OAuth or scoped-access tokens without the editor needing to know about OAuth.
14. As a **user who re-opens the editor after a crash**, I want their workspace (open files, active tab, recent folders, root) to persist and rehydrate through the same path-based format that the Electron adapter will use, so that their session is not lost when they switch platforms.
15. As a **developer reasoning about complex Git operations**, I want the `VCSAdapter.verb switchBranch` return type to carry rich, typed information about why a switch succeeded or failed, so that UI state machines (e.g. a branch-safety modal recheck cycle) don't need catch-all error lumping.

---

## Implementation Decisions

### Storage: Path-based URI scheme routing over handle-based signatures

The `Storage` interface is refactored to use plain URI-based `FileOrigin` records (`{ scheme, path, name }`) instead of leaking `FileSystemFileHandle` / `FileSystemDirectoryHandle` in type signatures. The browser handler for `BrowserStorage` maintains an internal handle-to-URI registry; callers never touch handles.

The return type for `pickDirectory` changes from `FileSystemDirectoryHandle | null` to `FileOrigin | null`, identifying the workspace root by URI path as soon as the user selects it.

### Storage: `MultiSchemeStorage` coordinator as the default concrete Storage

`MultiSchemeStorage` implements `Storage`, holds a register of `StorageProvider` keyed by URI scheme, and dispatches every method call to the matching provider. The `BrowserStorage` adapter is the first registered provider. The coordinator is the value that `AppState.storage` holds at construction time.

Any document whose `origin.scheme` is `"git"` is routed to a `GitStorage` provider without any special-case code in `DocumentSession.loadContent()`.

### Storage: `FileOrigin` as a serializable URI-like record

`FileOrigin` becomes `{ scheme: string, path: string, name: string }`. The `path` field is a forward-slash-separated relative path for `browser://` and a POSIX-style absolute path for `file://` or future remote schemes. The record has no methods: it serialises and deserialises without ceremony, so it can be stored in IndexedDB, Electron IPC serialisation, or a JSON file without any wrapper needed.

### Workspace root and ProjectTree are path-based

`workspace.svelte.ts` replaces `rootHandle: FileSystemDirectoryHandle | null` with `rootOrigin: FileOrigin | null`. `ProjectTree.TreeNode` and `VisualNode` replace their `.handle` fields with `.origin` (the root scheme URI) and `.relativePath` (a forward-slash path fragment). Tree scanning goes through `storage.readDirectory(rootOrigin)` rather than `rootHandle.getDirectoryHandle(...)`. `.git` detection is delegated to `vcsAdapter.detect(rootOrigin.path)`.

### VCSAdapter: atomic `switchBranch` with `SwitchResult`

`switchBranch()` becomes a single flattened operation. The separate `canCheckoutBranch()` method on the interface is removed. Callers (workspace, FileExplorer component) invoke only `switchBranch()` and pattern-match on its return type:

```
SwitchResult
  = { status: 'switched' }
  | { status: 'noop' }
  | { status: 'blocked', reason: 'conflict' | 'worktree', files: string[] }
  | { status: 'error', message: string }
```

### VCSAdapter: carry-forward in `switchBranch` (browser adapter)

The `IsomorphicGitAdapter.switchBranch` implementation follows this pre / during / post cycle:

1. **Snapshot**: For every dirty file (working tree modified, or staged), capture — working tree content, index blob OID, and whether the file is partially staged (index differs from both HEAD and working tree).
2. **Checkout**: Run `git.checkout({ ref: branchName, ... })` which blasts the working tree and index.
3. **Restore**: For each snapshotted file — write the working tree content back and re-add it to the index if it was originally staged, preserving the full three-way split. If a genuinely conflicting file is detected, abort and re-checkout the original branch.

Blocker errors beyond the sets that can be identified (either by worktree or conflict) are surfaced as `{ status: 'error', message: string }`.

### VCSAdapter: `detect(rootPath)` replaces workspace-level `.git` probing

The `VCSAdapter` interface gains a `detect(rootPath: string): Promise<boolean>` method. `Workspace` calls `vcsAdapter.detect(rootOrigin.path)` after a root is folder-selected, instead of `rootHandle.getDirectoryHandle('.git')`. The `IsomorphicGitAdapter` checks for `.git` by probing its filesystem shim; the `SimpleGitAdapter` (desktop) runs `git rev-parse --is-inside-work-tree`. Note: While the desktop adapter uses the CLI for writes, it should use programmatic reads (e.g. via `isomorphic-git`) for performance-sensitive UI tasks like gutters and blob fetching.

### VCSAdapter: `HeavyWorktreeIgnorer` refactored away from the adapter boundary

The heavy-worktree directory set (`node_modules`, `.svelte-kit`) was in the adapter's scan logic because the adapter held a handle to the root. With path-based scanning, the adapter only receives file paths as flat strings, so the ignore-filter is applied at the scan layer, not the adapter layer.

### Persistence: abstracted behind `SessionPersistence` interface

`SessionPersistence` exposes:

- `saveRoot(origin: FileOrigin): Promise<void>` / `loadRoot(): Promise<FileOrigin | null>`
- `saveOpenFiles(origins: FileOrigin[]): Promise<void>` / `loadOpenFiles(): Promise<FileOrigin[]>`
- `saveActiveDocId(id: string | null): Promise<void>` / `loadActiveDocId(): Promise<string | null>`
- `saveRecentFolders(origins: FileOrigin[]): Promise<void>` / `loadRecentFolders(): Promise<FileOrigin[]>`

`IndexedDBSessionPersistence` stores raw `FileOrigin` records (serialisable plain objects) in the existing `np-storage` IndexedDB. No `FileSystemHandle` objects are stored. `ElectronSessionPersistence` writes a `session.json` to the AppData directory.

Workspace session restore / save no longer imports `FileSystemHandle` directly. It reads and writes only `FileOrigin`.

### Permissions: Storage Provider concern, not Workspace concern

Permission checks route through the existing origin-aware `queryPermission(origin, readWrite?): PermissionState` method, where `PermissionState` is `'granted' | 'prompt' | 'denied'`. `BrowserStorage.queryPermission()` wraps `handle.queryPermission()`. `ElectronStorage.queryPermission()` always returns `'granted'`. `Workspace` and `DocumentSession` query the provider rather than touching browser handles directly.

A path-only `checkPermission(path)` was considered and rejected: the `StorageCoordinator` (`MultiSchemeStorage`) routes by `Origin` scheme, and a path-only method carries no scheme, forcing the coordinator to guess a provider via the default scheme. Keeping permission checks origin-aware preserves scheme-based routing.

### Svelte runes (`$state` / `$derived`) remain in core

Both the browser and Electron app shells use SvelteKit to render. Decoupling `$state` / `$derived` from core adds type-bridging boilerplate (Svelte stores wrapping plain getters/setters) for no platform benefit. Runes stay in all classes that currently use them.

### `Repository` constructor and initialization

`new Repository(rootHandle)` becomes `new Repository(rootOrigin: FileOrigin, adapter: VCSAdapter)`. The old path-based `gitDirectory` workspace method is replaced by the adapter. `Repository.isValid()` / `refresh()` accepts the adapter result.

### `DocumentSession` origin simplification

`DocumentSession` no longer stores a `handle` field. It references its file only via its `FileOrigin` URI. Permission checks originate from `storage.queryPermission(origin, readWrite)` rather than `this.origin.handle.queryPermission()`.

---

## Testing Decisions

### Scope of testing

Tests cover **external behaviour through the public interface** of deep modules — not implementation details. A test for `IsomorphicGitAdapter.switchBranch` verifies that the files in the working tree match the target commit's content with any dirty files preserved; it does not inspect internal handle registries or IndexedDB writes.

### Deep modules targeted for unit tests

| Module | Why it's a deep module | Test style |
|---|---|---|
| **`SessionPersistence`** (browser) | Saves and restores `FileOrigin` records via IndexedDB with no browser globals in its core logic. | In-memory (temporary DB), test all CRUD paths, no Playwright needed |
| **Storage coordinator** | Routes `FileOrigin` records to the correct `StorageProvider`. Test that a `browser://` origin hits `BrowserStorage` and a `git://` origin hits `GitStorage`. | Pure unit test |
| **`FileOrigin` URI construction** | The `scheme` + `path` + `name` triple is the loading point for platform discrimination. Tests verify round-trip serialisation and scheme detection. | Pure unit test |
| **`IsomorphicGitAdapter.switchBranch` (carry-forward)** | The carry-forward logic (snapshot → checkout → restore) is the most critical VCS behaviour for the browser. | Playwright with mock filesystem (same pattern as `tests/vcs.spec.ts`); also runnable as a unit test against a mock fs |
| **`VCSAdapter` interface contract** | Every integration point on the interface must have a contract test so that `NativeGitAdapter` can be swapped in without surprises. | Playwright mock-adapter spec or plain unit test |
| **Branch safety conflict detection** | The carry-forward `switchBranch` must return `{ status: 'blocked', reason: 'conflict', files: [...] }` when a dirty file is also changed between the two branches. | Playwright with mock filesystem |

### Prior art

`tests/vcs.spec.ts` already establishes the mock filesystem pattern (`MockFileHandle`, `MockDirectoryHandle` with `entriesMap`, full create-writable streaming). New tests for storage and session persistence follow the same pure-unit-test pattern used by the spec. New VCS carry-forward tests extend the Playwright based integration pattern already in `vcs.spec.ts`.

### What we shall not test

- Individual UI components (those are Svelte render-level concerns; `component.spec.ts` for `BranchSafetyModal`, `FileExplorer` etc. are already tested elsewhere).
- IndexedDB internals or BrowserStorage handle wiring (tested through `SessionPersistence` contract tests; feel free to add a small integration test if registry bugs appear during development).
- Electron storage or native Git adapter — out of scope for this PRD.

---

## Out of Scope

| Excluded item | Reason |
|---|---|
| Electron implementation (`ElectronStorage`, `NativeGitAdapter`) | This PRD covers abstractions and the browser-side refactor only. Electron is a consumer of these interfaces. |
| Actual monorepo split (`pnpm workspaces`, `@np/core`, `@np/vcs-browser`, …) | The adapter isolation is the foundation; the split is deferred to a separate ticket that is not produced here. |
| `MigrateWorkspaceRoot` data-migration script | Existing users may have raw `FileSystemHandle` blobs in IndexedDB. A migration path that reads old-format records and writes new `FileOrigin` records is deferred. |
| New UI components for branch-safety or multi-scheme UX | UI refactors are needed for multi-scheme management and permissions but the designs, if any, were not discussed. |
| Git Blame / LSP integration | Unrelated to the storage/VCS layer. |
| Remote VCS backends (GitHub/GitLab integrations) | These depend on the `GitStorage` provider existing first. |
| `NativeGitAdapter` tests | Policy limits story scope to browser-side. |

---

## Further Notes

### Existing `canCheckoutBranch` is a foot-gun

The current `VCSAdapter` has many implementations of `canCheckoutBranch` in the call-graph (`Repository.getSafetyReport`, `Workspace.getBranchSafetyReport`, `FileExplorer` modal pattern). All of those consumers must be updated to call `switchBranch` directly and match on the result. Careful audit is needed during implementation to avoid a mix of pre-flight and post-flight patterns coexisting.

### Session restore ordering

During `Workspace.restoreSession()`, the `rootOrigin` must be resolved and the permission granted *before* `projectTree.scan(rootOrigin)` and `vcsAdapter.detect(rootOrigin.path)` are called. If permission is not yet available, the tree and repo should enter a `loading` state rather than reading `null` paths.

### `HeavyWorktreeIgnorer` boundary shift

The `HeavyWorktreeIgnorer` (`['node_modules', '.svelte-kit']`) was inline in the adapter allowing handle-based traversal. In the path-based model the same logic should move into the tree-scanner (`ProjectTree.scan` method); the adapter never sees directory handles.

### `NTK` and import aliases

The project uses `$lib` as the path alias. New abstractions (e.g. `MultiSchemeStorage`, `StorageProvider` interface, `SessionPersistence`) live under `src/lib/` and are importable as `$lib/storage` and `$lib/persistence` without changing any remaining import paths.

### Issue tracker

No issue tracker or triage label vocabulary is configured in the repository at time of writing. Before publishing, configure the project with an issue-tracker setup (e.g. GitHub Issues, Linear) and note it here. In the meantime this PRD is available in the repo docs.
