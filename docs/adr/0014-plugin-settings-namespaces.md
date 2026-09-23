# Plugin settings live in Zed-aligned namespaces

Plugin settings are declared under plugin-owned namespaces with schemas, defaults, and allowed scopes. Setting names and namespaces follow Zed's conventions wherever they fit, replacing np's current ad-hoc preferences schema. The first scopes are user-level configuration and workspace files; language and profile scopes come later. Resolution is layered with explicit per-setting merge rules and reports provenance alongside effective values.

Settings belonging to a disabled plugin are preserved untouched and never garbage-collected. On re-enablement they validate against the plugin's schema, with diagnostics instead of silent resets. This applies the no-compat rule to interfaces only, never to user data.

The settings UI renders from contribution metadata (schema plus label, description, and control hints). Host settings may be hand-tuned, but no plugin may require custom settings UI in the first version.
