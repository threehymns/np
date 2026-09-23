# Interface versions stay frozen while all plugins are first-party

Plugin and host interface versions are exact-match integers starting at 0. While every plugin ships with np, versions do not increment: breaking a host or plugin-to-plugin interface means updating the bundled plugins in the same change instead. Version checking activates with third-party plugins, when a mismatch refuses activation with an actionable error naming both sides and the required update.

Dependency failures cascade visibly in the plugin settings page: disabling an interface deactivates its dependents with an explanation ("Git is off because VCS is off"), dependents unload before the interfaces they consume, and re-enabling a dependency never auto-enables the dependent. The dependency graph is cycle-checked at startup with the same actionable-error treatment. The PluginHost surface carries one version; plugin-to-plugin interfaces version independently per feature.
