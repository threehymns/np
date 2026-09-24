import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock } from 'bun:test';
import { PluginHost } from './host.svelte';
import {
	DuplicatePluginIdError,
	DependencyCycleError,
	MissingDependencyError,
	InterfaceVersionMismatchError,
	UnsupportedPlatformError,
	PluginNotFoundError
} from './errors';
import type { PluginManifest, PluginRegistration } from './types';

describe('PluginHost Skeleton', () => {
	describe('Registration & Duplicate ID Rejection', () => {
		it('registers a plugin and provides manifest metadata', () => {
			const host = new PluginHost();
			const manifest: PluginManifest = {
				id: 'test-plugin',
				name: 'Test Plugin',
				version: 0,
				description: 'A test plugin'
			};

			host.register({ manifest, setup: () => {} });

			expect(host.hasPlugin('test-plugin')).toBe(true);
			expect(host.getManifest('test-plugin')).toEqual(manifest);
			expect(host.getManifests()).toEqual([manifest]);
			expect(host.getPluginState('test-plugin')).toBe('inactive');
		});

		it('rejects duplicate plugin IDs with an actionable error', () => {
			const host = new PluginHost();
			const manifestA: PluginManifest = {
				id: 'duplicate-id',
				name: 'Plugin Alpha',
				version: 0
			};
			const manifestB: PluginManifest = {
				id: 'duplicate-id',
				name: 'Plugin Beta',
				version: 1
			};

			host.register({ manifest: manifestA, setup: () => {} });

			expect(() => {
				host.register({ manifest: manifestB, setup: () => {} });
			}).toThrow(DuplicatePluginIdError);

			try {
				host.register({ manifest: manifestB, setup: () => {} });
			} catch (err: any) {
				expect(err).toBeInstanceOf(DuplicatePluginIdError);
				expect(err.message).toContain('Duplicate plugin ID "duplicate-id" detected');
				expect(err.message).toContain('Plugin Alpha');
				expect(err.message).toContain('Plugin Beta');
				expect(err.message).toContain('Action:');
			}
		});
	});

	describe('Manifest Inspection without Implementation Loading', () => {
		it('reads manifest metadata without invoking lazy plugin loader', async () => {
			const host = new PluginHost();
			let implementationLoaded = false;

			const lazyRegistration: PluginRegistration = {
				manifest: {
					id: 'lazy-plugin',
					name: 'Lazy Plugin',
					version: 0,
					description: 'Does not load implementation early'
				},
				load: async () => {
					implementationLoaded = true;
					return {
						setup: () => {}
					};
				}
			};

			host.register(lazyRegistration);

			// Reading manifest from host
			const manifest = host.getManifest('lazy-plugin');
			expect(manifest).toBeDefined();
			expect(manifest?.name).toBe('Lazy Plugin');
			expect(host.getManifests().length).toBe(1);

			// Assert implementation loader was NEVER called
			expect(implementationLoaded).toBe(false);

			// Now activate and verify it loads
			await host.activate('lazy-plugin');
			expect(implementationLoaded).toBe(true);
			expect(host.isPluginActive('lazy-plugin')).toBe(true);
		});
	});

	describe('Deterministic Activation Order & Dependencies', () => {
		it('activates plugins in topological dependency order', async () => {
			const host = new PluginHost();
			const activationSequence: string[] = [];

			host.register({
				manifest: { id: 'app-shell', name: 'App Shell', version: 0, dependsOn: { 'vcs': 0 } },
				setup: () => {
					activationSequence.push('app-shell');
				}
			});

			host.register({
				manifest: { id: 'git-vcs', name: 'Git VCS', version: 0, provides: { 'vcs': 0 } },
				setup: () => {
					activationSequence.push('git-vcs');
				}
			});

			const order = host.computeActivationOrder();
			expect(order).toEqual(['git-vcs', 'app-shell']);

			await host.activateAll();
			expect(activationSequence).toEqual(['git-vcs', 'app-shell']);
		});

		it('breaks ties deterministically by plugin ID for independent plugins', () => {
			const host = new PluginHost();
			host.register({ manifest: { id: 'zebra', name: 'Zebra', version: 0 }, setup: () => {} });
			host.register({ manifest: { id: 'apple', name: 'Apple', version: 0 }, setup: () => {} });
			host.register({ manifest: { id: 'mango', name: 'Mango', version: 0 }, setup: () => {} });

			const order = host.computeActivationOrder();
			expect(order).toEqual(['apple', 'mango', 'zebra']);
		});

		it('detects dependency cycles and throws DependencyCycleError with an actionable message', () => {
			const host = new PluginHost();
			host.register({
				manifest: { id: 'plugin-a', name: 'Plugin A', version: 0, dependsOn: { 'plugin-b': 0 } },
				setup: () => {}
			});
			host.register({
				manifest: { id: 'plugin-b', name: 'Plugin B', version: 0, dependsOn: { 'plugin-a': 0 } },
				setup: () => {}
			});

			expect(() => host.computeActivationOrder()).toThrow(DependencyCycleError);
			try {
				host.computeActivationOrder();
			} catch (err: any) {
				expect(err).toBeInstanceOf(DependencyCycleError);
				expect(err.message).toContain('dependency cycle detected');
				expect(err.message).toContain('Action:');
			}
		});

		it('rejects activation when a required interface dependency is missing', async () => {
			const host = new PluginHost();
			host.register({
				manifest: { id: 'git', name: 'Git', version: 0, dependsOn: { 'vcs': 0 } },
				setup: () => {}
			});

			await expect(host.activate('git')).rejects.toThrow(MissingDependencyError);
		});

		it('rejects activation when interface version mismatch occurs', async () => {
			const host = new PluginHost();
			host.register({
				manifest: { id: 'git', name: 'Git', version: 0, dependsOn: { 'vcs': 0 } },
				setup: () => {}
			});
			host.register({
				manifest: { id: 'custom-vcs', name: 'Custom VCS', version: 0, provides: { 'vcs': 1 } },
				setup: () => {}
			});

			await expect(host.activate('git')).rejects.toThrow(InterfaceVersionMismatchError);
		});
	});

	describe('Platform Compatibility', () => {
		it('rejects activation of desktop-only plugin on web host', async () => {
			const host = new PluginHost({ platform: 'web' });
			host.register({
				manifest: {
					id: 'desktop-native',
					name: 'Desktop Native',
					version: 0,
					platforms: ['desktop']
				},
				setup: () => {}
			});

			await expect(host.activate('desktop-native')).rejects.toThrow(UnsupportedPlatformError);
		});
	});

	describe('Activation, Disablement, and Disposal Lifecycle', () => {
		it('activates and deactivates a plugin running cleanup on disable', async () => {
			const host = new PluginHost();
			let cleanedUp = false;

			host.register({
				manifest: { id: 'sample', name: 'Sample', version: 0 },
				setup: () => {
					return () => {
						cleanedUp = true;
					};
				}
			});

			await host.activate('sample');
			expect(host.isPluginActive('sample')).toBe(true);
			expect(host.getPluginState('sample')).toBe('active');
			expect(cleanedUp).toBe(false);

			await host.deactivate('sample');
			expect(host.isPluginActive('sample')).toBe(false);
			expect(host.getPluginState('sample')).toBe('inactive');
			expect(cleanedUp).toBe(true);
		});

		it('unloads dependents before dependencies when deactivating (cascade)', async () => {
			const host = new PluginHost();
			const deactivationSequence: string[] = [];

			host.register({
				manifest: { id: 'vcs-provider', name: 'VCS Provider', version: 0, provides: { 'vcs': 0 } },
				setup: () => {
					return () => {
						deactivationSequence.push('vcs-provider');
					};
				}
			});

			host.register({
				manifest: { id: 'git-consumer', name: 'Git Consumer', version: 0, dependsOn: { 'vcs': 0 } },
				setup: () => {
					return () => {
						deactivationSequence.push('git-consumer');
					};
				}
			});

			await host.activateAll();
			expect(host.isPluginActive('vcs-provider')).toBe(true);
			expect(host.isPluginActive('git-consumer')).toBe(true);

			// Disabling vcs-provider should cascade: git-consumer unloads first
			await host.deactivate('vcs-provider');

			expect(deactivationSequence).toEqual(['git-consumer', 'vcs-provider']);
			expect(host.isPluginActive('git-consumer')).toBe(false);
			expect(host.isPluginActive('vcs-provider')).toBe(false);
			expect(host.getDeactivationReason('git-consumer')).toContain('Git Consumer is off because VCS Provider is off');
		});

		it('disposes all active plugins in reverse activation order', async () => {
			const host = new PluginHost();
			const disposalSequence: string[] = [];

			host.register({
				manifest: { id: 'p1', name: 'Plugin 1', version: 0 },
				setup: () => {
					return () => {
						disposalSequence.push('p1');
					};
				}
			});

			host.register({
				manifest: { id: 'p2', name: 'Plugin 2', version: 0 },
				setup: () => {
					return () => {
						disposalSequence.push('p2');
					};
				}
			});

			await host.activateAll();
			await host.dispose();

			expect(disposalSequence).toEqual(['p2', 'p1']);
		});
	});
});
