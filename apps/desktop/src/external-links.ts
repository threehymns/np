/**
 * External links handling for Electron WebContents.
 *
 * Electron-free: the WebContents surface is declared structurally so this
 * module is unit-testable under bun without loading native Electron bindings.
 */

export interface ExternalLinkWebContents {
	setWindowOpenHandler(
		handler: (details: { url: string }) => { action: 'allow' | 'deny' }
	): void;
	on(
		event: 'will-navigate',
		listener: (event: { preventDefault(): void }, url: string) => void
	): void;
}

export type ExternalLinkOpener = (url: string) => Promise<unknown> | unknown;

export interface ExternalLinkOptions {
	/**
	 * Local dev server URL (e.g. process.env.ELECTRON_DEV_URL).
	 * Navigations matching this base are internal and allowed.
	 */
	readonly devUrl?: string;
	/**
	 * Function used to open the URL in the system browser (e.g. `shell.openExternal`).
	 */
	readonly openExternal: ExternalLinkOpener;
}

/**
 * Checks whether a URL is an external link (http, https, mailto) that
 * should be opened in the system default browser rather than an Electron window.
 */
export function isExternalUrl(rawUrl: string): boolean {
	if (!rawUrl || typeof rawUrl !== 'string') return false;
	try {
		const parsed = new URL(rawUrl);
		return (
			parsed.protocol === 'http:' ||
			parsed.protocol === 'https:' ||
			parsed.protocol === 'mailto:'
		);
	} catch {
		return false;
	}
}

function parseOrigin(rawUrl: string): string | null {
	try {
		const parsed = new URL(rawUrl);
		return parsed.origin !== 'null' ? parsed.origin : null;
	} catch {
		return null;
	}
}

/**
 * Configures an Electron WebContents instance so that all external links
 * (via target="_blank", window.open, or in-page navigation) open in the
 * system default browser instead of creating a new Electron window or
 * navigating the main window away from the application.
 */
export function attachExternalLinkHandlers(
	contents: ExternalLinkWebContents,
	options: ExternalLinkOptions
): void {
	const opener = options.openExternal;
	const devUrl = options.devUrl;
	const devOrigin = devUrl ? parseOrigin(devUrl) : null;

	// Intercept target="_blank" and window.open calls
	contents.setWindowOpenHandler(({ url }) => {
		if (isExternalUrl(url)) {
			void opener(url);
		}
		// Always deny creating a new Electron BrowserWindow
		return { action: 'deny' };
	});

	// Intercept standard in-page navigation (<a href="..." target="_self">)
	contents.on('will-navigate', (event, url) => {
		if (devOrigin) {
			const navOrigin = parseOrigin(url);
			if (navOrigin !== null && navOrigin === devOrigin) {
				return;
			}
		}

		event.preventDefault();
		if (isExternalUrl(url)) {
			void opener(url);
		}
	});
}
