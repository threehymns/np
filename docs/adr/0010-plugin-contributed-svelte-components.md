# Plugins contribute Svelte components hosted by the application

Plugins may contribute real Svelte components rather than data-only view models. The host controls where contributions render and how long they live; plugin components receive application services through the existing Svelte context-injection pattern rather than importing application internals directly. Component teardown on disablement follows ADR 0009: views close, persisted data survives, and plugins cannot veto disablement.
