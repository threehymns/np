# Disablement semantics for in-flight operations and plugin state

Disabling a plugin is a request, not a guaranteed instant teardown. Disabling is only accepted while the host is running normally; it is rejected during shutdown. When disabling a plugin, the host stops admitting new operations, cancels background reads where cancellation is supported, lets active writes finish, and then runs cleanup. If an active write prevents completion, the host reports disablement as blocked rather than success or termination. A visible disabling state distinguishes the request from completion.

Plugin preferences and other persisted plugin data survive disablement and re-enablement. The host does not let plugins refuse disablement. Plugin-owned views close during disablement; retaining unsaved view state is a future refinement rather than an initial requirement.

Enablement is an application-level configuration value, applied in each window; per-workspace or per-directory overrides belong to the future workspace configuration model and are not part of the initial plugin host. Runtime resources are scoped to their actual owner, such as a workspace or window, independent of the enablement decision's scope.
