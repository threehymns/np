import '../../../../../tests/contract/rune-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import {
	PluginHost,
	lspRegistration,
	type LspServerState,
	type LspServerStatus,
	type LspStatusDetail
} from '@np/core';
import { lspStatusItemView, type LspStatusRowView } from './status-view';

/**
 * The status menu's decisions, with no component in the way (spec #263, ticket
 * #266, ADR 0015).
 *
 * The menu renders `lspStatusItemView`'s output verbatim, so what the item says,
 * how many servers it counts, which entries it offers and which command each one
 * dispatches are all decided here. The last one is the assertion worth the file:
 * a real `PluginHost` registers the plugin's commands, and the menu's ids are
 * compared against what it registered rather than against a copy of the list.
 */

const ALL_STATES: readonly LspServerState[] = ['running', 'starting', 'stopped', 'failed'];

function row(state: LspServerState, overrides: Partial<LspServerStatus> = {}): LspServerStatus {
	return {
		server: 'typescript@/repo',
		descriptorId: 'typescript',
		root: '/repo',
		marker: null,
		state,
		pid: 4242,
		details: [],
		...overrides
	};
}

function rowViewOf(state: LspServerState, overrides: Partial<LspServerStatus> = {}): LspStatusRowView {
	return lspStatusItemView([row(state, overrides)]).rows[0];
}

describe('LSP status item summary', () => {
	it('summarises nothing when no server has started', () => {
		const view = lspStatusItemView([]);
		expect(view.running).toBe(0);
		expect(view.total).toBe(0);
		expect(view.indicator).toBe('bg-muted-foreground/40');
		expect(view.rows).toEqual([]);
		expect(view.empty).toBe(true);
	});

	it('counts a menu where no server is running as amber', () => {
		const view = lspStatusItemView([row('stopped'), row('starting')]);
		expect(view.running).toBe(0);
		expect(view.total).toBe(2);
		expect(view.indicator).toBe('bg-amber-500');
		expect(view.empty).toBe(false);
	});

	it('turns red once a server has failed, and says how many did', () => {
		// A failure the status bar cannot show is a failure only the menu knows
		// about, so red wins over both amber and green: one server failed beside a
		// running one is the case that must not read as healthy.
		const view = lspStatusItemView([row('running'), row('failed')]);
		expect(view.indicator).toBe('bg-destructive');
		expect(view.title).toBe('Language servers: 1 of 2 running, 1 failed');

		const two = lspStatusItemView([row('failed'), row('failed'), row('stopped')]);
		expect(two.indicator).toBe('bg-destructive');
		expect(two.title).toBe('Language servers: 0 of 3 running, 2 failed');
	});

	it('turns green as soon as one of several servers runs', () => {
		const view = lspStatusItemView([row('running'), row('starting')]);
		expect(view.running).toBe(1);
		expect(view.total).toBe(2);
		expect(view.indicator).toBe('bg-emerald-500');
	});

	it('counts every server when they are all running', () => {
		const view = lspStatusItemView([row('running'), row('running')]);
		expect(view.running).toBe(2);
		expect(view.total).toBe(2);
		expect(view.indicator).toBe('bg-emerald-500');
	});

	it('reads as "none running" only when there is no server to count', () => {
		// The button is an icon with a dot, so this tooltip is the only place the
		// numbers are said at all — which is why a stopped server and no server at
		// all have to read differently here.
		expect(lspStatusItemView([]).title).toBe('Language servers: none running');
		expect(lspStatusItemView([row('stopped')]).title).toBe(
			'Language servers: 0 of 1 running'
		);
		expect(lspStatusItemView([row('running'), row('stopped')]).title).toBe(
			'Language servers: 1 of 2 running'
		);
	});
});

describe('LSP status item rows', () => {
	it('names each state and gives each one its own dot', () => {
		const view = lspStatusItemView(ALL_STATES.map((state) => row(state)));
		expect(view.rows.map((entry) => entry.label)).toEqual([
			'running',
			'starting',
			'stopped',
			'failed'
		]);
		expect(view.rows.map((entry) => entry.dot)).toEqual([
			'bg-emerald-500',
			'bg-amber-500 animate-pulse',
			'bg-muted-foreground/50',
			'bg-destructive'
		]);
	});

	it('passes the descriptor, the key and the details slot through untouched', () => {
		const details: LspStatusDetail[] = [{ label: 'memory', value: '412 MiB' }];
		const view = rowViewOf('running', {
			descriptorId: 'svelte-language-server',
			server: 'svelte-language-server@/repo/packages/app',
			details
		});
		expect(view.descriptorId).toBe('svelte-language-server');
		expect(view.server).toBe('svelte-language-server@/repo/packages/app');
		expect(view.details).toEqual(details);
		expect(rowViewOf('running').details).toEqual([]);
	});

	it('says how a server was started only when it was started indirectly', () => {
		expect(rowViewOf('running').title).toBe('typescript@/repo');
		expect(rowViewOf('running', { marker: 'workspace-typescript' }).title).toBe(
			'typescript@/repo (via workspace-typescript)'
		);
	});

	it('spells out the state of any server that is not running', () => {
		// A row is a dot of colour and a name otherwise, which is enough for the
		// state a reader expects and nothing for the ones they have to notice.
		expect(rowViewOf('running').stateNote).toBeNull();
		expect(rowViewOf('starting').stateNote).toBe('starting');
		expect(rowViewOf('stopped').stateNote).toBe('stopped');
		expect(rowViewOf('failed').stateNote).toBe('failed');
	});

	it('offers Stop only while a server may still have a process', () => {
		// A failed start killed its own process before reporting the row, so the
		// entry would be a button that visibly does nothing.
		expect(rowViewOf('running').actions.stop.visible).toBe(true);
		expect(rowViewOf('starting').actions.stop.visible).toBe(true);
		expect(rowViewOf('stopped').actions.stop.visible).toBe(false);
		expect(rowViewOf('failed').actions.stop.visible).toBe(false);
	});

	it('offers Restart for every state, since a restart is how a server comes back', () => {
		for (const state of ALL_STATES) {
			expect(rowViewOf(state).actions.restart.visible).toBe(true);
		}
	});

	it('offers Logs for every state, since a server writes before and after it runs', () => {
		// A failed start is logged before the row appears, and a server that exited
		// left the buffer it exited with, so there is no row whose logs are absent.
		for (const state of ALL_STATES) {
			expect(rowViewOf(state).actions.viewLogs.visible).toBe(true);
		}
	});
});

