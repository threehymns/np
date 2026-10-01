import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADR 0007: no compatibility aliases during initial development.
 * HunkRange lives with the Git commands that consume it; core must not
 * re-export it for old import sites.
 */
describe('ADR 0007 no compatibility alias for HunkRange', () => {
	it('does not re-export HunkRange from core commands', () => {
		const source = readFileSync(join(import.meta.dir, 'commands.svelte.ts'), 'utf-8');
		expect(source).not.toMatch(/export\s+type\s*\{\s*HunkRange\s*\}/);
	});

	it('keeps HunkRange importable from its canonical Git owner', async () => {
		const mod = await import('./plugins/git/commands');
		expect(mod).toHaveProperty('applyHunkAction');
		// Type-only export: verify source declares it (runtime check would be undefined).
		const source = readFileSync(join(import.meta.dir, 'plugins/git/commands.ts'), 'utf-8');
		expect(source).toMatch(/export interface HunkRange/);
	});
});
