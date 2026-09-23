# Additive UI contributions over a single command registry

The first UI contribution points are additive sidebar panels and status-bar entries with typed inputs, explicit ordering, and host-controlled mounting. No plugin contribution may suppress another's in the first version; replacement semantics wait for a real conflict to design against.

Commands are registered where they are implemented, not in a central file: each feature module contributes its commands through registry transforms during plugin setup, and the host collects them into one registry. The command palette and menus are views over that registry, with visibility separated from contextual availability. Disabling a plugin removes its commands, palette entries, panels, and status items together through the same disposal path.
