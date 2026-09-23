# Live plugin activation and shared host interfaces

np will support enabling and disabling plugins without reloading the application. This favors interactive customization over the simpler reload-to-apply lifecycle. The host owns contribution lifetimes and cleanup; disablement during in-flight operations and cleanup failure follow ADR 0009. Live activation does not require evicting imported JavaScript modules from memory.

Core Plugins must use the same documented host interfaces intended for external plugins rather than reach into application internals through privileged shortcuts. Git will test those interfaces as a substantial first implementation. Host interfaces should describe reusable application operations and contribution types, not accumulate Git-specific methods; Git-specific orchestration and semantics remain inside the Git Plugin. This does not require a generic VCS parent plugin or a separate abstraction for every Git operation.
