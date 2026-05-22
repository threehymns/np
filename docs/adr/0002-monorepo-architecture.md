# ADR 0002: Monorepo Architecture and Platform Abstraction

## Status
Proposed

## Context
The "np" editor needs to support both Browser (File System Access API, isomorphic-git) and Electron (native fs, native git) environments. The current architecture is tightly coupled to browser-specific APIs, making an Electron port difficult and preventing deep unit testing of business logic.

## Decision
We will transition to a monorepo structure using **Bun Workspaces** and a layered, adapter-based architecture.

### Monorepo Structure
```text
/
├── apps/
│   ├── web/              # Browser-based SvelteKit app
│   └── desktop/          # Electron-based SvelteKit app
└── packages/
    ├── core/             # Headless business logic (@np/core)
    ├── ui/               # Shared Svelte components (@np/ui)
    ├── storage-browser/  # Browser-specific storage adapter
    ├── storage-node/     # Node-specific storage adapter (fs)
    ├── vcs-browser/      # Isomorphic-git adapter with carry-forward
    └── vcs-desktop/      # Native Git CLI adapter (via simple-git)
```

### Architectural Principles
1.  **Headless Core**: `@np/core` will contain all $state, Document, and Workspace logic. It will have ZERO dependencies on DOM or Node globals.
2.  **Dependency Injection**: Platform-specific adapters will be injected into the `Workspace` constructor at app startup and propagated through the UI via Svelte Context.
3.  **App Shell Pattern**: `@np/ui` will export a high-level `<AppShell>` component to maintain UI consistency while allowing apps to inject platform-specific logic or overrides.
4.  **Adapter Isolation**: Complex platform-specific logic (like the carry-forward for `isomorphic-git`) must live within the adapter, not the Core.
5.  **Native VCS Implementation**: The desktop app will use the system `git` binary (via `simple-git`) for high-fidelity operations (checkout, commit, push). For performance-sensitive read operations (fetching blobs, diffing, gutters), the adapter should transition to a "Zed-style" hybrid approach using programmatic access (e.g. `isomorphic-git` in Node) to avoid process overhead.
6.  **URI-First Identity**: All file references will use a serializable `FileOrigin` URI format (`scheme://path`) to ensure portability across storage backends.

## Consequences
- **Portability**: Adding a new platform (e.g., Mobile) only requires implementing new adapters and a new app shell.
- **Testability**: The entire editor engine can be tested in pure Node/Bun without a browser environment.
- **Complexity**: Requires a one-time refactor of the current global `appState` singleton into a Context-based provider.
- **Consistency**: The `<AppShell>` ensures that UI improvements (like a new sidebar) are automatically shared across all platforms.
