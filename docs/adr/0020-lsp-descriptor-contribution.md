# LSP descriptor contribution

The host core defines and stores language server descriptors as plain data, while a bundled LSP plugin manages processes, stdio transports, JSON-RPC communication, and client lifecycles. Keeping process management out of `@np/core` prevents Git-specific or server-specific method creep on the host interface.

The plugin accesses process execution and filesystem checks through the `LSP_PLATFORM_SERVICE_KEY` service seam. Desktop environments provide this seam over Electron IPC. In web builds, the seam is absent and LSP features stay disabled without errors.

Descriptors declare project root markers as an ordered list. The plugin resolves project roots by walking upward from the document directory, matching the highest-priority declared marker. When multiple descriptors claim the same file, the plugin reports a conflict and starts no server.

Document synchronization sends full content on each change (`textDocumentSync: 1`). Incremental synchronization is deferred until measured performance on large files justifies offset tracking complexity.

The `editor.lsp` setting gates servers per language on a per-document basis. For descriptors serving multiple languages from one process, turning off one language closes its documents while keeping the process alive for other open files. When no enabled documents remain, the runtime stops the server. Settings updates trigger an immediate re-evaluation so disabled languages detach while the editor is idle.
