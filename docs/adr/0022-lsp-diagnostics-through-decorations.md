# LSP diagnostics as editor decorations

Plugins cannot access the CodeMirror `EditorView` or dispatch transactions directly. Rather than adding feature-specific decoration APIs to the host core, the LSP plugin displays diagnostics through standard editor contribution compartments.

The contribution provides a state field holding document diagnostic marks and their styling. The state field recomputes when the displayed URI changes or the diagnostics store revision advances, mapping existing marks through document edits to prevent misplaced underlines between server responses.

Because diagnostics store updates occur outside editor transactions, the plugin requests an editor contribution rebuild on store writes. The host replays existing transforms to reconfigure the decoration compartment without duplicating registrations or losing editor state. Diagnostic publish updates coalesce per event-loop tick so multi-file reports trigger only one reconfiguration pass.
