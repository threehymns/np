# A result that arrives after the project changed is discarded

Asynchronous work that acts on the current project captures that project's
identity before it waits, and is discarded when the identity no longer
matches when it resumes, because a session restore, a branch safety
preflight or a branch switch that resolves after the user has switched
folders must never be applied to the project that replaced it.

## What the identity is

An identity is three things taken together: the URI of the project's root,
the Repository instance the project publishes, and a generation counter. The
root URI alone is not enough, because the same folder can be opened again
and the project then publishes a different Repository. The Repository alone
is not enough, because a project may publish no Repository at all, and then
every identity of that project would compare equal to every other one.

## The generation counter lives on the Workspace

The counter belongs to the Workspace, not to the Project. Opening a folder
replaces the current project, so a counter stored on the Project would be
created again with it and would start at zero; an identity captured before
the switch would then compare equal to a fresh one and the guard would
guard nothing. The counter answers a question about the transition, not
about the project: how many times has this window replaced its project. A
Project cannot answer that, because it is the thing being replaced. The
Workspace is the one object in the model that outlives a project switch, so
it is the one place the count can live.

## One project mutation at a time

A folder open and a branch switch are both mutations of the current
project, and two of them running at once interleave: the second reads
state that the first is halfway through replacing. The Workspace therefore
exposes one busy flag covering both, and a mutation that arrives while
another is running is refused rather than queued.

## Considered Options

- Comparing the root URI only: rejected because reopening the same folder
  produces a different Repository, and a result computed for the old one
  would pass the check.
- Comparing the Project instance: rejected because the Project survives a
  folder change, so it cannot tell one folder from another.
- Cancelling in-flight work when the project changes: rejected because the
  work belongs to the caller and cannot be cancelled from the outside. The
  caller decides what to do with a result it no longer wants, which is why
  the check is a value the caller holds rather than a signal the Workspace
  sends.

## Consequences

- Capture and check are two calls, so every asynchronous path that acts on
  the project carries the identity across its await.
- A folder open that fails leaves the previous project exactly as it was,
  including its documents and its Repository, and reports the reason
  instead of leaving the window half switched.
- Work that is not about the current project, such as writing a file, does
  not need an identity and does not take one.
