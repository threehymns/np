# Trusted in-process plugins

np will support trusted plugins running in-process rather than require a sandboxed plugin runtime. The priority is broad application and UI customization while the project has no users; this accepts that plugin code shares the privileges and failure risks of its host process. Plugin interfaces and lifecycle cleanup are organizational contracts, not security isolation.
