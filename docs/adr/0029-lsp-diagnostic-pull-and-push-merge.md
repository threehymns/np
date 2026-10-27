# Diagnostic pull and push merge

The diagnostics store maintains independent slices keyed by document URI and server name, combining reports from multiple servers onto one file. When multiple diagnostic reports arrive for the same path and server, the store determines precedence first by document version, then by source type.

Reports computed against a higher document version replace older reports. If version numbers are absent or tied, document pulls take precedence over workspace pulls, and workspace pulls take precedence over pushed notifications (`textDocument/publishDiagnostics`). Pushes lacking version numbers are ordered by arrival time and never displace versioned pull results.

Pull requests trigger debounced on document changes and when a document is opened or re-opened against a restarted server, filed against the document revision last synced to the server. A failed or timed-out pull leaves existing diagnostics intact rather than clearing the file, avoiding gutter flicker during transient server errors. Failed pulls log a warning once per failure series.
