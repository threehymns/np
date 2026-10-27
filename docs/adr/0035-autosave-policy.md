# Auto-save is one setting, and the workspace owns what it triggers

`editor.autosave` chooses when a dirty file is written without asking. It has
four documented spellings: `"off"`, `"on_focus_change"`, `"on_window_change"`,
and `{ "after_delay": { "milliseconds": <integer> } }`. The default is `"off"`,
because a save the user did not ask for is a change to a file they may not be
looking at.

The setting is a union rather than a mode plus a separate delay key. A delay
only means something with `after_delay`, and a mode plus an unused milliseconds
field lets the two disagree. One key also means one value to persist, validate,
and read at the trigger site.

## The setting decides when; the workspace decides whether

Validation belongs beside the setting in `autosave.ts`. The policy belongs in
`Workspace`, the only object that knows a document is dirty, has an origin, is
deleted on disk, or is already being saved. `AppState` wires a
`autosaveSettingProvider` to `Preferences`; the workspace reads the setting
through that callback rather than reaching into the preferences store. This is
the same seam the settings-reader service gives plugins: preferences own what
the user chose, the workspace owns the document lifecycle.

Only a dirty document with a real origin is eligible. An untitled document has
no destination to write to, and asking the user to pick one is the existing save
prompt, not auto-save. A document deleted on disk has no file to write. A clean
document has nothing to do. Auto-save is a way to avoid the save/discard prompt;
it is never a reason to write somewhere the user did not choose.

## Triggers are events, not polls

The editor reports that its input lost focus, and the application shell reports
that the window lost focus or became hidden. `Workspace.autosaveOnFocusChange`
and `Workspace.autosaveOnWindowChange` apply the policy. A focus move within the
editor's own root is not a change for this purpose: moving from the text to the
permission control is still editing the same document.

`after_delay` is a per-document inactivity timer. Every keystroke resets that
document's timer, so a burst of typing produces one save after typing pauses.
The timer is cleared by a successful save, by closing the document, by replacing
the document set, and by disposing the workspace. If the setting changes while a
timer is pending, the timer re-reads it: turning auto-save off cancels the write,
and a different delay restarts from the new delay.

All writes go through `Workspace.saveDocument`, not `DocumentSession.save`, so
before/after save hooks and repository refresh run exactly as they do for a
manual save. Writes are serialized by the existing save exclusion. A trigger
that arrives while that document's write is in flight coalesces with it; a
successful write that finds newer edits schedules the follow-up delay instead of
losing them.

## Closing is a save opportunity, not a discard

Closing a dirty file while any auto-save mode is on saves it first, including a
close before the inactivity delay has elapsed. The close still runs through the
ordinary save path; if the save fails or is cancelled, the existing save/discard
prompt is the fallback. Batch closes apply the same rule to each dirty file. Tabs
that cannot be saved — untitled, deleted on disk, or a failed save — still reach
the prompt.

This is deliberately broader than the selected trigger. A user who selected
`on_focus_change` and then closes a dirty tab has expressed that the file should
be saved automatically; showing a prompt only at close would make the setting
look like it forgot its own promise.

## What is asserted, and where

- `autosave.test.ts`: the accepted spellings, the rejected shapes and their
  actionable messages, the default, and the schema wiring.
- `workspace-autosave.test.ts`: delay saves and resets, focus and window
  triggers, the named-mode filters, eligibility for untitled/clean/deleted
  files, close and batch-close saves, prompt fallback for untitled, deleted,
  and failed saves, setting changes during a pending delay, a closed document
  ignored by a late focus report, and disposal.
- `preferences.svelte.test.ts`: the default, persistence of both named and
  delayed forms, reload, and fallback for a hand-edited value.
- `autosave.spec.ts` (end-to-end): configuring the delay in the settings modal,
  an inactivity save, retiming a pending delay, a focus-change save, a
  window-change save, a close save, and the untitled prompt remaining.
