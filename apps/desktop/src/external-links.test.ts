import { describe, expect, it, mock } from 'bun:test';
import {
	isExternalUrl,
	attachExternalLinkHandlers,
	type ExternalLinkWebContents
} from './external-links';

describe('external-links', () => {
	describe('isExternalUrl', () => {
		it('identifies http, https, and mailto URLs as external', () => {
			expect(isExternalUrl('https://typescript.tv/errors/#TS2322')).toBe(true);
			expect(isExternalUrl('http://example.com/page')).toBe(true);
			expect(isExternalUrl('mailto:developer@example.com')).toBe(true);
		});

		it('rejects internal protocols, local files, and invalid URLs', () => {
			expect(isExternalUrl('file:///home/user/project/index.html')).toBe(false);
			expect(isExternalUrl('about:blank')).toBe(false);
			expect(isExternalUrl('data:text/html,hello')).toBe(false);
			expect(isExternalUrl('blob:http://localhost/uuid')).toBe(false);
			expect(isExternalUrl('/relative/path/to/doc')).toBe(false);
			expect(isExternalUrl('')).toBe(false);
			expect(isExternalUrl(null as any)).toBe(false);
			expect(isExternalUrl(undefined as any)).toBe(false);
		});
	});

	describe('attachExternalLinkHandlers', () => {
		it('intercepts window.open / target="_blank" and opens external URLs via openExternal while denying new Electron windows', () => {
			let openHandler: ((details: { url: string }) => { action: string }) | null = null;
			const mockWebContents: ExternalLinkWebContents = {
				setWindowOpenHandler: (handler: any) => {
					openHandler = handler;
				},
				on: () => {}
			};

			const openedUrls: string[] = [];
			const mockOpener = mock(async (url: string) => {
				openedUrls.push(url);
			});

			attachExternalLinkHandlers(mockWebContents, { openExternal: mockOpener });
			expect(openHandler).not.toBeNull();

			// External link (e.g. from diagnostic tooltip or markdown)
			const verdict = openHandler!({ url: 'https://typescript.tv/errors/#TS2322' });
			expect(verdict).toEqual({ action: 'deny' });
			expect(openedUrls).toEqual(['https://typescript.tv/errors/#TS2322']);

			// Non-external URL
			const internalVerdict = openHandler!({ url: 'file:///local/file.txt' });
			expect(internalVerdict).toEqual({ action: 'deny' });
			expect(openedUrls.length).toBe(1); // not called again
		});

		it('intercepts in-page navigation (will-navigate) for external URLs and prevents Electron from navigating away', () => {
			const listeners = new Map<string, Function>();
			const mockWebContents: ExternalLinkWebContents = {
				setWindowOpenHandler: () => {},
				on: (event: string, listener: Function) => {
					listeners.set(event, listener);
				}
			};

			const openedUrls: string[] = [];
			const mockOpener = mock(async (url: string) => {
				openedUrls.push(url);
			});

			attachExternalLinkHandlers(mockWebContents, {
				devUrl: 'http://localhost:5173',
				openExternal: mockOpener
			});

			const willNavigate = listeners.get('will-navigate');
			expect(willNavigate).toBeDefined();

			// 1. External navigation: should prevent default and open externally
			let prevented = false;
			const event = {
				preventDefault: () => {
					prevented = true;
				}
			};
			willNavigate!(event, 'https://ts-error-translator.vercel.app/?error=2322');
			expect(prevented).toBe(true);
			expect(openedUrls).toEqual(['https://ts-error-translator.vercel.app/?error=2322']);

			// 2. Dev server navigation: should NOT prevent default or open externally
			prevented = false;
			willNavigate!(event, 'http://localhost:5173/subpage');
			expect(prevented).toBe(false);
			expect(openedUrls.length).toBe(1); // unchanged
		});
	});
});
