import type { Page } from '@playwright/test';

/**
 * Diff-load instrumentation for the Diff Viewer e2e specs.
 *
 * The specs have to tell "the reload has not happened yet" from "the reload
 * has happened and the pane has caught up". The app exposes no such signal,
 * so the specs count the adapter's diff loads instead.
 *
 * `__getFileDiffCalls` counts SETTLED loads: a load that has only started
 * carries no diff data yet, and a load that FAILED still finished - the
 * viewer fell back to an empty snapshot, which the spec has to see as "the
 * reload happened". `__getFileDiffInFlight` counts the loads still running,
 * so a spec can take a baseline that no earlier load can still change.
 */
export async function installDiffLoadCounter(page: Page): Promise<void> {
	await page.evaluate(() => {
		const adapter = (window as any).appState.workspace.project.repository.adapter;
		(window as any).__getFileDiffCalls = 0;
		(window as any).__getFileDiffInFlight = 0;
		const original = adapter.getFileDiff.bind(adapter);
		adapter.getFileDiff = async (...args: any[]) => {
			(window as any).__getFileDiffInFlight += 1;
			try {
				return await original(...args);
			} finally {
				(window as any).__getFileDiffInFlight -= 1;
				(window as any).__getFileDiffCalls += 1;
			}
		};
	});
}

/**
 * The number of settled diff loads, taken while the app is idle.
 *
 * The baseline has to be taken when no load is running: a load that settles
 * after the baseline was taken would look like the reload the spec is
 * waiting for. Two idle frames in a row mean no load is running and the
 * count is not moving.
 */
export async function settledDiffCallCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const calls = (window as any).__getFileDiffCalls;
			const inFlight = (window as any).__getFileDiffInFlight;
			await frame();
			await frame();
			if (
				inFlight === 0 &&
				(window as any).__getFileDiffInFlight === 0 &&
				(window as any).__getFileDiffCalls === calls
			) {
				return calls;
			}
		}
		return (window as any).__getFileDiffCalls;
	});
}

/**
 * Wait for the next settled diff load, then let the pane apply it.
 *
 * The wait ends when a load has settled and the app is quiet again: a
 * reload can queue more than one load, and the last one is the snapshot
 * the pane shows. The snapshot reaches the pane through a Svelte effect
 * and lands in the DOM on the next paint, so the wait ends with two
 * animation frames instead of a fixed timeout: the spec reads the pane
 * only once the fresh diff data is on screen.
 */
export async function waitForDiffReload(page: Page, callsBefore: number): Promise<void> {
	await page.waitForFunction(
		(n: number) =>
			(window as any).__getFileDiffCalls > n && (window as any).__getFileDiffInFlight === 0,
		callsBefore,
		{ timeout: 20_000 }
	);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}
