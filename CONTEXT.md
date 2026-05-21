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
- **File Icon Pack (File Icon Theme)**: A collection of icons representing document types, language modes, and file configurations, typically mapped by extension, name, or language mode (e.g., Catppuccin, Material, VS Code Icons).
- **Zed Icon Theme**: A JSON configuration file in the Zed editor format defining icon mappings via `file_stems` (filename → icon key), `file_suffixes` (extension → icon key), and `file_icons` (icon key → SVG path). Themes are loaded dynamically from GitHub repos via jsDelivr, with all assets committed to the repository (no build artifacts).
- **Installed Theme**: A third-party File Icon Pack installed by the user from a GitHub repository URL, cached in localStorage and resolved through jsDelivr CDN for icon assets.

