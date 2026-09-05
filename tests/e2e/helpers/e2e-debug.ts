import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared e2e helpers for quiet-by-default runs (issue #62).
 *
 * Normal `bun run test:e2e` runs are quiet: browser console output is
 * dropped. Set `E2E_DEBUG=1` (or run `bun run test:e2e:debug`) to forward
 * browser console messages and node-side debug logs to stdout.
 *
 * EDITOR_READY_TIMEOUT is calibrated: fast enough to fail red runs quickly,
 * while leaving sufficient headroom for dev-server cold boot under load.
 */

export const EDITOR_READY_TIMEOUT = 15_000;

export function isE2EDebug(): boolean {
	return !!process.env.E2E_DEBUG;
}

export const test = base.extend({
	page: async ({ page }, use) => {
		if (isE2EDebug()) {
			page.on('console', (msg) => {
				console.log('BROWSER:', msg.type(), msg.text());
			});
		}
		await use(page);
	},
});

export { expect, type Page };
