import '../../../../tests/contract/rune-setup';
import { describe, it, expect } from 'bun:test';
import { CommandRegistry } from '../commands.svelte';
import { PluginHost } from './host.svelte';
import {
	CORE_COMMANDS_OWNER,
	DuplicateCommandIdError,
	createAddCommandsTransform,
	rebuildCommands,
	type PluginCommand
} from './commands';

function makeCommand(id: string, category = 'Test', extra: Partial<PluginCommand> = {}): PluginCommand {
	return {
		id,
		label: id,
		category,
		action: () => id,
		...extra
	};
}

function idsOf(commands: readonly { id: string }[]): string[] {
	return commands.map((c) => c.id);
}

describe('Command registry on transforms (#196)', () => {
	describe('pure replay', () => {
		it('replays transforms in order from an empty initial value', () => {
			const built = rebuildCommands([
				{ pluginId: 'a', transform: createAddCommandsTransform([makeCommand('a.one')]) },
				{ pluginId: 'b', transform: createAddCommandsTransform([makeCommand('b.one')]) }
			]);
			expect([...built.keys()]).toEqual(['a.one', 'b.one']);
		});

		it('removing one plugin yields the same registry as a clean build without it', () => {
			const full = [
				{ pluginId: 'alpha', transform: createAddCommandsTransform([makeCommand('alpha.one'), makeCommand('alpha.two')]) },
				{ pluginId: 'beta', transform: createAddCommandsTransform([makeCommand('beta.one')]) },
				{ pluginId: 'gamma', transform: createAddCommandsTransform([makeCommand('gamma.one')]) }
			];
			const withoutBeta = full.filter((entry) => entry.pluginId !== 'beta');
			const clean = rebuildCommands([
				{ pluginId: 'alpha', transform: createAddCommandsTransform([makeCommand('alpha.one'), makeCommand('alpha.two')]) },
				{ pluginId: 'gamma', transform: createAddCommandsTransform([makeCommand('gamma.one')]) }
			]);

			expect([...rebuildCommands(withoutBeta).keys()]).toEqual([...clean.keys()]);
		});

		it('rejects cross-plugin duplicate command IDs with an actionable error', () => {
			const build = () =>
				rebuildCommands([
					{ pluginId: 'one', transform: createAddCommandsTransform([makeCommand('shared.id')]) },
					{ pluginId: 'two', transform: createAddCommandsTransform([makeCommand('shared.id')]) }
				]);
			expect(build).toThrow(DuplicateCommandIdError);
			try {
				build();
			} catch (err: any) {
				expect(err).toBeInstanceOf(DuplicateCommandIdError);
				expect(err.message).toContain('shared.id');
				expect(err.message).toContain('Action:');
			}
		});

		it('allows same-plugin re-registration with last-wins (refresh with fresh closures)', () => {
			const first = makeCommand('refresh.me');
			const second = makeCommand('refresh.me');
			const built = rebuildCommands([
				{ pluginId: 'owner', transform: createAddCommandsTransform([first]) },
				{ pluginId: 'owner', transform: createAddCommandsTransform([second]) }
			]);
			expect(built.get('refresh.me')).toBe(second);
		});
	});

	describe('standalone CommandRegistry', () => {
		it('has no append-only register path', () => {
			const registry = new CommandRegistry();
			expect('register' in registry).toBe(false);
		});

		it('removePlugin rebuilds to the clean-build result', () => {
			const registry = new CommandRegistry();
			registry.registerCommands('alpha', [makeCommand('alpha.one'), makeCommand('alpha.two')]);
			registry.registerCommands('beta', [makeCommand('beta.one')]);

			const clean = new CommandRegistry();
			clean.registerCommands('alpha', [makeCommand('alpha.one'), makeCommand('alpha.two')]);

			registry.removePlugin('beta');
			expect(idsOf(registry.getAll())).toEqual(idsOf(clean.getAll()));
		});

		it('refresh-mid-session rebuilds with no duplicates or losses', () => {
			const registry = new CommandRegistry();
			registry.registerCommands('alpha', [makeCommand('alpha.one', 'File'), makeCommand('alpha.two', 'Edit')]);
			registry.registerCommands('beta', [makeCommand('beta.one', 'File')]);

			const before = idsOf(registry.getAll());
			registry.refresh();
			registry.rebuild();
			registry.refresh();
			expect(idsOf(registry.getAll())).toEqual(before);
			expect(new Set(before).size).toBe(before.length);
		});

		it('keeps palette and menu views working (get/getAll/getByCategory/execute)', () => {
			const registry = new CommandRegistry();
			let ran = '';
			registry.registerCommands('alpha', [
				makeCommand('file.new', 'File', { action: () => (ran = 'new') }),
				makeCommand('edit.gated', 'Edit', { action: () => (ran = 'gated'), isEnabled: () => false })
			]);

			expect(registry.get('file.new')?.label).toBe('file.new');
			expect(idsOf(registry.getByCategory('File'))).toEqual(['file.new']);
			registry.execute('file.new');
			expect(ran).toBe('new');
			registry.execute('edit.gated');
			expect(ran).toBe('new');
			expect(registry.execute('missing.id')).toBeUndefined();
		});
	});

	describe('host-owned registry lifecycle', () => {
		function pluginWithCommands(id: string, commands: PluginCommand[]) {
			return {
				manifest: { id, name: id, version: 0 },
				setup: (host: any) => {
					host.registerCommands(id, commands);
				}
			};
		}

		it('deactivating one plugin yields the same registry as a clean build without it', async () => {
			const host = new PluginHost();
			host.register(pluginWithCommands('alpha', [makeCommand('alpha.one'), makeCommand('alpha.two')]));
			host.register(pluginWithCommands('beta', [makeCommand('beta.one')]));
			await host.activateAll();
			expect(idsOf(host.getCommands()).sort()).toEqual(['alpha.one', 'alpha.two', 'beta.one']);

			await host.deactivate('beta');
			expect(idsOf(host.getCommands()).sort()).toEqual(['alpha.one', 'alpha.two']);
			expect(host.getCommand('beta.one')).toBeUndefined();

			const clean = new PluginHost();
			clean.register(pluginWithCommands('alpha', [makeCommand('alpha.one'), makeCommand('alpha.two')]));
			await clean.activateAll();
			expect(idsOf(host.getCommands())).toEqual(idsOf(clean.getCommands()));
		});

		it('unregistering a plugin rebuilds without its commands', async () => {
			const host = new PluginHost();
			host.register(pluginWithCommands('alpha', [makeCommand('alpha.one')]));
			host.register(pluginWithCommands('beta', [makeCommand('beta.one')]));
			await host.activateAll();

			await host.unregister('beta');
			expect(host.getCommand('beta.one')).toBeUndefined();
			expect(idsOf(host.getCommands())).toEqual(['alpha.one']);
		});

		it('refresh-mid-session rebuilds with no duplicates or losses', async () => {
			const host = new PluginHost();
			host.register(pluginWithCommands('alpha', [makeCommand('alpha.one', 'File')]));
			host.register(pluginWithCommands('beta', [makeCommand('beta.one', 'File')]));
			await host.activateAll();

			const before = idsOf(host.getCommands());
			host.refreshCommands();
			host.rebuildCommands();
			host.refreshCommands();
			expect(idsOf(host.getCommands())).toEqual(before);
			expect(idsOf(host.getCommandsByCategory('File')).sort()).toEqual(['alpha.one', 'beta.one']);
		});

		it('core commands stay while plugin commands come and go', async () => {
			const host = new PluginHost();
			host.registerCommands(CORE_COMMANDS_OWNER, [makeCommand('file.new', 'File')]);
			host.register(pluginWithCommands('extra', [makeCommand('extra.run', 'File')]));
			await host.activateAll();

			expect(idsOf(host.getCommandsByCategory('File')).sort()).toEqual(['extra.run', 'file.new']);
			await host.deactivate('extra');
			expect(idsOf(host.getCommandsByCategory('File'))).toEqual(['file.new']);
			host.refreshCommands();
			expect(idsOf(host.getCommandsByCategory('File'))).toEqual(['file.new']);
		});

		it('a rejected duplicate registration leaves no wedged entry behind', async () => {
			const host = new PluginHost();
			host.register(pluginWithCommands('alpha', [makeCommand('shared.id')]));
			await host.activateAll();
			const before = idsOf(host.getCommands());

			expect(() => host.registerCommands('beta', [makeCommand('shared.id')])).toThrow(
				DuplicateCommandIdError
			);
			// Failed registration is atomic: the bad entry is dropped.
			expect(idsOf(host.getCommands())).toEqual(before);
			host.rebuildCommands();
			expect(idsOf(host.getCommands())).toEqual(before);

			await host.deactivate('alpha');
			expect(host.getCommand('shared.id')).toBeUndefined();
		});
	});
});
