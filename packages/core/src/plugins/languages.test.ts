import '../../../../tests/contract/rune-setup';
import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StreamLanguage, LanguageSupport } from '@codemirror/language';
import { PluginHost } from './host.svelte';
import { svelteLanguageRegistration } from './svelte-language/registration';
import { checkManifestFile } from './boundary-check';
import {
	LanguageSupport as AppLanguageSupport,
	getActiveLanguages,
	syncActiveLanguageDescriptions
} from '../editor/language.svelte';
import { languages as seedTable } from '@codemirror/language-data';
import { HeadlessIconRegistry } from '../editor/icons/headless-registry.svelte';

afterEach(() => {
	// Reset the global snapshot to the seeded base so hosts in different
	// files do not leak contributed languages into each other.
	syncActiveLanguageDescriptions([...seedTable]);
});

function toyLoader() {
	return Promise.resolve(
		new LanguageSupport(
			StreamLanguage.define({
				name: 'toy',
				token(stream) {
					if (stream.match(/hello/)) return 'keyword';
					stream.next();
					return null;
				}
			})
		)
	);
}

describe('Language contribution interface (#205)', () => {
	it('seeds the base from the shared table with no Svelte, replayed from empty', () => {
		const host = new PluginHost();
		const names = host.getLanguages().map((l) => l.name);
		expect(names).toContain('TypeScript');
		expect(names).toContain('Markdown');
		expect(names).toContain('Dockerfile');
		expect(names.find((n) => n.toLowerCase() === 'svelte')).toBeUndefined();
		// Seeded base is host-owned at the lowest priority.
		expect(host.getLanguages().length).toBeGreaterThan(100);
	});

	it('migrates Svelte onto the interface with unchanged filename matching', async () => {
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		await host.activate(svelteLanguageRegistration.manifest.id);
		expect(host.getLanguageForFile('App.svelte')?.name).toBe('svelte');
		expect(AppLanguageSupport.getLanguageForFile('App.svelte')?.name).toBe('svelte');
		// Behaves exactly as before through the new path.
		const desc = host.getLanguageForFile('file.svelte')!;
		const support = await desc.load();
		expect(support).toBeDefined();
		await host.deactivate(svelteLanguageRegistration.manifest.id);
	});

	it('later registrations override earlier ones and record a diagnostic naming both owners', async () => {
		const host = new PluginHost();
		host.register({
			manifest: { id: 'plug-a', name: 'A', version: 0 },
			setup: (h) => {
				h.registerLanguages('plug-a', [{ name: 'ToyA', extensions: ['toyext'], load: toyLoader }]);
			}
		});
		host.register({
			manifest: { id: 'plug-b', name: 'B', version: 0 },
			setup: (h) => {
				h.registerLanguages('plug-b', [{ name: 'ToyB', extensions: ['TOYEXT'], load: toyLoader }]);
			}
		});
		await host.activate('plug-a');
		await host.activate('plug-b');
		// Host folds extension case once, centrally: TOYEXT matches toyext.
		expect(host.getLanguageForFile('file.toyext')?.name).toBe('ToyB');
		expect(host.getLanguageForFile('file.TOYEXT')?.name).toBe('ToyB');
		const conflicts = host.getLanguageConflicts().filter((c) => c.extension === 'toyext');
		expect(conflicts.length).toBeGreaterThanOrEqual(1);
		const last = conflicts[conflicts.length - 1];
		expect(last.previousOwner).toBe('plug-a');
		expect(last.newOwner).toBe('plug-b');
		expect(last.winner).toBe('plug-b');
		await host.deactivate('plug-b');
		// Disabling drops its transforms so the next-latest owner shows through.
		expect(host.getLanguageForFile('file.toyext')?.name).toBe('ToyA');
	});

	it('keeps setup free of eager grammar imports: loader is opaque with dynamic import only', () => {
		const setupSource = readFileSync(join(import.meta.dir, 'svelte-language', 'index.ts'), 'utf-8');
		expect(setupSource).not.toMatch(/^\s*import\s+.*from\s+['"]@replit\/codemirror-lang-svelte['"]/m);
		expect(setupSource).not.toMatch(/^\s*import\s+.*from\s+['"]@codemirror\//m);
		expect(setupSource).toMatch(/import\(['"]@replit\/codemirror-lang-svelte['"]\)/);
		const manifestResult = checkManifestFile(
			join(import.meta.dir, 'svelte-language', 'manifest.ts')
		);
		expect(manifestResult.valid).toBe(true);
	});

	it('deletes the hardcoded Svelte branch and static grammar import from the host path', () => {
		const source = readFileSync(join(import.meta.dir, '..', 'editor', 'language.svelte.ts'), 'utf-8');
		expect(source).not.toMatch(/@replit\/codemirror-lang-svelte/);
		expect(source).not.toMatch(/extraLanguages/);
		expect(source).not.toMatch(/slice\(dot \+ 1\).*svelte/);
	});

	it('registers an inline toy grammar with no npm dependency through the same interface', async () => {
		const host = new PluginHost();
		host.register({
			manifest: { id: 'toy', name: 'Toy', version: 0 },
			setup: (h) => {
				h.registerLanguages('toy', [
					{ name: 'Toy', extensions: ['toy'], load: toyLoader }
				]);
			}
		});
		await host.activate('toy');
		expect(host.getLanguageForFile('note.toy')?.name).toBe('Toy');
		const support = await host.getLanguageForFile('note.toy')!.load();
		expect(support).toBeDefined();
		await host.deactivate('toy');
	});

	it('bumps a language revision counter on every rebuild', async () => {
		const host = new PluginHost();
		const base = host.languageRevision;
		host.registerLanguageTransform('core.languages', (prev) => new Map(prev));
		expect(host.languageRevision).toBeGreaterThan(base);
		const afterTransform = host.languageRevision;
		host.register({
			manifest: { id: 'toy-rev', name: 'ToyRev', version: 0 },
			setup: (h) => {
				h.registerLanguages('toy-rev', [{ name: 'ToyRev', extensions: ['toyrev'], load: toyLoader }]);
			}
		});
		await host.activate('toy-rev');
		expect(host.languageRevision).toBeGreaterThan(afterTransform);
		const afterActivate = host.languageRevision;
		await host.deactivate('toy-rev');
		expect(host.languageRevision).toBeGreaterThan(afterActivate);
	});

	it('replays from empty: remove-one and refresh match a clean build', async () => {
		const build = async () => {
			const h = new PluginHost();
			h.register(svelteLanguageRegistration);
			h.register({
				manifest: { id: 'toy', name: 'Toy', version: 0 },
				setup: (hh) => {
					hh.registerLanguages('toy', [{ name: 'Toy', extensions: ['toy'], load: toyLoader }]);
				}
			});
			await h.activate(svelteLanguageRegistration.manifest.id);
			await h.activate('toy');
			return h;
		};
		const full = await build();
		const fullNames = full.getLanguages().map((l) => l.name).sort();
		await full.deactivate('toy');
		const droppedNames = full.getLanguages().map((l) => l.name).sort();
		const clean = new PluginHost();
		clean.register(svelteLanguageRegistration);
		await clean.activate(svelteLanguageRegistration.manifest.id);
		expect(clean.getLanguages().map((l) => l.name).sort()).toEqual(droppedNames);
		// Refresh mid-session matches a clean build too.
		full.refreshLanguages();
		expect(full.getLanguages().map((l) => l.name).sort()).toEqual(droppedNames);
		expect(fullNames).toContain('Toy');
		await full.deactivate(svelteLanguageRegistration.manifest.id);
		await clean.deactivate(svelteLanguageRegistration.manifest.id);
	});
});

describe('Language disablement fallback and composition (#206)', () => {
	it('degrades open files to plain text with no data loss and restores on re-enable', async () => {
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		await host.activate(svelteLanguageRegistration.manifest.id);
		const content = '<h1>hello</h1>';
		expect(AppLanguageSupport.getLanguageForFile('App.svelte')?.name).toBe('svelte');
		await host.deactivate(svelteLanguageRegistration.manifest.id);
		// Unmapped files resolve to no language; the editor configures an
		// empty language compartment while document content is untouched.
		expect(AppLanguageSupport.getLanguageForFile('App.svelte')).toBeNull();
		expect(content).toBe('<h1>hello</h1>');
		await host.activate(svelteLanguageRegistration.manifest.id);
		expect(AppLanguageSupport.getLanguageForFile('App.svelte')?.name).toBe('svelte');
		await host.deactivate(svelteLanguageRegistration.manifest.id);
	});

	it('reuses per-language decorations through the contributed identity', async () => {
		const { getContributionsForType } = await import('./editor');
		const host = new PluginHost();
		host.register(svelteLanguageRegistration);
		await host.activate(svelteLanguageRegistration.manifest.id);
		host.registerEditorContributions('decor-plugin', [
			{ id: 'svelte-deco', type: 'decoration', extension: [], language: 'svelte' },
			{ id: 'all-deco', type: 'decoration', extension: [] }
		]);
		// Contributed language active: svelte-filtered decoration applies.
		const activeLang = AppLanguageSupport.getLanguageForFile('App.svelte')?.name;
		expect(activeLang).toBe('svelte');
		const withSvelte = getContributionsForType(
			host.getEditorContributions('decoration'),
			'decoration',
			activeLang
		);
		expect(withSvelte.map((e) => e.contribution.id).sort()).toEqual(['all-deco', 'svelte-deco']);
		// Disabled: file degrades to plain text, svelte-filtered decoration drops out.
		await host.deactivate(svelteLanguageRegistration.manifest.id);
		expect(AppLanguageSupport.getLanguageForFile('App.svelte')).toBeNull();
		const plainText = getContributionsForType(
			host.getEditorContributions('decoration'),
			'decoration',
			undefined
		);
		expect(plainText.map((e) => e.contribution.id)).toEqual(['all-deco']);
	});

	it('resolves extensionless names, case-insensitive extensions, and plain text for unknown files', () => {
		expect(AppLanguageSupport.getLanguageForFile('Dockerfile')?.name).toBe('Dockerfile');
		expect(AppLanguageSupport.getLanguageForFile('APP.TS')?.name).toBe('TypeScript');
		expect(AppLanguageSupport.getLanguageForFile('notes.MD')?.name).toBe('Markdown');
		expect(AppLanguageSupport.getLanguageForFile('file.unknown')).toBeNull();
		expect(AppLanguageSupport.getLanguageForFile('Untitled')).toBeNull();
		expect(AppLanguageSupport.getLanguageForFile('LICENSE')).toBeNull();
	});
});

describe('Language registry revision and consumer re-read (#257)', () => {
	it('reflects register and disable in the fenced list, picker, and icon resolution with no restart', async () => {
		const host = new PluginHost();
		const icons = new HeadlessIconRegistry();
		host.attachIconRegistryInternal(icons);
		host.register(svelteLanguageRegistration);
		const pickerNames = () => getActiveLanguages().map((l) => l.name);
		expect(pickerNames().find((n) => n.toLowerCase() === 'svelte')).toBeUndefined();
		const svelteIconBefore = icons.getLanguageIcon('svelte');
		expect(svelteIconBefore).toBeDefined();
		await host.activate(svelteLanguageRegistration.manifest.id);
		// Fenced list (Markdown codeLanguages) reads the same registry.
		expect(getActiveLanguages().find((l) => l.name === 'svelte')).toBeDefined();
		// Picker lists exactly the registered languages.
		expect(pickerNames()).toContain('svelte');
		// Icons keep resolving by language name across the transition.
		expect(icons.getLanguageIcon('svelte')).toBeDefined();
		await host.deactivate(svelteLanguageRegistration.manifest.id);
		expect(getActiveLanguages().find((l) => l.name === 'svelte')).toBeUndefined();
		expect(pickerNames().find((n) => n.toLowerCase() === 'svelte')).toBeUndefined();
		expect(icons.getLanguageIcon('svelte')).toBeDefined();
	});
});
