# Server diagnostics reach the editor by replaying a decoration contribution

Diagnostics arrive from a pipe at a moment of the user's choosing, which is the
hard case for ADR 0016. A plugin may not touch the editor view and may not
dispatch a transaction, so the usual shapes are both unavailable:
`@codemirror/lint`'s `setDiagnostics(view, diagnostics)` needs the view, and a
contributed `StateField` of marks needs a transaction carrying an effect that
only the view could apply. Giving the host a decoration-data seam would fix the
timing and cost the host a feature-shaped API, which is the trade ADR 0008 warns
against. So the marks come from the one thing the editor already re-evaluates on
its own schedule: the decoration compartment the plugin contributes to.

The contribution is a source facet naming the document the editor is showing, a
state field holding that document's marks, and the styles those marks need. The
field recomputes whenever the shown URI or the diagnostics store's revision
moves, and maps its marks through the edit that happened in between, so a
keystroke does not make the underline jump to a character the server never named.
The document is read from the workspace's active tab rather than from the view,
because the view is host-owned and not plugin surface; the first facet input wins
so that two owners cannot each answer for the same editor and have the result
depend on which plugin enabled first.

A publish still has to reach the screen, and a store write is not a transaction.
The editor already re-applies its decoration compartment whenever the
editor-contribution registry is rebuilt, so the plugin asks for exactly that. It
replays the transforms it already registered rather than registering new ones,
which is why a rebuild cannot duplicate a contribution or lose one (ADR 0012) and
why it is safe to call on every publish — re-registering, the alternative, grows
a transform per keystroke. No host method is added, no view is touched, and the
cost is one compartment reconfiguration per report.

What is asserted, and where: the marks themselves are read from the state field
through the host's own compartments, including that one file's diagnostics never
appear on another and that a stale report is clipped rather than dropped; the last
step the plugin does not control — a computed decoration reaching the DOM as a
squiggle span — is asserted against a real `EditorView` on a DOM stub; and the
protocol half runs against the scripted stub server as a real process, because a
fake stream cannot produce the chunk boundary inside a message that the framing
has to survive. A report that no longer fits the document is clipped, an empty
range is marked as one character because CodeMirror rejects an empty mark, and a
stopped server's findings are dropped, because they describe a process that is no
longer watching the file.