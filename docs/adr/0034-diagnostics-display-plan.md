# Findings are shown through one plan, and the plugin owns the settings that narrow it

Three surfaces show what a language server said about a document: the inline
marks in the text, the gutter marks beside the lines, and the diagnostics list
that arrives with #309. They have to agree about which findings are shown at
all, and they have to be able to disagree about the rest: a user who cannot
stand squiggles in their prose still wants to know the file has an error in it.

So the two are separate questions, and the settings are two keys.

## The inline toggle is about the text alone

`lsp.inline_diagnostics` says whether findings are painted into the text. It
says nothing else: the gutter marks and the diagnostics list are the same with
it on and with it off, because an "inline off" that also emptied the gutter
would read as "diagnostics off", and a user who turns a switch off and watches
the errors disappear concludes the switch is broken.

## The severity ceiling is about every surface

`lsp.max_severity` says how severe a finding has to be to be shown, and it
means the same thing in all three surfaces. The narrowing is one function —
`visibleDiagnostics` in `diagnostic-display.ts` — rather than one per surface,
because a ceiling applied per surface is three rules to keep in step, and the
drift is invisible until an error shows in the list and not in the text.

The default is `hint`, the least severe of the four, so nothing is hidden until
the user narrows it. A default that hid warnings would hide them on every
machine that had not been told otherwise, and a diagnostic that is hidden by
default is a diagnostic nobody knows is there.

A finding is shown when it is at least as severe as the ceiling, so a ceiling
of `error` shows errors and a ceiling of `hint` shows everything.

## The plugin owns the namespace

The two keys live in an `lsp` namespace the plugin owns, not in the host's
`editor` namespace. A namespace has one owner (ADR 0014), and `editor` belongs
to the host's core settings: a plugin that widened it would either collide
with that owner — the registry refuses two owners for one namespace — or
smuggle its keys into a tree it does not own, where a user reading `editor`
could not tell which keys the editor answers for and which the language server
does. What is here is about how findings are *shown*; whether a server runs at
all is `editor.lsp`, which is a question about the document and lives with the
editor.

## The plan is a plain module, and the store is the only source

`diagnostic-display.ts` decides what is painted and what the gutter carries,
from the findings and the settings, and it is plain: it reads findings, never
the protocol, and it knows nothing about the editor. The decoration layer turns
a plan into marks (ADR 0022). The diagnostics list of #309 reads the same
module, which is how the ceiling reaches it without the tab knowing anything
about the editor's marks.

## The gutter marks follow the text

A gutter mark is anchored at the start of the line it stands for, not at the
line number the server named. The server's line numbers are against the text
it last saw, so they go stale the moment the user types; a line start moves
with the text above it and stays a line start when the text below it is edited.
The inline marks follow the same rule by mapping their offsets through an edit
(ADR 0022), and a gutter mark that stayed on the line the server named before
the edit would contradict it.

A line is marked once rather than once per finding, and the mark carries the
line's worst severity and how many findings it stands for. A line with an
error and a hint is an error line, and a mark showing the hint would hide the
error.

## What is asserted, and where

- `diagnostic-display.test.ts`: the ceiling narrowing the findings, the inline
  toggle leaving the gutter marks alone, one mark per line carrying the line's
  worst finding, and the two settings resolved through the layered resolver.
- `diagnostic-decorations.test.ts`: the toggle and the ceiling reaching the
  marks the editor would draw, the gutter mark following the text through an
  edit, a push-only server's findings unchanged, and the plugin's namespace and
  its repaint wired into the host.
- `diagnostic-rendering.test.ts`: the gutter marks reaching the DOM, carrying
  the same text the underline carries.
