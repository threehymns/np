import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import {
	LSP_LOG_STORE_SERVICE_KEY,
	PluginHost,
	lspRegistration,
	type LspLogKind,
	type LspLogLevel,
	type LspLogStore
} from '@np/core';
import { applyLogsFocus, lspLogFilter, lspLogsView, shortServer, type LspLogsView } from './logs-view';

/**
 * The Logs tab's decisions, over the plugin's real buffers (spec #263, ticket
 * #266, ADR 0019).
 *
 * The store comes from an activated plugin rather than a stub, so the capping and
 * the filtering are the shipped ones: what this file pins is which lines a set
 * of picker selections selects, what the picker calls each server, and what the
 * counter says about a buffer that has discarded lines.
 */

const hosts: PluginHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) {
		if (host.isPluginActive('lsp')) await host.deactivate('lsp');
	}
});

async function startLogs(): Promise<LspLogStore> {
	const host = new PluginHost({ platform: 'desktop' });
	hosts.push(host);
	host.register(lspRegistration);
	await host.activate('lsp');
	const logs = host.getService<LspLogStore>(LSP_LOG_STORE_SERVICE_KEY);
	if (!logs) throw new Error('the plugin published no log store');
	return logs;
}

interface Line {
	readonly server?: string;
	readonly kind?: LspLogKind;
	readonly level?: LspLogLevel;
	readonly message: string;
}

const ROOT = 'typescript@/repo';
const APP = 'typescript@/repo/packages/app';

function append(logs: LspLogStore, ...lines: Line[]): void {
	for (const line of lines) {
		logs.append({
			server: line.server ?? ROOT,
			kind: line.kind ?? 'server',
			level: line.level ?? 'info',
			message: line.message
		});
	}
}

/** Every entry the tab would render, so a filter is asserted by what it selects. */
function messages(view: LspLogsView): string[] {
	return view.entries.map((entry) => entry.message);
}

/** The five lines every filtering case below selects from. */
async function seededStore(): Promise<LspLogStore> {
	const logs = await startLogs();
	append(
		logs,
		{ message: 'root started', level: 'info' },
		{ message: 'root trace', kind: 'protocol', level: 'trace' },
		{ message: 'root error', level: 'error' },
		{ message: 'app started', server: APP, level: 'warn' },
		{ message: 'app error', server: APP, kind: 'protocol', level: 'error' }
	);
	return logs;
}

describe('LSP log filters', () => {
	it('selects the whole buffer when nothing is picked', async () => {
		const logs = await seededStore();
		const view = lspLogsView(logs, lspLogFilter('', '', ''));
		expect(messages(view)).toEqual([
			'root started',
			'root trace',
			'root error',
			'app started',
			'app error'
		]);
		expect(view.empty).toBe(false);
	});

	it('selects one server on its own', async () => {
		const logs = await seededStore();
		expect(messages(lspLogsView(logs, lspLogFilter(APP, '', '')))).toEqual([
			'app started',
			'app error'
		]);
	});

	it('selects one kind on its own', async () => {
		const logs = await seededStore();
		expect(messages(lspLogsView(logs, lspLogFilter('', 'protocol', '')))).toEqual([
			'root trace',
			'app error'
		]);
	});

	it('selects one level on its own', async () => {
		const logs = await seededStore();
		expect(messages(lspLogsView(logs, lspLogFilter('', '', 'error')))).toEqual([
			'root error',
			'app error'
		]);
	});

	it('narrows by all three at once', async () => {
		const logs = await seededStore();
		expect(messages(lspLogsView(logs, lspLogFilter(ROOT, 'server', 'error')))).toEqual([
			'root error'
		]);
	});

	it('selects nothing when the three pickers cannot be satisfied together', async () => {
		const logs = await seededStore();
		const view = lspLogsView(logs, lspLogFilter(ROOT, 'protocol', 'error'));
		expect(view.entries).toEqual([]);
		expect(view.empty).toBe(true);
	});

	it('widens the selection when the level picker is cleared', async () => {
		const logs = await seededStore();
		expect(messages(lspLogsView(logs, lspLogFilter(ROOT, 'server', 'error')))).toEqual([
			'root error'
		]);
		expect(messages(lspLogsView(logs, lspLogFilter(ROOT, 'server', '')))).toEqual([
			'root started',
			'root error'
		]);
	});

	it('widens the selection when the kind picker is cleared', async () => {
		const logs = await seededStore();
		expect(messages(lspLogsView(logs, lspLogFilter('', 'server', 'error')))).toEqual([
			'root error'
		]);
		expect(messages(lspLogsView(logs, lspLogFilter('', '', 'error')))).toEqual([
			'root error',
			'app error'
		]);
	});

	it('widens the selection when the server picker is cleared', async () => {
		const logs = await seededStore();
		expect(messages(lspLogsView(logs, lspLogFilter(ROOT, 'protocol', '')))).toEqual([
			'root trace'
		]);
		expect(messages(lspLogsView(logs, lspLogFilter('', 'protocol', '')))).toEqual([
			'root trace',
			'app error'
		]);
	});

	it('puts the whole buffer back when every picker is cleared', async () => {
		const logs = await seededStore();
		const cleared = lspLogsView(logs, lspLogFilter('', '', ''));
		expect(messages(cleared)).toHaveLength(5);
		expect(cleared.lineCount).toBe('5 lines');
	});
});

