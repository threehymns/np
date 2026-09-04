import type { Page } from '@playwright/test';

/**
 * Shared e2e helpers for quiet-by-default runs (issue #62).
 *
 * Normal `bun run test:e2e` runs are quiet: browser console output is
 * dropped. Set `E2E_DEBUG=1` (or run `bun run test:e2e:debug`) to forward
 * browser console messages and node-side debug logs to stdout.
 *
 * EDITOR_READY_TIMEOUT is calibrated, not arbitrary: cold dev-server boots
 * measured 13-18s per spec under parallel load in constrained environments,
 * so 20s stays green there while a genuinely missing editor still fails at
 * 20s instead of the old 30s-plus-retry (~60s) per spec.
 */

export const EDITOR_READY_TIMEOUT = 20_000;

export function isE2EDebug(): boolean {
	return !!process.env.E2E_DEBUG;
}

export function forwardBrowserConsole(page: Page): void {
	if (!isE2EDebug()) return;
	page.on('console', (msg) => {
		console.log('BROWSER:', msg.type(), msg.text());
	});
}

export function debugLog(...args: unknown[]): void {
	if (isE2EDebug()) console.log(...args);
}
