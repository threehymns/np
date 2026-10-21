# The workspace pull is a loop per server, and the document pull still wins for an open buffer

A server that answers `workspace/diagnostic` is asked about the whole
workspace rather than about the file the editor happens to have open, and it
answers with a report per path. That is the only way a file nobody opened
gets diagnostics at all, and the loop is what keeps that answer current without
asking the server on every keystroke.

The loop is per server, not per workspace and not per document. One server
answers about the workspace it was started for, and its answer covers every
path in it, so one loop per server is one loop per answer.

## The loop is owned by a scope

Each server's loop is forked on a scope of its own, a child of the runtime's
own scope. Stopping the server closes that scope, so the loop ends and no
further request goes out; disposing the runtime closes the parent, which
closes every child with it. The scope is the teardown: a pull that was in
flight when the server went away is interrupted rather than filed, and a
restarted server is never handed the result ids of the process that died.

## The cadence is an idle repull and a backoff

A pull, then the idle repull interval, then a pull again. The backoff is the
one `pull-schedules.ts` already holds: `50 * 2^n` milliseconds, jittered and
clamped to a second, retried for as long as the server cannot answer, because
a server that is coming back is worth waiting for. A failure is reported once
per failure series rather than once per attempt, the way a failed document
pull is.

The loop waits the interval between pulls rather than repeating on a fixed
schedule, because a fixed schedule cannot be woken early, and a refresh has
to be answered now rather than after the interval is up.

## A refresh is answered before it is acted on

`workspace/diagnostic/refresh` is a request, not a notification: the client
owes the server an answer. The client sends that answer first and acts on the
refresh afterward, and the order is the whole of the deadlock it avoids. The
client's reaction to a refresh is a pull, and a server that is waiting for the
refresh reply will not answer the pull until the reply is on the wire.

The refresh re-arms the workspace pull and the document pull of every open
buffer the server serves. Both, because the document pull keeps a path an
open buffer owns: the workspace pull may name it too, but the document pull's
answer stands, so a refresh that only re-armed the workspace pull would leave
the open buffers stale.

A storm of refreshes is one repull. The signal is a latch rather than a
queue, and the loop yields before it pulls again, so the signals that arrive
while the loop is on its way to the wire are the same request, asked once.

## Three answers about one path, and the order between them

Which of the three wins is ADR 0029's decision, not this one's. The protocol
states the order — LSP 3.17, "Workspace Diagnostics" — and ADR 0029 follows
it: the revision decides when two answers name one, and the source decides
when they do not, with the source order the document pull, then the workspace
pull, then the push. A workspace report names no revision, because the version
it carries is the server's own rather than the editor's counter, so it is
ordered against a document pull by source alone, and the document pull keeps a
path an open buffer owns.

Everything ADR 0029 says about a push against a pulled path still holds: the
push is dropped, the revision does not move, and a view that re-reads on every
notification is not woken for a result it did not take.

One edge follows from the clean-file rule ADR 0029 already had. A clean
document pull clears that server's slice for the path, as a clean push always
did, and a later workspace report may file that path again until the next edit
re-pulls it. The diagnostics on screen are then the workspace's, which is a
weaker answer than the buffer's, and the next edit puts the buffer's answer
back.

## What the client declares

The client says it handles a diagnostic refresh, in the one capability table
`LspClient` owns (ADR 0028): `workspace.diagnostics.refreshSupport: true`. The
capability is the server's permission to ask, and the client answers the
request either way, because a server that waits for a reply that never comes
waits forever.

## What is asserted, and where

- `workspace-pull.test.ts`: the cadence on the TestClock, the report landing
  per path, the previous result ids carried into the next pull, the backoff
  when a server cannot answer, a storm of refreshes producing one repull, the
  loop ending on a stop and on a closed scope, a partial result filed only
  for the pull in flight, an answer of nothing taken as nothing to file, and a
  report the parser cannot use failing the pull rather than filing half of it.
- `diagnostics.test.ts`: the three sources composed, the document pull kept
  over a workspace pull in either order, a workspace report that does not
  displace a document pull that names a revision, a push refused against a
  workspace-pulled path, and a clean workspace report clearing its own path
  and no other.
- `client.test.ts`: the client's own declaration of the refresh, the refresh
  answered with a null before the caller is told, and a request the client
  does not implement answered with method-not-found.
- `lifecycle.test.ts`: the wiring the coordinator sits behind — a server that
  offers the workspace pull asked about a file nobody opened, a server that
  offers no workspace pull never asked, the loop ending on a stop and on a
  dispose with no further request, and a refresh re-arming both the workspace
  pull and the open buffers.
