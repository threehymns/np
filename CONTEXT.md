# Domain Language

## Document
A single file's content, its source (origin), and its current state.
- **Origin**: A structured URI-like object (scheme, path, name) indicating where a document is persisted.
- **Untitled**: A document that has not yet been saved to an origin.
- **Language**: The formal syntax and grammar of the content (e.g., Markdown, TypeScript).
- **Language Mode**: The active editor configuration used to process a Document. Typically auto-detected from the **Origin**'s extension, but can be manually overridden.

## Storage
The path-based abstraction for file read/write operations.
- **Storage Coordinator**: The central manager (e.g. `MultiSchemeStorage`) that intercepts file operations and routes them to the appropriate provider based on the **Origin**'s scheme.
- **Storage Provider**: A scheme-specific adapter (e.g. `BrowserStorage`, `ElectronStorage`, `GitStorage`) implementing the operations for a given URI scheme.

## Preferences
User-defined settings that persist across sessions (theme, zoom, word wrap).

## Editor
The visual interface for interacting with a Document's content, powered by CodeMirror.
- **Extension**: A modular piece of functionality added to the Editor (e.g., list renumbering, checkbox toggling).
- **Completion**: A suggestion the Editor offers while typing, accepted explicitly by the user. A Completion source produces Completion items; ranking and presentation of items is host behavior.

## Workspace
The window state: the open documents and tabs, the active tab, and a pending close — plus
exactly one **Project**. It owns no folder, repository, permission, or file tree itself; all
of those live on its Project. One Project per Workspace. Window-scoped session persistence
(recent folders, root folder) is driven from Workspace, while per-folder state lives on its
Project keyed by folder URI.
- _Avoid_: tab, vault

## Project
The shared backing store behind one **Workspace**: its search scope, its repositories and git
state, and its settings. One Project per Workspace — switching Workspaces switches Projects.
A `Project` is a distinct type in code: it owns its Worktrees, its Repository, its
root-permission flag, and the storage and VCS seams those need.
- _Avoid_: workspace, folder, vault

## Worktree
A checkout within a **Project**, holding a root path and the file entries scanned beneath it.
Today a Project holds exactly one Worktree — its root — until a linked-worktree feature exists.
- _Avoid_: vault, folder, repository, project
  _Note: replaces "vault". A Worktree is a checkout, not a repository and not a project root —
  the repository and the opened-on root both live on its Project. **Root** is the in-use term
  for that single directory until linked worktrees arrive. The persistence-layer `root-folder`
  naming, recent-folders, and the "Open Folder" label all stay._
- **Root**: The folder path a Project is opened on — the root of its single Worktree. _Avoid_: root folder, vault

_Git vocabulary:_ `worktree` is a registered working root (git-worktree(1)), which includes git's
own `--worktree` flags — those stay verbatim. "working tree" is the on-disk state that HEAD and the
index are compared against. The two must stay distinguishable, and phrasing that names HEAD, index,
and working tree together is correct as written. This codebase previously used `worktree` for the
second sense, which is why `vault` had been standing in for the first.

## Command Palette
A searchable dialog interface allowing the user to search and run registered actions across the application.
- **Nested Palette (Sub-Commandbar)**: A temporary state of the Command Palette displaying a specific list of options (e.g. available languages) instead of the top-level commands, support back navigation via Backspace or a back button.

## Architecture
- **Monorepo**: A workspace managed by Bun containing isolated packages for core logic, UI, and platform-specific applications.
- **Core**: The headless business logic (`@np/core`) containing state management, document models, and the `Workspace` orchestrator. Entirely platform-agnostic and free of DOM or Node globals.
- **UI Shell**: The platform-agnostic presentation layer (`@np/ui`) containing Svelte components (Editor, FileExplorer) that consume the Core via Context injection.
- **Platform App**: A concrete application target (`apps/web`, `apps/desktop`) that instantiates the Core, injects platform-specific adapters (Storage, VCS), and mounts the UI Shell via an `<AppShell>` component.

