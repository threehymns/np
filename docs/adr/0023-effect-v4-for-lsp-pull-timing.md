# Effect v4 for LSP pull timing

Workspace-pull needs spaced repull, jittered backoff, timeout races, and scoped teardown without hand-rolled `Promise.race`/`setTimeout` races. We depend on core `effect` v4 only (never `@effect/platform`), scoped to `effect-timeouts` + `pull-schedules` with `TestClock` coverage. This trades a core library for deterministic timer tests and one tested implementation of each timing policy.

## Consequences

- Effect interrupts the wait, not the wire: a timed-out pull is still answered and dropped.
- `@np/core` stays Node-global free; time goes through the injectable `Clock`.
