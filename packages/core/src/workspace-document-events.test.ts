import "../../../tests/contract/rune-setup";
import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { createMockStorage } from "../../../tests/mock-storage";
import { MemorySessionPersistence, type SerializedDocument } from "./persistence";
import { PluginHost } from "./plugins/host.svelte";
import type { VCSAdapter } from "./project/vcs";
import type { FileOrigin } from "./storage";
import type { Workspace } from "./workspace.svelte";

/**
 * `document:opened` and `document:changed` (ADR 0013).
 *
 * These are new generic host surface — the whole of it, since the event names are
 * the host's only mention of documents opening and changing — so they are
 * asserted here rather than through the one plugin that consumes them. A consumer
 * of the LSP plugin's own behaviour is covered in the plugin's suite; what is
 * missing and is covered here is the *contract*: an untitled document, a file
 * opened from disk and a restored session all announce themselves; a keystroke
 * announces the new text; an edit that changes nothing says nothing; and no
 * observer can veto or fail any of it (ADR 0013's rule, which for an observer is
 * that its opinion has nowhere to go).
 */

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({ SvelteMap: Map, SvelteSet: Set }));
});

let WorkspaceClass: typeof import("./workspace.svelte").Workspace;
beforeAll(async () => {
	WorkspaceClass = (await import("./workspace.svelte")).Workspace;
});

const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };
const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/a.ts', name: 'a.ts' };

function makeVcsFactory(): () => VCSAdapter {
	return () => ({}) as VCSAdapter;
}

interface Harness {
	readonly ws: Workspace;
	readonly opened: unknown[];
	readonly changed: Array<{ content: string; path: string | null }>;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()!();
});

/** A workspace wired to a real plugin host that records the two events. */
async function makeWorkspace(
	persistence = new MemorySessionPersistence(),
	diskContent = 'export const a = 1;\n'
): Promise<Harness> {
	const storage = createMockStorage({
		pickDirectory: async () => rootOrigin,
		verifyPermission: async () => true
	});
	storage.readFile = mock(async () => diskContent);
	storage.readDirectory = mock(async () => []);
	const ws = new WorkspaceClass(storage, makeVcsFactory(), persistence);
	const host = new PluginHost();
	host.register({
		manifest: { id: 'observer', name: 'Observer', version: 0 },
		setup: () => {}
	});
	await host.activate('observer');
	const opened: unknown[] = [];
	const changed: Array<{ content: string; path: string | null }> = [];
	host.on(
		'document:opened',
		(payload) => {
			opened.push(payload);
		},
		'observer'
	);
	host.on(
		'document:changed',
		(payload) => {
			const event = payload as { content: string; document: { origin?: FileOrigin | null } };
			changed.push({ content: event.content, path: event.document.origin?.path ?? null });
		},
		'observer'
	);
	ws.setPluginHost(host);
	cleanups.push(() => {
		void host.deactivate('observer');
	});
	return { ws, opened, changed };
}

describe('the document lifecycle events (ADR 0013)', () => {
	it('announces an untitled document, with no origin to offer', async () => {
		const { ws, opened } = await makeWorkspace();

		const doc = await ws.newFile();

		expect(opened).toHaveLength(1);
		const payload = opened[0] as { document: { fileName?: string }; origin: FileOrigin | null };
		expect(payload.document.fileName).toBe(doc.fileName);
		// Origin null is the interesting half: whether an untitled document is
		// anyone's business is the consumer's decision, not the host's.
		expect(payload.origin).toBeNull();
	});

	it('announces a file opened from disk, with its content already read', async () => {
		const { ws, opened } = await makeWorkspace();

		const doc = await ws.openFile(fileOrigin);

		expect(opened).toHaveLength(1);
		const payload = opened[0] as { document: { content: string }; origin: FileOrigin | null };
		// Content before the emit, so an observer never has to wait for a read to
		// see the document as it is on disk.
		expect(payload.document.content).toBe('export const a = 1;\n');
		expect(payload.origin?.path).toBe(fileOrigin.path);
		expect(doc?.origin?.path).toBe(fileOrigin.path);
	});

	it('announces a restored session once the whole set is in place', async () => {
		const restored: SerializedDocument[] = [
			{ id: 'doc-1', origin: fileOrigin, content: 'export const a = 1;\n' } as SerializedDocument,
			{
				id: 'doc-2',
				origin: { scheme: 'file', path: '/repo/b.ts', name: 'b.ts' },
				content: 'export const b = 2;\n'
			} as SerializedDocument
		];
		const persistence = new MemorySessionPersistence();
		await persistence.saveOpenFiles(restored, '/repo');
		const { ws, opened } = await makeWorkspace(persistence);

		await ws.loadFolderState('/repo');

		// Both documents, once each: a consumer that starts a server per file sees
		// the whole workspace rather than a half-restored one.
		expect(opened).toHaveLength(2);
		const paths = (opened as Array<{ origin: FileOrigin | null }>).map(
			(payload) => payload.origin?.path
		);
		expect(paths).toEqual(['/repo/a.ts', '/repo/b.ts']);
		expect(ws.documents).toHaveLength(2);
	});

	it('announces a change with the new text, and nothing when the text is the same', async () => {
		const { ws, changed } = await makeWorkspace();
		const doc = await ws.openFile(fileOrigin);

		ws.updateDocumentContent(doc!, 'export const a = 2;\n');
		expect(changed).toEqual([{ content: 'export const a = 2;\n', path: '/repo/a.ts' }]);

		// The keystroke path returns early on identical content, so an observer is
		// not woken for an edit that is not one — a re-render, a revert, a save.
		ws.updateDocumentContent(doc!, 'export const a = 2;\n');
		expect(changed).toHaveLength(1);
		expect(doc!.content).toBe('export const a = 2;\n');
	});

	it('gives an observer no way to veto an open or an edit', async () => {
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		cleanups.push(() => errors.mockRestore());
		const storage = createMockStorage({
			pickDirectory: async () => rootOrigin,
			verifyPermission: async () => true
		});
		storage.readFile = mock(async () => 'export const a = 1;\n');
		const ws = new WorkspaceClass(storage, makeVcsFactory(), new MemorySessionPersistence());
		const host = new PluginHost();
		host.register({ manifest: { id: 'rude', name: 'Rude', version: 0 }, setup: () => {} });
		await host.activate('rude');
		cleanups.push(() => {
			void host.deactivate('rude');
		});
		// Both shapes an observer can be: one that throws, one that returns a
		// rejected promise. Neither may reach the editor.
		host.on(
			'document:opened',
			() => {
				throw new Error('observer refuses this document');
			},
			'rude'
		);
		host.on('document:changed', () => Promise.reject(new Error('async refusal')), 'rude');
		ws.setPluginHost(host);

		const doc = await ws.openFile(fileOrigin);
		expect(doc).not.toBeNull();
		expect(doc!.content).toBe('export const a = 1;\n');

		ws.updateDocumentContent(doc!, 'edited anyway\n');
		// The edit landed despite both refusals: an event is an announcement, not a
		// gate (ADR 0013), and the failures are recorded rather than raised.
		expect(doc!.content).toBe('edited anyway\n');
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(errors).toHaveBeenCalled();
	});
});