describe('LSP log tab summary', () => {
	it('counts one line as one line', async () => {
		const logs = await startLogs();
		append(logs, { message: 'only line' });
		const view = lspLogsView(logs, lspLogFilter('', '', ''));
		expect(view.lineCount).toBe('1 line');
		expect(view.droppedNote).toBeNull();
	});

	it('counts nothing as no lines', async () => {
		const logs = await startLogs();
		const view = lspLogsView(logs, lspLogFilter('', '', ''));
		expect(view.lineCount).toBe('0 lines');
		expect(view.empty).toBe(true);
	});

	it('says how many lines a capped buffer discarded', async () => {
		const logs = await startLogs();
		// More lines than the store's per-server cap, without naming the cap: the
		// store owns that number, and what the tab owes it is a faithful report.
		const written = 1000;
		for (let i = 0; i < written; i++) append(logs, { message: `line ${i}` });

		const dropped = logs.droppedCount;
		expect(dropped).toBeGreaterThan(0);
		const view = lspLogsView(logs, lspLogFilter('', '', ''));
		expect(view.entries).toHaveLength(written - dropped);
		expect(view.lineCount).toBe(`${written - dropped} lines`);
		// A truncated buffer that never mentioned its own drops would read as
		// complete, which is why the counter follows the same revision as the list.
		expect(view.droppedNote).toBe(`${dropped} dropped`);
		expect(view.entries[0].message).toBe(`line ${dropped}`);
	});

	it('offers every server that has a buffer, labelled by its root', async () => {
		const logs = await seededStore();
		expect(lspLogsView(logs, lspLogFilter('', '', '')).serverOptions).toEqual([
			{ value: ROOT, label: '/repo' },
			{ value: APP, label: '/repo/packages/app' }
		]);
	});
});

describe('LSP log tab with no store behind it', () => {
	it('renders an empty tab rather than failing inside the view', () => {
		// A plugin that is not the active owner publishes nothing, and its tab can
		// still be on screen from before it was turned off.
		const view = lspLogsView(undefined, lspLogFilter('', '', ''));
		expect(view.entries).toEqual([]);
		expect(view.serverOptions).toEqual([]);
		expect(view.lineCount).toBe('0 lines');
		expect(view.droppedNote).toBeNull();
		expect(view.empty).toBe(true);
	});
});

describe('LSP log server keys', () => {
	it('shows the root alone, which is what tells two roots apart', () => {
		expect(shortServer('typescript@/repo/packages/app')).toBe('/repo/packages/app');
	});

	it('splits on the first separator, since a path may carry one itself', () => {
		expect(shortServer('typescript@/repo/@generated')).toBe('/repo/@generated');
	});

	it('leaves a key with no root whole rather than dropping it', () => {
		expect(shortServer('typescript')).toBe('typescript');
	});
});

describe('Narrowing the tab to the server a command named', () => {
	/** Nothing has been acted on yet, which is what a freshly mounted tab holds. */
	const UNREAD = -1;

	it('opens on the server the newest request named', () => {
		expect(applyLogsFocus('', { server: ROOT, request: 1 }, UNREAD)).toEqual({
			filter: ROOT,
			adopted: 1
		});
	});

	it('reads a request naming no server as every server', () => {
		// What the palette's argument-free entry means, and what a reader who put
		// the picker back to "All servers" gets back.
		expect(applyLogsFocus(APP, { server: null, request: 3 }, 2)).toEqual({
			filter: '',
			adopted: 3
		});
	});

	it('leaves the picker alone when the request has already been acted on', () => {
		// The ordinary case: a protocol trace writes a line per keystroke, and a tab
		// that re-read the focus on every notification would undo the reader's own
		// choice the moment they made it.
		expect(applyLogsFocus(APP, { server: ROOT, request: 1 }, 1)).toEqual({
			filter: APP,
			adopted: 1
		});
	});

	it('narrows again when the same server is asked for twice', () => {
		const first = applyLogsFocus('', { server: ROOT, request: 1 }, UNREAD);
		const second = applyLogsFocus(APP, { server: ROOT, request: 2 }, first.adopted);
		expect(second).toEqual({ filter: ROOT, adopted: 2 });
	});

	it('leaves the picker alone when there is no store to have asked', () => {
		expect(applyLogsFocus(APP, undefined, UNREAD)).toEqual({ filter: APP, adopted: UNREAD });
	});
});
