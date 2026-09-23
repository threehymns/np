# No plugin backwards compatibility during initial development

During initial development, np will change plugin interfaces directly rather than preserve compatibility with older interfaces. The project has no users, and the user prefers updating plugins with AI assistance over maintaining compatibility aliases, adapters, or parallel interface versions. Bundled plugins must be updated alongside interface changes, and detected incompatibilities must produce actionable, copyable diagnostics that identify the mismatch and explain the required update where known.

This decision does not require older plugins to keep working or authorize silent acceptance of incompatible inputs. If maintaining compatibility becomes worthwhile, supersede this ADR with an explicit compatibility policy rather than introducing shims incrementally.
