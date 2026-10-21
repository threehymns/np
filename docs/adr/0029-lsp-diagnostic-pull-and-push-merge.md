# A pull and a push for one path share one slice, and the pull is the newer word

A language server can be asked for a file's diagnostics and can also send them
unasked. Both answers reach the editor through the one store ADR 0022 puts
between the protocol and the decorations, so a file that one server serves by
pull and another by push is one file with one set of marks, and the store has
to say which of the two answers wins. It says the pull. A pull is asked for
after the change, so the server computes it against at least the revision the
editor last synced, while a push may have been computed against the revision
before that change, so the pull is the newer word for that path and the store
keeps it. The store does not compare revisions to decide this. The source of
the result decides, per path and per server, and that is the whole of the
rule.

## One slice per path and per server, and the source that filled it

The store holds one slice per path per server, and each slice records the
source that filled it. A pull report replaces the slice its own server holds
for that path. A push report is dropped when the slice it would replace came
from a pull, and replaces that slice otherwise. The two sources are never
unioned: they are two answers to the same question about the same server, and
the newer one is the answer, so a finding the pull does not carry is not
painted beside it.

The rule is per path and per server, so a push from a second server that
serves the same file still lands, in its own slice, and the file shows what
both servers say about it. A report that carries no findings clears that
server's slice for that path and nothing else, on the terms a clean push
already had, and a path no server has an opinion about holds no slice at all.
A push that finds a pull-sourced slice is dropped before that check, so a
clean push never clears what the pull filed. A report that is dropped changes
nothing: the store's revision does not move, so a view that re-reads on every
notification is not woken for a result it did not take.

## A server with no pull support keeps the behaviour it had

Whether a server answers `textDocument/diagnostic` is the server's own to
say, read out of its `initialize` result, and a server that does not say so
is never asked. Its findings arrive as pushes, a push replaces its own slice
as it always has, and nothing about the shape of its path changes. The pull
machinery is off for that server rather than merely empty, which is what keeps
a push-only server from being asked a question it cannot answer.

## What the client declares

The client says it asks for diagnostics by pull, in the one capability table
`LspClient` owns (ADR 0028): `textDocument.diagnostic` with
`dynamicRegistration: false` and `relatedDocumentSupport: false`. The dynamic
half is false because the client never asks a server to register a diagnostic
provider — the server's own `diagnosticProvider` is what says it answers pulls
— and the related half is false because a pull asks about one document at a
time and never names a related one. Asking for the answers while declaring
nothing would be the protocol error the completion capability in the same
table already warns about.

## A failed pull leaves the pushed findings alone

A pull that errors, or that answers with something the parser cannot use, is
not filed. The store keeps what the server pushed, because a request that
failed says nothing about the file, and clearing on failure would turn a
flaky server into a file with no marks. The failure ends the pull rather than
the findings, and the next change asks again.

A failed pull that leaves the pushed findings alone looks, from the outside,
exactly like a pull that worked, so the reason is reported the way a failed
completion and a failed hover are: once, in the Logs tab, after the retries
are spent rather than once per attempt. An interrupted pull is not a failure.
A server that stopped while a pull was in flight has failed nothing, and
neither has an edit that replaced the pull with a newer one, so neither leaves
a warning behind.

## The pull is timed on the Effect scope

The debounce, the backoff and the teardown of a pull are Effect's, on the
runtime's own scope, as ADR 0023 decides for pull timing generally. A pull
still waiting out its debounce when the server stops is interrupted rather
than sent, and the result id cache goes with the server, so a restarted server
is never handed the previous result id of the process that died.

## What is asserted, and where

- `diagnostic-pull.test.ts`: a pull landing on a path that already holds a
  push from the same server, a push refused against a pulled path, a push
  from a second server still landing, an empty pull clearing that server's
  slice and no other, an unchanged report costing nothing, a failed pull
  leaving the pushed findings alone, a bounded retry, a failed pull reported
  once, an interrupted pull not reported as a failure, a server that
  supports no pull behaving as it did before, and the result id cache going
  with a stopped server.
- `diagnostics.test.ts`: the per-server slices the store reads out, and the
  clean-file and stop semantics the pull inherits.
- `lifecycle.test.ts`: the wiring the coordinator sits behind — an edit
  asking a server that offers the pull for the file's findings and filing
  the answer, a server that offers no pull never being asked, and a failed
  pull being reported.
- `client.test.ts`: the client's own declaration of the pull it asks for.
