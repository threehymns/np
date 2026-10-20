# A result that arrives after the Project's identity changed is discarded

Asynchronous work that acts on the current Project captures that Project's
identity before it waits, and is discarded when the identity no longer
matches when it resumes, because a session restore, a branch safety preflight
or a branch switch that resolves after the user has opened a different Root
must never be applied to the Project that is open now.

## What the identity is

An identity is three things taken together: the URI of the Root the Project
is opened on, the Repository instance the Project publishes, and a generation
counter. The Root URI alone is not enough, because the same Root can be
opened again and the Project then publishes a different Repository. The
Repository alone is not enough, because a Project may publish no Repository at
all, and then every identity of that Project would compare equal to every
other one.

## Opening a Root does not replace the Project

Opening a Root replaces the Root the Project is opened on and the Repository
the Project publishes; the Project itself survives, because one Workspace
holds one Project and the open path rewrites that Project in place. The
outgoing Repository is dropped before the asynchronous probe, so the window
never shows stale branch or change state for the Root that is going away.
Making opening additive, with a held list of Projects, is separate work.

## The generation counter lives on the Workspace

The counter belongs to the Workspace, not to the Project. It answers a
question about the transition rather than about the Project: how many times
has this window changed the Root its Project is opened on. The Project cannot
answer that, because a Project is a store: it holds a Root, a Repository and
its worktrees, and nothing in it observes that the Root was replaced. The
Workspace is what runs the open, so it is the only object that can count the
opens.

## One Project mutation at a time

A Root open and a branch switch are both mutations of the current Project,
and two of them running at once interleave: the second reads state that the
first is halfway through writing. The Workspace therefore exposes one busy
flag covering both, and a mutation that arrives while another is running is
refused rather than queued.

## Considered Options

- Comparing the Root URI only: rejected because reopening the same Root
  produces a different Repository, and a result computed for the old one
  would pass the check.
- Comparing the Project instance: rejected because the Project survives a
  Root change, so it cannot tell one Root from another.
- Cancelling in-flight work when the Project changes: rejected because the
  work belongs to the caller and cannot be cancelled from the outside. The
  caller decides what to do with a result it no longer wants, which is why
  the check is a value the caller holds rather than a signal the Workspace
  sends.

## Consequences

- Capture and check are two calls, so every asynchronous path that acts on
  the Project carries the identity across its await.
- A Root open that fails leaves the previous Project exactly as it was,
  including its documents, its Repository and its settings, leaves the recent
  folders list as it was, and reports the reason instead of leaving the
  window half switched.
- Work that is not about the current Project, such as writing a file, does
  not need an identity and does not take one.
