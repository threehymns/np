# Bundled feature plugins with a usable basic editor

np will retain a usable basic editor when its optional Core Plugins are disabled, following the user's comparison to Obsidian with its core plugins disabled. Existing optional features will ship with np as Core Plugins rather than require separate installation; which features are independently disableable remains to be decided. This establishes the first implementations of the eventual third-party plugin interfaces without making current features external packages to install.

Git will be a Core Plugin so users can disable its functionality for a lighter experience. Git is the only concrete VCS requirement today; a future provider such as jj is possible, but a generic VCS parent plugin is not a settled requirement.

When Git is disabled, it must not initialize, scan repositories, refresh repository state, or contribute commands, panels, or decorations. Git-specific modules load lazily when enabled, while their files still ship with np. Ordinary folder browsing and `.gitignore` filtering remain available without the Git Plugin. After a live disable, runtime activity and contributions must stop; this does not imply that the JavaScript runtime can evict previously imported modules from memory.

Core Plugins should support both web and desktop where feasible. Platform-specific limitations are allowed and must be explicit; a browser fallback is not required for functionality that cannot reasonably run there.