## Extension Ecosystem
- **Plugin**: An application feature with an explicit lifecycle that contributes behavior or presentation to np. Distinct from an Editor Extension, which changes editing behavior.
- **Core Plugin**: A Plugin shipped with np rather than installed separately. Optional Core Plugins can be disabled while the basic editor remains usable. _Avoid_: external plugin, Core (when referring to a bundled feature rather than the headless application layer).
- **Git Plugin**: The Core Plugin containing np's Git functionality. Its purpose is to make Git optional and exercise the Plugin model; it does not imply a parent VCS Plugin.
- **Settings Namespace**: A plugin-owned section of the settings tree (for example `git` or `editor`), with its own schema and defaults. Setting names follow Zed's conventions wherever they fit.
- **Transform**: A function a Plugin registers to describe its change to a shared registry. The host replays transforms in order from an empty initial value on every rebuild.
- **Reload**: Rebuilding a registry from its current transforms, for example after a plugin refreshes its underlying data.
- **Reactivation**: Dropping one plugin's transforms and running its new code after the plugin is added, edited, removed, enabled, or disabled, then rebuilding affected registries.
- **Event**: A record that something happened, offered for observation only. Subscribers cannot mutate, veto, or fail the operation.
- **Language Server**: An external process speaking the Language Server Protocol for one or more languages: completions, hover, diagnostics, navigation. Managed by the LSP plugin, never by the host directly.
- **LSP Descriptor**: A plugin contribution describing how to start and scope a Language Server: its command, arguments, root markers, and the languages it serves. _Avoid_: Server Descriptor (unscoped; a future headless server will need the bare word).
- **Hook**: Participation in a running host operation through before/after phases. Before-hooks run sequentially in activation order and may modify inputs or cancel with a reason.
- **Icon Registry**: A centralized registry that resolves icons for languages, files, and UI elements. Accepts pluggable icon providers so that custom icon packs or third-party extensions can override the visual representations.
- **Snippet Pack**: A plugin's set of trigger/body/description records registered for one language, composed into the completion config by the host. Bodies are plain text — no placeholders, no snippet variables. _Avoid_: completion contribution, snippet contribution type, templates
- **UI Icon Pack (Product Icon Theme)**: A collection of icons representing application UI actions, controls, and navigation elements (e.g., Phosphor, Codicons).
- **File Icon Pack (File Icon Theme)**: A collection of icons representing document types, language modes, and file configurations, typically mapped by extension, name, or language mode (e.g., Catppuccin, Material, VS Code Icons).
- **Zed Icon Theme**: A JSON configuration file in the Zed editor format defining icon mappings via `file_stems` (filename → icon key), `file_suffixes` (extension → icon key), and `file_icons` (icon key → SVG path). Themes are loaded dynamically from GitHub repos via jsDelivr, with all assets committed to the repository (no build artifacts).
- **Installed Theme**: A third-party File Icon Pack installed by the user from a GitHub repository URL, cached in localStorage and resolved through jsDelivr CDN for icon assets.

## Version Control
- **VCSAdapter**: The interface through which the app performs version-control operations, abstracting the underlying engine (system git, isomorphic-git) behind one contract. _Avoid_: git adapter, SimpleGitAdapter
- **Carry-Forward**: The property of a branch switch that preserves modified and staged files instead of overwriting them. _Avoid_: auto-merge, preserve
- **Hunk Action**: A partial-file edit applied by text-splicing a single diff hunk (stage, unstage, or discard), requiring direct index/working-tree writes beyond file-level git commands.
- **Diff Viewer**: The presentation of a file's original versus working-copy content for review and staging, in split or inline mode. Distinct from an Editor tab: it shows the same working-copy Document through a diff lens.
- **Original Pane**: The read-only side of the Diff Viewer showing base content (HEAD or staged). Never editable. _Avoid_: left side, side a
- **Working-copy Pane**: The editable side of the Diff Viewer showing the working-tree Document. Keystrokes are unsaved edits to the same Document an Editor tab shows. _Avoid_: right side, side b

## Testing
- **Contract Test**: A behavior test that exercises a module through its public interface against a real engine (system git, isomorphic-git) in throwaway repositories, asserting semantic outcomes (contents, status, branch) rather than command construction. _Avoid_: integration test, end-to-end test
- **Unit Test**: A test of pure logic with the engine and platform replaced at the boundary (mocked adapter, mocked IPC).

## Keymap
- **Keymap**: A configuration file or preference (e.g. `keymap.json`) mapping keyboard input sequences (including chords) to Command IDs, scoped to active Contexts.
- **Context Registry**: A registry tracking active focus states and environment tags (e.g. `editor`, `vim_mode == normal`) to evaluate whether keybindings are active.
- **Keymap Registry**: The central coordinator that intercept key events (using a global capture-phase listener), matches them against active keymap bindings, handles chords, and dispatches corresponding commands. It also manages a key buffer for active chords.
- **WhichKey**: A visual HUD that appears during a keybinding chord to guide the user through available next keys and their associated commands or groups.
- **Chord**: A sequence of keypresses (e.g. `Space f n`) that triggers a command. Chords are context-aware and can be navigated back via `Backspace` or cancelled via `Escape`. A Chord is also **abandoned** when a keystroke arrives that cannot continue it; the buffer is discarded and that keystroke is re-evaluated as the first keystroke of a new Chord, so abandoning a Chord never consumes the keystroke that abandoned it.

