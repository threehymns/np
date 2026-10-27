import '../../../tests/contract/rune-setup';
import { describe, it, expect, mock, beforeAll, afterEach } from 'bun:test';
import { createMockStorage } from '../../../tests/mock-storage';
import { MemorySessionPersistence } from './persistence';
import type { VCSAdapter } from './project/vcs';
import type { Workspace } from './workspace.svelte';
import type { FileOrigin } from './storage';
import type { AutosaveSetting } from './autosave';

beforeAll(async () => {
	mock.module('svelte/reactivity', () => ({
		SvelteMap: Map,
		SvelteSet: Set
	}));
});

let WorkspaceClass: typeof import('./workspace.svelte').Workspace;
beforeAll(async () => {
	const mod = await import('./workspace.svelte');
	WorkspaceClass = mod.Workspace;
});

const ORIGIN = { scheme: 'file', path: '/notes.md', name: 'notes.md' } as FileOrigin;
const OTHER_ORIGIN = { scheme: 'file', path: '/other.md', name: 'other.md' } as FileOrigin;

interface Harness {
	ws: Workspace;
	storage: ReturnType<typeof createMockStorage>;
	writes: { content: string; origin?: FileOrigin }[];
	setAutosave: (setting: AutosaveSetting) => void;
}

function makeHarness(options: { saveSucceeds?: boolean } = {}): Harness {
	const contentByPath: Record<string, string> = {
		[ORIGIN.path]: 'disk notes',
		[OTHER_ORIGIN.path]: 'disk other'
	};
	const storage = createMockStorage({
		verifyPermission: async () => true,
		queryPermission: async () => 'granted'
	});
	const writes: { content: string; origin?: FileOrigin }[] = [];

	storage.readFile = mock(async (origin) => contentByPath[origin.path] ?? '');
	storage.saveFile = mock(async (content, origin) => {
		if (options.saveSucceeds === false) return null;
		const target = origin ?? ORIGIN;
		writes.push({ content, origin: target });
		contentByPath[target.path] = content;
		return target;
	});

	const ws = new WorkspaceClass(
		storage,
		() => ({ detect: async () => false } as unknown as VCSAdapter),
		new MemorySessionPersistence()
	);

	return {
		ws,
		storage,
		writes,
		setAutosave: (setting) => {
			ws.autosaveSettingProvider = () => setting;
		}
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let activeWorkspace: Workspace | null = null;

afterEach(() => {
	activeWorkspace?.dispose();
	activeWorkspace = null;
});

function track(ws: Workspace): Workspace {
	activeWorkspace = ws;
	return ws;
}

describe('Workspace autosave after_delay', () => {
	it('saves a dirty file only after typing has been idle for the delay', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave({ after_delay: { milliseconds: 60 } });

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'edited notes');

		await sleep(20);
		expect(writes).toHaveLength(0);
		expect(doc!.isModified).toBe(true);

		await waitFor(() => !doc!.isModified);
		expect(writes).toEqual([{ content: 'edited notes', origin: ORIGIN }]);
	});

	it('resets the inactivity timer on every edit and writes the latest text', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave({ after_delay: { milliseconds: 80 } });

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'first edit');

		await sleep(40);
		ws.updateDocumentContent(doc!, 'second edit');
		await sleep(55);

		expect(doc!.isModified).toBe(true);
		expect(writes).toHaveLength(0);

		await waitFor(() => !doc!.isModified);
		expect(writes).toEqual([{ content: 'second edit', origin: ORIGIN }]);
	});

	it('does not autosave untitled, clean, or deleted-on-disk documents', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave({ after_delay: { milliseconds: 30 } });

		const clean = await ws.openFile(ORIGIN);
		const untitled = await ws.newFile();
		ws.updateDocumentContent(untitled, 'untitled draft');

		const deleted = await ws.openFile(OTHER_ORIGIN);
		deleted!.deletedOnDisk = true;
		ws.updateDocumentContent(deleted!, 'deleted draft');

		await sleep(90);

		expect(writes).toHaveLength(0);
		expect(clean!.isModified).toBe(false);
		expect(untitled.isModified).toBe(true);
		expect(deleted!.isModified).toBe(true);
	});

	it('falls back to off when a provider returns an unrecognised value', async () => {
		const { ws, writes } = makeHarness();
		track(ws);
		ws.autosaveSettingProvider = () => ({ after_delay: { milliseconds: -1 } }) as AutosaveSetting;

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'still dirty');

		await sleep(60);
		expect(writes).toHaveLength(0);
		expect(doc!.isModified).toBe(true);
	});

	it('cancels a pending save when auto-save is turned off before the delay elapses', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave({ after_delay: { milliseconds: 50 } });

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'do not save');
		await sleep(15);
		setAutosave('off');

		await sleep(90);
		expect(writes).toHaveLength(0);
		expect(doc!.isModified).toBe(true);
	});

	it('restarts a pending timer when the setting changes to a shorter delay', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave({ after_delay: { milliseconds: 1000 } });

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'shortened delay edit');
		await sleep(20);

		setAutosave({ after_delay: { milliseconds: 40 } });
		ws.refreshAutosavePolicy();

		await waitFor(() => !doc!.isModified, 500);
		expect(writes).toEqual([{ content: 'shortened delay edit', origin: ORIGIN }]);
	});

	it('does not autosave a document that is no longer open', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave('on_focus_change');

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'stale focus edit');
		ws.documents = [];

		await ws.autosaveOnFocusChange(doc!);
		expect(writes).toHaveLength(0);
		expect(doc!.isModified).toBe(true);
	});
});

