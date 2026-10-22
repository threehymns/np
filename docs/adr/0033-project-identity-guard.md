# Project identity guard for asynchronous operations

Asynchronous operations acting on the current project capture the project's identity before awaiting external tasks, discarding results if the identity changed before the operation resumes. This prevents branch switches, safety preflights, or session restores from applying to a newly opened root directory.

Project identity combines the root URI, the published `Repository` instance, and a workspace generation counter. Comparing the root URI alone is insufficient because reopening the same directory creates a distinct repository instance. Comparing the `Project` object is insufficient because the workspace updates the existing project in place. The workspace increments the generation counter on each root transition.

The workspace enforces mutual exclusion over project-level mutations. Root opens and branch switches share a single busy guard that rejects concurrent mutations rather than queuing interleaved operations.
