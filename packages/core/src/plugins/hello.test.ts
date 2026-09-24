import '../../../../tests/contract/rune-setup';
import { describe, it, expect } from 'bun:test';
import { PluginHost } from './host.svelte';
import { helloRegistration } from './hello/registration';
import { manifest as helloManifest } from './hello/manifest';
import { checkManifestFile } from './boundary-check';
import { join } from 'node:path';

describe('Hello Core Plugin Acceptance Contract', () => {
	it('manifest module passes the import-boundary check', () => {
		const manifestPath = join(import.meta.dir, 'hello', 'manifest.ts');
		const result = checkManifestFile(manifestPath);
		expect(result.valid).toBe(true);
		expect(result.violations).toHaveLength(0);
	});

	it('reads hello manifest metadata without loading plugin implementation', async () => {
		const host = new PluginHost();
		host.register(helloRegistration);

		// Manifest is accessible immediately
		const manifest = host.getManifest('hello');
		expect(manifest).toBeDefined();
		expect(manifest?.id).toBe('hello');
		expect(manifest?.name).toBe('Hello');
		expect(manifest?.version).toBe(0);
		expect(manifest?.platforms).toEqual(['web', 'desktop']);

		// The implementation module has not been imported yet
		// We can verify that the plugin is still inactive
		expect(host.isPluginActive('hello')).toBe(false);
		expect(host.getPluginState('hello')).toBe('inactive');
	});

	it('activates and deactivates with its cleanup running on disable', async () => {
		const host = new PluginHost();
		host.register(helloRegistration);

		// 1. Activation
		await host.activate('hello');
		expect(host.isPluginActive('hello')).toBe(true);
		expect(host.getPluginState('hello')).toBe('active');

		// Dynamically import the implementation to inspect state
		const { helloPluginState } = await import('./hello/index');
		expect(helloPluginState.active).toBe(true);
		expect(helloPluginState.activationCount).toBeGreaterThanOrEqual(1);

		// 2. Deactivation / Disablement
		await host.deactivate('hello');
		expect(host.isPluginActive('hello')).toBe(false);
		expect(host.getPluginState('hello')).toBe('inactive');

		// 3. Cleanup running on disable
		expect(helloPluginState.active).toBe(false);
		expect(helloPluginState.deactivationCount).toBeGreaterThanOrEqual(1);

		// 4. Reactivation
		await host.activate('hello');
		expect(host.isPluginActive('hello')).toBe(true);
		expect(helloPluginState.active).toBe(true);

		// 5. Host disposal cleans up
		await host.dispose();
		expect(host.isPluginActive('hello')).toBe(false);
		expect(helloPluginState.active).toBe(false);
	});
});