describe('Workspace autosave named triggers', () => {
	it('saves on focus change only for the focus trigger and only dirty files', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave('on_focus_change');

		const dirty = await ws.openFile(ORIGIN);
		const clean = await ws.openFile(OTHER_ORIGIN);
		ws.updateDocumentContent(dirty!, 'focus edit');

		await ws.autosaveOnFocusChange(clean!);
		expect(writes).toHaveLength(0);

		await ws.autosaveOnFocusChange(dirty!);
		expect(writes).toEqual([{ content: 'focus edit', origin: ORIGIN }]);
		expect(dirty!.isModified).toBe(false);
	});

	it('ignores focus changes in the other named modes', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave('on_window_change');

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'edit');
		await ws.autosaveOnFocusChange(doc!);

		expect(writes).toHaveLength(0);
		expect(doc!.isModified).toBe(true);
	});

	it('saves every eligible file on window change', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave('on_window_change');

		const first = await ws.openFile(ORIGIN);
		const second = await ws.openFile(OTHER_ORIGIN);
		const untitled = await ws.newFile();
		ws.updateDocumentContent(first!, 'first window edit');
		ws.updateDocumentContent(second!, 'second window edit');
		ws.updateDocumentContent(untitled, 'untitled window edit');

		await ws.autosaveOnWindowChange();

		expect(writes).toEqual([
			{ content: 'first window edit', origin: ORIGIN },
			{ content: 'second window edit', origin: OTHER_ORIGIN }
		]);
		expect(first!.isModified).toBe(false);
		expect(second!.isModified).toBe(false);
		expect(untitled.isModified).toBe(true);
	});

	it('ignores window changes in the other named modes', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave('on_focus_change');

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'edit');
		await ws.autosaveOnWindowChange();

		expect(writes).toHaveLength(0);
		expect(doc!.isModified).toBe(true);
	});
});

describe('Workspace autosave close behaviour', () => {
	it('saves a dirty file before closing whenever autosave is enabled', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave('on_focus_change');

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'close edit');

		await ws.closeTab(doc!.id);

		expect(writes).toEqual([{ content: 'close edit', origin: ORIGIN }]);
		expect(ws.tabs).toHaveLength(0);
		expect(ws.pendingCloseId).toBeNull();
	});

	it('still prompts when autosave is off', async () => {
		const { ws, writes } = makeHarness();
		track(ws);

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'close edit');

		await ws.closeTab(doc!.id);

		expect(writes).toHaveLength(0);
		expect(ws.pendingCloseId).toBe(doc!.id);
		expect(ws.tabs.some((tab) => tab.id === doc!.id)).toBe(true);
		ws.cancelPendingClose();
	});

	it('keeps the prompt for untitled files even when autosave is enabled', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave({ after_delay: { milliseconds: 10 } });

		const untitled = await ws.newFile();
		ws.updateDocumentContent(untitled, 'untitled close edit');

		await ws.closeTab(untitled.id);

		expect(writes).toHaveLength(0);
		expect(ws.pendingCloseId).toBe(untitled.id);
		expect(ws.tabs.some((tab) => tab.id === untitled.id)).toBe(true);
		ws.cancelPendingClose();
	});

	it('keeps the prompt for a file deleted on disk even when autosave is enabled', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave('on_window_change');

		const doc = await ws.openFile(ORIGIN);
		doc!.deletedOnDisk = true;
		ws.updateDocumentContent(doc!, 'deleted close edit');

		await ws.closeTab(doc!.id);

		expect(writes).toHaveLength(0);
		expect(ws.pendingCloseId).toBe(doc!.id);
		expect(ws.tabs.some((tab) => tab.id === doc!.id)).toBe(true);
		ws.cancelPendingClose();
	});

	it('falls back to the prompt when the save fails', async () => {
		const { ws, setAutosave } = makeHarness({ saveSucceeds: false });
		track(ws);
		setAutosave('on_window_change');

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'unwritable edit');

		await ws.closeTab(doc!.id);

		expect(ws.pendingCloseId).toBe(doc!.id);
		expect(ws.tabs.some((tab) => tab.id === doc!.id)).toBe(true);
		expect(doc!.isModified).toBe(true);
		ws.cancelPendingClose();
	});

	it('saves eligible files in a batch close and still prompts for the rest', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		track(ws);
		setAutosave({ after_delay: { milliseconds: 10 } });

		const first = await ws.openFile(ORIGIN);
		const second = await ws.openFile(OTHER_ORIGIN);
		const untitled = await ws.newFile();
		ws.updateDocumentContent(first!, 'first batch edit');
		ws.updateDocumentContent(second!, 'second batch edit');
		ws.updateDocumentContent(untitled, 'untitled batch edit');

		await ws.closeAllTabs();

		expect(writes).toEqual([
			{ content: 'first batch edit', origin: ORIGIN },
			{ content: 'second batch edit', origin: OTHER_ORIGIN }
		]);
		expect(ws.tabs.map((tab) => tab.id)).toEqual([untitled.id]);
		expect(ws.pendingCloseId).toBe(untitled.id);
		ws.cancelPendingClose();
	});
});

describe('Workspace autosave lifecycle', () => {
	it('cancels pending inactivity saves when the workspace is disposed', async () => {
		const { ws, writes, setAutosave } = makeHarness();
		activeWorkspace = ws;
		setAutosave({ after_delay: { milliseconds: 40 } });

		const doc = await ws.openFile(ORIGIN);
		ws.updateDocumentContent(doc!, 'edit before dispose');

		ws.dispose();
		activeWorkspace = null;

		await sleep(100);
		expect(writes).toHaveLength(0);
	});
});
