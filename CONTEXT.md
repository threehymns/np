# Domain Language

## Document
A single file's content, its source (origin), and its modified status.
- **Origin**: The file system handle and metadata where a document is persisted.
- **Untitled**: A document that has not yet been saved to an origin.

## Storage
The interface for interacting with the underlying file system.
- **FileSystemStorage**: A concrete adapter using the Web File System Access API.

## Preferences
User-defined settings that persist across sessions (theme, zoom, word wrap).

## Editor
The visual interface for interacting with a Document's content, powered by CodeMirror.
- **Extension**: A modular piece of functionality added to the Editor (e.g., list renumbering, checkbox toggling).

## Workspace
The orchestrator of multiple open Documents, managing tabs, focus, and the active session.