describe('LSP status item actions', () => {
	it('names every action in the menu', () => {
		const view = lspStatusItemView([row('running')]);
		expect([
			view.rows[0].actions.restart.label,
			view.rows[0].actions.viewLogs.label,
			view.rows[0].actions.stop.label,
			view.actions.restartAll.label,
			view.actions.stopAll.label
		]).toEqual([
			'Restart this server',
			'View Logs',
			'Stop this server',
			'Restart All Servers',
			'Stop All Servers'
		]);
	});

	it('marks only the actions that kill something as destructive', () => {
		const view = lspStatusItemView([row('running')]);
		expect(view.actions.restartAll.destructive).toBe(false);
		expect(view.actions.stopAll.destructive).toBe(true);
		expect(view.rows[0].actions.restart.destructive).toBe(false);
		expect(view.rows[0].actions.viewLogs.destructive).toBe(false);
		expect(view.rows[0].actions.stop.destructive).toBe(true);
	});

	it('offers the whole-item entries only once there is a server to act on', () => {
		// Absent rather than disabled before the first server starts: an entry with
		// nothing to act on is a button that visibly does nothing.
		const empty = lspStatusItemView([]);
		expect(empty.actions.restartAll.visible).toBe(false);
		expect(empty.actions.stopAll.visible).toBe(false);
		expect(empty.bulkVisible).toBe(false);

		// A server the runtime knows is always something a restart can bring back,
		// even once it has stopped for good.
		const stopped = lspStatusItemView([row('stopped')]);
		expect(stopped.actions.restartAll.visible).toBe(true);
		expect(stopped.actions.stopAll.visible).toBe(false);
		expect(stopped.bulkVisible).toBe(true);
	});

	it('hides Stop All once no server has a process left', () => {
		expect(lspStatusItemView([row('running')]).actions.stopAll.visible).toBe(true);
		expect(lspStatusItemView([row('starting')]).actions.stopAll.visible).toBe(true);
		expect(lspStatusItemView([row('running'), row('stopped')]).actions.stopAll.visible).toBe(true);
		expect(lspStatusItemView([row('stopped')]).actions.stopAll.visible).toBe(false);
		expect(lspStatusItemView([row('stopped'), row('failed')]).actions.stopAll.visible).toBe(false);
		expect(lspStatusItemView([]).actions.stopAll.visible).toBe(false);
	});

	it('gives each per-server action the server key it takes as an argument', () => {
		const view = lspStatusItemView([row('running', { server: 'svelte@/repo/app' })]);
		expect(view.rows[0].actions.restart.server).toBe('svelte@/repo/app');
		expect(view.rows[0].actions.viewLogs.server).toBe('svelte@/repo/app');
		expect(view.rows[0].actions.stop.server).toBe('svelte@/repo/app');
		// Whole-item actions take no argument, so the component dispatches none.
		expect(view.actions.restartAll.server).toBeUndefined();
		expect(view.actions.stopAll.server).toBeUndefined();
	});
});

describe('LSP status menu against the registered commands', () => {
	const hosts: PluginHost[] = [];

	afterEach(async () => {
		for (const host of hosts.splice(0)) {
			if (host.isPluginActive('lsp')) await host.deactivate('lsp');
		}
	});

	it('dispatches exactly the commands a real host registered', async () => {
		const host = new PluginHost({ platform: 'desktop' });
		hosts.push(host);
		host.register(lspRegistration);
		await host.activate('lsp');

		// One row, because the menu repeats the per-server commands once per
		// server and this is about which commands it can reach, not how often.
		const view = lspStatusItemView([row('running')]);
		const menuIds = [
			view.actions.restartAll.id,
			view.actions.stopAll.id,
			...view.rows.flatMap((entry) => [
				entry.actions.restart.id,
				entry.actions.viewLogs.id,
				entry.actions.stop.id
			])
		].sort();
		const registeredIds = host
			.getCommands()
			.map((command) => command.id)
			.filter((id) => id.startsWith('lsp.'))
			.sort();

		// Not a copy of the literal list: a rename in the plugin's `commands`
		// module moves both sides together, and only a menu that had drifted off
		// the constants would fail here.
		expect(menuIds).toEqual(registeredIds);
		for (const id of menuIds) {
			expect(host.getCommand(id)).toBeDefined();
		}
	});
});
