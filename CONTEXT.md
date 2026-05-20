# Domain Language

## Document
A single file's content, its source (origin), and its current state.
- **Origin**: The file system handle and metadata where a document is persisted.
- **Untitled**: A document that has not yet been saved to an origin.
- **Language**: The formal syntax and grammar of the content (e.g., Markdown, TypeScript).
- **Language Mode**: The active editor configuration used to process a Document. Typically auto-detected from the **Origin**'s extension, but can be manually overridden.

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

## Command Palette
A searchable dialog interface allowing the user to search and run registered actions across the application.
- **Nested Palette (Sub-Commandbar)**: A temporary state of the Command Palette displaying a specific list of options (e.g. available languages) instead of the top-level commands, support back navigation via Backspace or a back button.

## Extension Ecosystem
- **Icon Registry**: A centralized registry that resolves icons for languages, files, and UI elements. Accepts pluggable icon providers so that custom icon packs or third-party extensions can override the visual representations.
- **UI Icon Pack (Product Icon Theme)**: A collection of icons representing application UI actions, controls, and navigation elements (e.g., Phosphor, Codicons).
- **File Icon Pack (File Icon Theme)**: A collection of icons representing document types, language modes, and file configurations, typically mapped by extension, name, or language mode (e.g., vscode-icons, Material, Catppuccin).
- **Icon Pack Manifest**: A JSON configuration file defining the mappings and source CDN/asset base URLs for an icon pack, allowing themes to be loaded dynamically without hardcoding them in the core editor.

