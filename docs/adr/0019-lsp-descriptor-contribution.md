# The host owns the server descriptor; the plugin owns the server

Language servers are described to the host and driven by a plugin. Host core gains one contribution type — a descriptor naming a command, its arguments, an ordered list of root markers, and the languages it serves — and nothing else. There is no client, no stdio, no JSON-RPC, no process management and no log buffer in `@np/core`. A bundled LSP Core Plugin owns all of that, plus the document walk that turns a marker list into a directory.

## Why the host stops at the descriptor

The alternative was to host the client and have plugins declare configuration for it. That would put language-server machinery in the same package as the language registry, the command registry and the editor compartments, behind interface names the host would then have to keep stable: `startLanguageServer`, `sendLanguageServerRequest`, `stopLanguageServer`. Those names are Git-shaped, not reusable — the shape of ADR 0008's warning about accumulating feature-specific methods, one layer down. A host that can start a process is a host that cannot be reasoned about as a neutral meeting point, and the second server (a future language pack's first requirement, per spec #263) would arrive as new host surface rather than as configuration.

The descriptor keeps the reusable part reusable. It is data, joined on the language identity the language registry already publishes, so it is a third sibling of `languages.ts` and `completions.ts` rather than a new `EditorContributionType` for the same reason ADR 0018 gives: "start this process against this root" is not a CodeMirror `Extension`. Ownership follows the record, not the transform that ran last, and a duplicate ID is reported rather than resolved — a silently dropped claim would start no server for files someone declared one for.

## The transport is a seam, not an implementation

`LSP_TRANSPORT_SERVICE_KEY` names two capabilities `@np/core` cannot have for itself: spawn a process, and ask the filesystem whether a file exists. It does not name an implementation, and the host stores whatever it is given opaquely (ADR 0008). The desktop app supplies it over Electron IPC; the plugin resolves it per use and degrades to "no LSP" when it is absent. That absence *is* the web story: spec #263 puts stdio on desktop and leaves remote and headless hosting to a later spec, so a web build publishes nothing and the plugin stays inert rather than half-working. The manifest says `platforms: ['desktop']` for the same reason, which ADR 0006 permits provided the limit is stated — it is, in the manifest description as well as the field.

Two things made the seam the right shape rather than a `desktop`/`web` split inside the plugin. A real process and a real filesystem then stay testable without either leaking into neutral core: the lifecycle suite spawns the scripted stub server as a genuine child process over genuine pipes, and only the executable is swapped (ADR 0004 makes the same argument for real `git`). And a future remote transport is a new provider behind the same key, not a second client.

## Root markers are descriptor data; the walk is code

The descriptor says *what identifies a project*. The plugin says *how to use it*: from the open document's own directory upward, within a directory the first declared marker present wins, across directories the marker declared first wins overall, ties broken by the nearest directory. A nearer marker therefore does not beat a more specific one — in a repository with a root `tsconfig.json` and a `package.json` in a nested package, a file in that package still resolves to the root its `tsconfig.json` declares. That is what makes the field an ordered list rather than a set, and it is why the host contributes no marker names of its own: a second place that knew what a project was would eventually disagree with the first.

One descriptor attributes each decision. Two descriptors claiming one file is a configuration fault, not a preference: picking by registration order would make the answer depend on which plugin enabled first, so the conflict is reported and no server starts for that file.

## Document sync sends full content

Sync is declared as full-document (`textDocumentSync: 1`) and every change carries the whole text. Incremental sync is the recorded later optimisation, held back until large-file behaviour is actually measured. Sending whole documents is more bytes on the wire and less code that can be wrong about offsets, and nothing in this slice has shown the cost to be real.

## What is asserted, and where

The registry's three acceptance properties — remove-one equals a clean build, a mid-session refresh loses nothing and duplicates nothing, deactivate/reactivate equals pre-activation — are asserted on the registry, because that is where replay decides them. Lifecycle claims are asserted against a real process and a real pipe: the root the client resolved is read back out of the stub's own `initialize` reply, and "no orphan" is checked with the pid, not with a flag. The byte-level framing is asserted separately by feeding the parser one byte at a time, because a pipe read that splits a multi-byte character is the case a fake stream cannot produce.
