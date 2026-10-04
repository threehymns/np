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
		expect(view.count).toBeNull();
		expect(view.rows).toEqual([]);
		expect(view.empty).toBe(true);
	});

	it('counts a menu where no server is running as amber', () => {
		const view = lspStatusItemView([row('stopped'), row('failed')]);
		expect(view.running).toBe(0);
		expect(view.total).toBe(2);
		expect(view.indicator).toBe('bg-amber-500');
		expect(view.count).toBe('0/2');
		expect(view.empty).toBe(false);
	});

	it('turns green as soon as one of several servers runs', () => {
		const view = lspStatusItemView([row('running'), row('starting')]);
		expect(view.running).toBe(1);
		expect(view.indicator).toBe('bg-emerald-500');
		expect(view.count).toBe('1/2');
	});

	it('counts every server when they are all running', () => {
		const view = lspStatusItemView([row('running'), row('running')]);
		expect(view.running).toBe(2);
		expect(view.count).toBe('2/2');
	});

	it('reads as "none running" only when there is no server to count', () => {
		// A stopped server is not the same claim as no server at all, so the
		// wording has to differ as well as the number.
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

	it('offers Stop for a stopped server only as something it cannot do', () => {
		for (const state of ALL_STATES) {
			expect(rowViewOf(state).actions.stop.disabled).toBe(state === 'stopped');
		}
	});

	it('offers Restart for every state, since a restart is how a server comes back', () => {
		for (const state of ALL_STATES) {
			expect(rowViewOf(state).actions.restart.disabled).toBe(false);
		}
	});
});

describe('LSP status item actions', () => {
	it('names every action in the menu', () => {
		const view = lspStatusItemView([row('running')]);
		expect([
			view.rows[0].actions.restart.label,
			view.rows[0].actions.stop.label,
			view.actions.restartAll.label,
			view.actions.stopAll.label,
			view.actions.viewLogs.label
		]).toEqual([
			'Restart this server',
			'Stop this server',
			'Restart All Servers',
			'Stop All Servers',
			'View Logs'
		]);
	});

	it('marks only the actions that kill something as destructive', () => {
		const view = lspStatusItemView([row('running')]);
		expect(view.actions.restartAll.destructive).toBe(false);
		expect(view.actions.stopAll.destructive).toBe(true);
		expect(view.actions.viewLogs.destructive).toBe(false);
		expect(view.rows[0].actions.restart.destructive).toBe(false);
		expect(view.rows[0].actions.stop.destructive).toBe(true);
	});

	it('disables the whole-item lifecycle actions when there is no server', () => {
		const view = lspStatusItemView([]);
		expect(view.actions.restartAll.disabled).toBe(true);
		expect(view.actions.stopAll.disabled).toBe(true);
		// Logs stay reachable: a server that has already exited is exactly when
		// there is something to read.
		expect(view.actions.viewLogs.disabled).toBe(false);
	});

	it('enables the whole-item lifecycle actions as soon as one server exists', () => {
		const view = lspStatusItemView([row('stopped')]);
		expect(view.actions.restartAll.disabled).toBe(false);
		expect(view.actions.stopAll.disabled).toBe(false);
	});

	it('gives each per-server action the server key it takes as an argument', () => {
		const view = lspStatusItemView([row('running', { server: 'svelte@/repo/app' })]);
		expect(view.rows[0].actions.restart.server).toBe('svelte@/repo/app');
		expect(view.rows[0].actions.stop.server).toBe('svelte@/repo/app');
		// Whole-item actions take no argument, so the component dispatches none.
		expect(view.actions.restartAll.server).toBeUndefined();
		expect(view.actions.stopAll.server).toBeUndefined();
		expect(view.actions.viewLogs.server).toBeUndefined();
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
			view.actions.viewLogs.id,
			...view.rows.flatMap((entry) => [entry.actions.restart.id, entry.actions.stop.id])
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
