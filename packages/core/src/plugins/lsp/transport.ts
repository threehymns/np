import { LSP_TRANSPORT_SERVICE_KEY, type LspTransport } from '../services';
import type { PluginHostInterface } from '../types';

/**
 * Resolves the transport seam (ADR 0019).
 *
 * The service is optional by design, and the absence is the web story: spec
 * #263 puts stdio on desktop and leaves web to a later headless-server spec, so
 * a web build publishes nothing here and the plugin degrades to "no LSP" rather
 * than failing to activate. Resolved per use rather than captured at setup, so
 * an app that publishes the transport after the plugin is active still gets it.
 */
export function resolveLspTransport(host: PluginHostInterface): LspTransport | undefined {
	return host.getService<LspTransport>(LSP_TRANSPORT_SERVICE_KEY);
}
