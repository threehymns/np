# ADR 0003: Keybinding System Architecture

*   **Status:** Accepted
*   **Decider:** AI Agent (Triage)
*   **Date:** 2026-05-30

## Context and Problem Statement

The application requires a robust, platform-agnostic, and user-customizable keybinding system that supports:
1.  Complex chords (e.g., `cmd+k m`, `space f n`).
2.  Context-aware resolution (e.g., different behavior in Vim normal mode vs. insert mode).
3.  A visual HUD (WhichKey) to guide users through chords.
4.  Platform-specific storage (Electron IPC on desktop, localStorage on web).

Existing draft documentation (ADR-001) was superseded by the implementation described here. This architecture is heavily inspired by the Zed editor's keybinding system.

## Decision Drivers

*   **Uniformity:** All shortcuts (including Vim leader sequences) must flow through a single pipeline.
*   **Discoverability:** Users should be able to see available continuations of a chord via a WhichKey-style overlay.
*   **Flexibility:** Users must be able to override default keybindings via a JSON configuration file.
*   **Headless Core:** The resolution logic must be platform-agnostic and live in `@np/core`.

## Proposed Solution

### 1. Data Model
Keybindings are represented as a list of `KeymapBinding` objects. Each object can have an optional `context` expression and a map of key sequences to command IDs.

```typescript
export interface KeymapBinding {
    context?: string; // e.g. "editor && vim_mode == normal"
    bindings: Record<string, string>; // e.g. "space f n" -> "file.new"
}
```

Bindings are stored in a flat array where **last-match-wins** resolution is applied, allowing user overrides (appended to the list) to take precedence over defaults.

### 2. Context Predicate Engine
A Pratt parser implementation in `ContextPredicate` handles expressions with support for:
*   Identifiers (e.g., `editor`)
*   Equality (`==`) and inequality (`!=`)
*   Logical NOT (`!`), AND (`&&`), and OR (`||`)
*   Parenthetical grouping

This allows fine-grained control over when a binding is active.

### 3. Unified Keydown Pipeline
All keyboard events are intercepted by a global listener (managed by `KeymapRegistry`) before they reach the DOM or the CodeMirror editor. This ensures:
*   Chords like `cmd+k` can be intercepted even if a sub-component would normally consume them.
*   Vim leader sequences (e.g., `Space` in normal mode) are handled by the app's keymap registry, not CodeMirror-Vim's internal Ex command layer.
*   The `KeymapRegistry` maintains a reactive `keyBuffer` for active chords.

### 4. WhichKey HUD
The `WhichKey` UI component is entirely data-driven from the `KeymapRegistry`. When the `keyBuffer` is non-empty:
*   The registry identifies all active bindings starting with the current buffer.
*   If multiple continuations exist, WhichKey displays them.
*   Labels are sourced dynamically from the `CommandRegistry`.
*   Groups are derived from common command categories or keymap metadata.

### 5. Storage Strategy
Keymaps are persisted using a dual-storage approach:
*   **Desktop:** Read/write via Electron IPC to a `keymap.json` file in the user's configuration directory.
*   **Web:** Read/write to `localStorage` (key: `np-keymap`).
*   **Persistence:** Managed through the `KeymapStorageProvider` which implements the standard `StorageProvider` interface.

## Consequences

*   **Good:** Single source of truth for all keyboard interaction.
*   **Good:** High discoverability via WhichKey.
*   **Good:** User overrides are robust and follow standard precedence rules.
*   **Bad:** Global interception requires careful handling to not block standard browser shortcuts (like `F5` or `Cmd+R`) unless explicitly bound.
*   **Bad:** Complexity of the Pratt parser and context evaluation must be maintained in the Core.

## Related ADRs

*   Supersedes: ADR-001 (Early draft, deleted)
*   Complements: ADR-002 (Monorepo Architecture)
