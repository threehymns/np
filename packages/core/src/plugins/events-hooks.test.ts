import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock, spyOn } from 'bun:test';
import { PluginHost } from './host.svelte';
import { HookReentryError, SaveCancelledError } from './errors';
import { Workspace } from '../workspace.svelte';
import { DocumentSession } from '../document.svelte';
import { MemorySessionPersistence } from '../persistence';
import type { FileOrigin, Storage } from '../storage';
import type { VCSAdapter } from '../project/vcs';
import { Repository } from '../project/repository.svelte';
import { AppState } from '../state.svelte';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActiveHookContext } from './hooks';

function createLocalMockStorage(initialFiles: Record<string, string> = {}): Storage {
	const files = new Map<string, string>(Object.entries(initialFiles));
	return {
		readFile: mock(async (origin: FileOrigin) => {
			const content = files.get(origin.path);
			if (content === undefined) throw new Error(`Not found: ${origin.path}`);
			return content;
		}),
		writeFile: mock(async (origin: FileOrigin, content: string) => {
			files.set(origin.path, content);
		}),
		saveFile: mock(async (content: string, existingOrigin?: FileOrigin) => {
			const origin = existingOrigin ?? { scheme: 'file', path: '/saved.md', name: 'saved.md' };
			files.set(origin.path, content);
			return origin;
		}),
		openFileDialog: mock(async () => null),
		openDirectoryDialog: mock(async () => null),
		saveFileDialog: mock(async () => null),
		readDirectory: mock(async () => []),
		exists: mock(async (origin: FileOrigin) => files.has(origin.path)),
		deleteFile: mock(async (origin: FileOrigin) => {
			files.delete(origin.path);
		}),
		deleteDirectory: mock(async () => {}),
		verifyPermission: mock(async () => true),
		queryPermission: mock(async () => 'granted' as const),
		pickFile: mock(async () => null),
		pickDirectory: mock(async () => null),
		createFile: mock(async (parent: FileOrigin, name: string) => ({ scheme: 'file', path: `/${name}`, name })),
		createDirectory: mock(async (parent: FileOrigin, name: string) => ({ scheme: 'file', path: `/${name}`, name })),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (origin: FileOrigin, newName: string) => ({ scheme: 'file', path: `/${newName}`, name: newName }))
	};
}

async function createActiveEventHost(pluginId = 'event-observer') {
	const host = new PluginHost();
	host.register({
		manifest: { id: pluginId, name: pluginId, version: 0 },
		setup: () => undefined
	});
	await host.activate(pluginId);
	return { host, pluginId };
}

/**
 * Registers a stub plugin for a hook owner and activates it, the way a real
 * plugin reaches the host: the owner is registered before it contributes, and
 * only an active plugin's hooks run. Returns the id to pass to the hook
 * registration.
 */
async function hookOwner(host: PluginHost, pluginId: string): Promise<string> {
	if (!host.hasPlugin(pluginId)) {
		host.register({ manifest: { id: pluginId, name: pluginId, version: 0 }, setup: () => undefined });
	}
	if (!host.isPluginActive(pluginId)) {
		await host.activate(pluginId);
	}
	return pluginId;
}

function createMockVcsFactory(refreshSpy?: () => Promise<boolean>): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => true),
		getCurrentBranch: async () => 'main',
		getBranches: async () => ['main'],
		getChanges: async () => [],
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async () => ({ status: 'switched' as const })),
		refresh: refreshSpy ?? mock(async () => true)
	});
}

describe('Events and Document Save Hooks (#197, ADR 0013)', () => {
	describe('Event observation (on, off, emit)', () => {
		it('emits fire-and-forget events to subscribers for observation only', async () => {
			const { host, pluginId } = await createActiveEventHost();
			const received: any[] = [];

			const unsub = host.on('doc:saved', (payload) => {
				received.push(payload);
			}, pluginId);

			host.emit('doc:saved', { id: 'doc-1', path: '/notes/a.md' });
			expect(received).toHaveLength(1);
			expect(received[0]).toEqual({ id: 'doc-1', path: '/notes/a.md' });

			unsub();
			host.emit('doc:saved', { id: 'doc-2', path: '/notes/b.md' });
			expect(received).toHaveLength(1);
		});

		it('requires an owning plugin and ignores handlers owned by inactive plugins', () => {
			const host = new PluginHost();
			const handler = mock(() => undefined);

			host.register({
				manifest: { id: 'inactive-listener', name: 'Inactive Listener', version: 0 },
				setup: () => undefined
			});
			host.on('ownership-event', handler, 'inactive-listener');
			host.emit('ownership-event');
			expect(handler).not.toHaveBeenCalled();
			expect(() => host.on('ownership-event', handler)).toThrow(/owning plugin/i);
		});

		it('unsubscribes only the handler owned by the requesting plugin', async () => {
			const host = new PluginHost();
			const sharedHandler = mock(() => undefined);
			let unsubscribeA!: () => void;

			host.register({
				manifest: { id: 'plugin-b', name: 'Plugin B', version: 0 },
				setup: (h) => {
					h.on('shared-event', sharedHandler, 'plugin-b');
				}
			});
			host.register({
				manifest: { id: 'plugin-a', name: 'Plugin A', version: 0 },
				setup: (h) => {
					unsubscribeA = h.on('shared-event', sharedHandler, 'plugin-a');
				}
			});
			await host.activateAll();

			unsubscribeA();
			await host.deactivate('plugin-b');
			host.emit('shared-event');

			expect(sharedHandler).not.toHaveBeenCalled();
		});

		it('allows unsubscribing via off() method', async () => {
			const { host, pluginId } = await createActiveEventHost();
			let count = 0;
			const handler = () => {
				count++;
			};

			host.on('test-event', handler, pluginId);
			host.emit('test-event');
			expect(count).toBe(1);

			host.off('test-event', handler, pluginId);
			host.emit('test-event');
			expect(count).toBe(1);
		});

		it('contains throwing event handlers without interrupting emission or caller', async () => {
			const { host, pluginId } = await createActiveEventHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let secondHandlerCalled = false;
			host.on('ping', () => {
				throw new Error('Boom in event handler');
			}, pluginId);
			host.on('ping', () => {
				secondHandlerCalled = true;
			}, pluginId);

			expect(() => host.emit('ping', { foo: 'bar' })).not.toThrow();
			expect(secondHandlerCalled).toBe(true);
			expect(errorSpy).toHaveBeenCalled();

			errorSpy.mockRestore();
		});

		it('handles rejecting async event handlers gracefully', async () => {
			const { host, pluginId } = await createActiveEventHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			host.on('async-event', async () => {
				throw new Error('Async error');
			}, pluginId);

			expect(() => host.emit('async-event')).not.toThrow();
			// Wait for promise resolution tick
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(errorSpy).toHaveBeenCalled();

			errorSpy.mockRestore();
		});

		it('removes plugin event handlers on deactivation and unregister', async () => {
			const host = new PluginHost();
			let called = 0;

			host.register({
				manifest: { id: 'listener-plugin', name: 'Listener', version: 0 },
				setup: (h) => {
					h.on('lifecycle-event', () => {
						called++;
					}, 'listener-plugin');
				}
			});

			await host.activate('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(1);

			await host.deactivate('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(1);

			await host.activate('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(2);

			await host.unregister('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(2);
		});
	});

	describe('Handler and hook ownership (ADR 0013)', () => {
		it('rejects a save or workspace-opened hook whose owning plugin id is not registered', async () => {
			const host = new PluginHost();
			host.register({ manifest: { id: 'real-plugin', name: 'Real', version: 0 }, setup: () => undefined });

			// A mis-typed owner id would otherwise be accepted and then
			// retained forever: removal is by owner id, so the handler would
			// outlive every deactivate.
			const registrations: Array<(id: string) => unknown> = [
				(id) => host.registerBeforeSaveHook(id, async () => undefined),
				(id) => host.registerAfterSaveHook(id, async () => undefined),
				(id) => host.registerWorkspaceOpenedHook(id, async () => undefined),
				(id) => host.on('some-event', () => undefined, id)
			];

			for (const register of registrations) {
				expect(() => register('typo-plugin')).toThrow(/typo-plugin/);
				expect(() => register('')).toThrow(/owning plugin id/);
			}
		});

		it('leaves no hook behind after a mis-typed owner id is rejected', async () => {
			const { host } = await createActiveEventHost('real-plugin');
			const doc = new DocumentSession(createLocalMockStorage(), '');

			expect(() => host.registerBeforeSaveHook('git', async () => undefined)).toThrow(/git/);

			// The rejected hook is absent from the list deactivate filters, so
			// no save reports a hook error against a plugin that never ran.
			expect(await host.runBeforeSave({ document: doc })).toEqual({ cancel: false });
			expect(host.lastHookError).toBeNull();
		});
	});

	describe('Document Save Hooks on PluginHost', () => {
		it('executes before-save hooks sequentially in plugin activation order and awaits them', async () => {
			const host = new PluginHost();
			const order: string[] = [];

			// Register plugin a and plugin b where b depends on a
			host.register({
				manifest: { id: 'plugin-b', name: 'Plugin B', version: 0, dependsOn: { 'plugin-a': 0 } },
				setup: (h) => {
					h.registerBeforeSaveHook('plugin-b', async () => {
						await new Promise((r) => setTimeout(r, 10));
						order.push('plugin-b');
					});
				}
			});
			host.register({
				manifest: { id: 'plugin-a', name: 'Plugin A', version: 0 },
				setup: (h) => {
					h.registerBeforeSaveHook('plugin-a', async () => {
						await new Promise((r) => setTimeout(r, 5));
						order.push('plugin-a');
					});
				}
			});

			// Activate all (activation order will be plugin-a then plugin-b)
			await host.activateAll();

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });
			expect(result.cancel).toBe(false);
			expect(order).toEqual(['plugin-a', 'plugin-b']);
		});

		it('allows a before-save hook to cancel save with a user-visible reason via return object', async () => {
			const host = new PluginHost();

			await hookOwner(host, 'linter');
			host.registerBeforeSaveHook('linter', async () => {
				return { cancel: true, reason: 'Line 5: Unexpected syntax error' };
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });
			expect(result.cancel).toBe(true);
			expect(result.reason).toBe('Line 5: Unexpected syntax error');
		});

		it('allows a before-save hook to cancel save with SaveCancelledError', async () => {
			const host = new PluginHost();

			await hookOwner(host, 'validator');
			host.registerBeforeSaveHook('validator', async () => {
				throw new SaveCancelledError('Document contains uncommitted merge conflict markers');
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });
			expect(result.cancel).toBe(true);
			expect(result.reason).toBe('Document contains uncommitted merge conflict markers');
		});

		it('logs a throwing hook against its plugin while remaining hooks still run and save proceeds', async () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			const executed: string[] = [];

			await hookOwner(host, 'failing-plugin');
			host.registerBeforeSaveHook('failing-plugin', async () => {
				executed.push('failing-plugin');
				throw new TypeError('Cannot read properties of undefined');
			});

			await hookOwner(host, 'healthy-plugin');
			host.registerBeforeSaveHook('healthy-plugin', async () => {
				executed.push('healthy-plugin');
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });

			expect(result.cancel).toBe(false);
			expect(executed).toEqual(['failing-plugin', 'healthy-plugin']);
			expect(errorSpy).toHaveBeenCalled();
			expect(host.lastHookError?.pluginId).toBe('failing-plugin');

			errorSpy.mockRestore();
		});

		it('detects reentry when a hook calls save operation and fails with actionable HookReentryError naming the plugin', async () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let caughtInHook: unknown = null;

			await hookOwner(host, 'reentrant-plugin');
			host.registerBeforeSaveHook('reentrant-plugin', async (ctx) => {
				try {
					// Attempting to re-enter runBeforeSave
					await host.runBeforeSave(ctx);
				} catch (err) {
					caughtInHook = err;
					throw err;
				}
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });

			// The hook's reentrant call threw HookReentryError
			expect(caughtInHook).toBeInstanceOf(HookReentryError);
			const reentryErr = caughtInHook as HookReentryError;
			expect(reentryErr.pluginId).toBe('reentrant-plugin');
			expect(reentryErr.message).toContain('reentrant-plugin');
			expect(reentryErr.message).toContain('re-entered saveDocument during beforeSave hook');
			expect(reentryErr.message).toContain('Action:');

			// Save still proceeds because unhandled hook errors do not veto
			expect(result.cancel).toBe(false);

			errorSpy.mockRestore();
		});

		it('removes hooks on deactivation and unregistration', async () => {
			const host = new PluginHost();
			let hookRan = false;

			host.register({
				manifest: { id: 'hook-plugin', name: 'Hook Plugin', version: 0 },
				setup: (h) => {
					h.registerBeforeSaveHook('hook-plugin', () => {
						hookRan = true;
					});
				}
			});

			await host.activate('hook-plugin');
			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			await host.runBeforeSave({ document: doc });
			expect(hookRan).toBe(true);

			hookRan = false;
			await host.deactivate('hook-plugin');

			await host.runBeforeSave({ document: doc });
			expect(hookRan).toBe(false);

			await host.unregister('hook-plugin');
			await host.runBeforeSave({ document: doc });
			expect(hookRan).toBe(false);
		});

		it('waits for an active save hook before running cleanup (ADR 0009)', async () => {
			const host = new PluginHost();
			let cleanupRan = false;
			let releaseHook!: () => void;
			const hookGate = new Promise<void>((resolve) => {
				releaseHook = resolve;
			});

			host.register({
				manifest: { id: 'slow-hook', name: 'Slow Hook', version: 0 },
				setup: (h) => {
					h.registerBeforeSaveHook('slow-hook', async () => {
						await hookGate;
					});
					return async () => {
						cleanupRan = true;
					};
				}
			});

			await host.activate('slow-hook');
			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const savePromise = host.runBeforeSave({ document: doc });
			await new Promise((r) => setTimeout(r, 10));

			const deactivatePromise = host.deactivate('slow-hook', 'test');
			await new Promise((r) => setTimeout(r, 10));
			expect(cleanupRan).toBe(false);

			releaseHook();
			await savePromise;
			await deactivatePromise;
			expect(cleanupRan).toBe(true);
		});
	});

	describe('Workspace.saveDocument Integration', () => {
		it('notifies after-save consumers that a throwing save did not succeed', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage();
			storage.saveFile = async () => {
				throw new Error('disk full');
			};
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const observed: Array<{ documentId: string; success: boolean }> = [];
			await hookOwner(host, 'after-save-observer');
			host.registerAfterSaveHook('after-save-observer', async (context) => {
				observed.push({ documentId: context.document.id, success: context.success });
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, 'content', origin);

			// The write failed, so the caller still sees the failure...
			await expect(workspace.saveDocument(doc)).rejects.toThrow('disk full');
			// ...and every after-save consumer is still told the save did not
			// succeed, so a save-triggered refresh does not go stale silently.
			expect(observed).toEqual([{ documentId: doc.id, success: false }]);
		});

		it('cancels save when a before-save hook cancels with a reason the user sees', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage();
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			await hookOwner(host, 'formatter');
			host.registerBeforeSaveHook('formatter', async () => {
				return { cancel: true, reason: 'Formatting failed: missing semicolon' };
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, '', origin);
			doc.content = '# Test Content';

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(false);
			expect(workspace.lastSaveCancellationReason).toBe('Formatting failed: missing semicolon');
			// Storage write was never called
			expect(storage.saveFile).not.toHaveBeenCalled();
		});

		it('passes a read-only document view to save hooks', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/test.md': '' });
			const workspace = new Workspace(
				storage,
				createMockVcsFactory(),
				new MemorySessionPersistence(),
				host
			);
			let hookDocument: unknown;
			await hookOwner(host, 'reader');
			host.registerBeforeSaveHook('reader', (context) => {
				hookDocument = context.document;
			});
			const doc = new DocumentSession(
				storage,
				'',
				{ scheme: 'file', path: '/test.md', name: 'test.md' }
			);
			doc.content = 'original';

			expect(await workspace.saveDocument(doc)).toBe(true);
			expect((hookDocument as any).content).toBe('original');
			expect(() => {
				(hookDocument as any).content = 'bypassed';
			}).toThrow(TypeError);
			expect(doc.content).toBe('original');
		});

		it('shows a hook cancellation when saving before closing a document', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/test.md': 'saved' });
			const alert = mock(async () => {});
			const app = new AppState({
				storage,
				vcsFactory: createMockVcsFactory(),
				persistence: new MemorySessionPersistence(),
				pluginHost: host,
				dialogService: { alert }
			});
			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = await app.workspace.openFile(origin);
			expect(doc).toBeDefined();
			app.workspace.updateDocumentContent(doc!, 'edited');
			await hookOwner(host, 'close-formatter');
			host.registerBeforeSaveHook('close-formatter', () => ({
				cancel: true,
				reason: 'Formatting failed before close'
			}));

			app.closeDocument(doc!.id);
			expect(app.workspace.pendingCloseId).toBe(doc!.id);
			expect(await app.finalizeClose(doc!.id, true)).toBe(false);
			expect(alert).toHaveBeenCalledWith('Formatting failed before close');
			expect(app.workspace.tabs.some((tab) => tab.id === doc!.id)).toBe(true);
			expect(app.workspace.pendingCloseId).toBeNull();
		});

		it('proceeds with save and remaining hooks when a hook throws an error', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/test.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let afterHookRan = false;
			await hookOwner(host, 'faulty-hook');
			host.registerBeforeSaveHook('faulty-hook', () => {
				throw new Error('Unexpected crash in hook');
			});
			await hookOwner(host, 'after-hook');
			host.registerAfterSaveHook('after-hook', () => {
				afterHookRan = true;
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, '', origin);
			doc.content = 'Updated content';

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);
			expect(afterHookRan).toBe(true);
			expect(storage.saveFile).toHaveBeenCalled();

			errorSpy.mockRestore();
		});

		it('fails reentrant saveDocument calls with actionable HookReentryError naming the plugin', async () => {
			// No AsyncLocalStorage in this runtime, so re-entry is detected by
			// the bounded save-queue wait; keep that bound short for the test.
			const host = new PluginHost({ saveQueueTimeoutMs: 25 });
			const storage = createLocalMockStorage({ '/test.md': '', '/other.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let caughtReentryError: unknown = null;

			const otherOrigin: FileOrigin = { scheme: 'file', path: '/other.md', name: 'other.md' };
			const otherDoc = new DocumentSession(storage, '', otherOrigin);

			await hookOwner(host, 'recursive-saver');
			host.registerBeforeSaveHook('recursive-saver', async () => {
				try {
					await workspace.saveDocument(otherDoc);
				} catch (err) {
					caughtReentryError = err;
					throw err;
				}
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, '', origin);

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);

			expect(caughtReentryError).toBeInstanceOf(HookReentryError);
			const err = caughtReentryError as HookReentryError;
			expect(err.pluginId).toBe('recursive-saver');
			expect(err.message).toContain('recursive-saver');
			expect(err.message).toContain('re-entered saveDocument during beforeSave hook');
			expect(err.message).toContain('Action: Avoid calling save operations from within a save hook');

			errorSpy.mockRestore();
		});

		it('serializes concurrent independent saves instead of rejecting them as hook re-entry', async () => {
			const asyncStorage = new AsyncLocalStorage<ActiveHookContext>();
			const host = new PluginHost({
				operationContext: {
					propagation: 'async',
					run: (context, callback) => asyncStorage.run(context, callback),
					get: () => asyncStorage.getStore()
				}
			});
			const storage = createLocalMockStorage({ '/a.md': '', '/b.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			let hookRuns = 0;
			let releaseHook!: () => void;
			const gate = new Promise<void>((resolve) => (releaseHook = resolve));
			await hookOwner(host, 'slow-saver');
			host.registerBeforeSaveHook('slow-saver', async () => {
				hookRuns++;
				await gate;
			});

			const originA: FileOrigin = { scheme: 'file', path: '/a.md', name: 'a.md' };
			const docA = new DocumentSession(storage, '', originA);
			docA.content = 'A';

			const first = workspace.saveDocument(docA);
			// Let the first save reach (and suspend inside) its beforeSave hook.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(hookRuns).toBe(1);

			const originB: FileOrigin = { scheme: 'file', path: '/b.md', name: 'b.md' };
			const docB = new DocumentSession(storage, '', originB);
			docB.content = 'B';

			// The independent save must wait, not throw HookReentryError.
			let secondSettled = false;
			const second = workspace.saveDocument(docB).then((result) => {
				secondSettled = true;
				return result;
			});

			try {
				// The first hook is still blocked, so the second save must not
				// have advanced into its own hook or settled yet.
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(secondSettled).toBe(false);
				expect(hookRuns).toBe(1);
			} finally {
				releaseHook();
			}

			const [firstResult, secondResult] = await Promise.all([first, second]);
			expect(firstResult).toBe(true);
			expect(secondResult).toBe(true);
			expect(hookRuns).toBe(2);
			expect(docA.content).toBe('A');
			expect(docB.content).toBe('B');
		});

		it('rejects reentrant saveDocument even after the hook awaits, instead of deadlocking on saveQueue', async () => {
			const host = new PluginHost({ saveQueueTimeoutMs: 25 });
			const storage = createLocalMockStorage({ '/test.md': '', '/other.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let caughtReentryError: unknown = null;
			const otherOrigin: FileOrigin = { scheme: 'file', path: '/other.md', name: 'other.md' };
			const otherDoc = new DocumentSession(storage, '', otherOrigin);

			await hookOwner(host, 'async-recursive-saver');
			host.registerBeforeSaveHook('async-recursive-saver', async () => {
				// Yield/await first so synchronous execution window has elapsed
				await new Promise((resolve) => setTimeout(resolve, 5));
				try {
					await workspace.saveDocument(otherDoc);
				} catch (err) {
					caughtReentryError = err;
					throw err;
				}
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, '', origin);

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);

			expect(caughtReentryError).toBeInstanceOf(HookReentryError);
			const err = caughtReentryError as HookReentryError;
			expect(err.pluginId).toBe('async-recursive-saver');
			expect(err.message).toContain('async-recursive-saver');
			expect(err.message).toContain('re-entered saveDocument during beforeSave hook');

			errorSpy.mockRestore();
		});

		it('queues an independent save instead of rejecting it when async context propagation is unavailable', async () => {
			// The shipped browser and Electron renderer configuration has no
			// AsyncLocalStorage, so the host cannot tell a caller inside the
			// in-flight save's hook from an unrelated one. An unrelated save
			// must still wait its turn rather than be rejected as re-entry
			// against the wrong plugin.
			const host = new PluginHost({
				operationContext: {
					propagation: 'none',
					run: <T>(_context: ActiveHookContext, callback: () => T): T => callback(),
					get: () => undefined
				},
				saveQueueTimeoutMs: 1000
			});
			const storage = createLocalMockStorage({ '/a.md': '', '/b.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			let hookRuns = 0;
			let releaseHook!: () => void;
			const gate = new Promise<void>((resolve) => (releaseHook = resolve));
			await hookOwner(host, 'slow-saver');
			host.registerBeforeSaveHook('slow-saver', async () => {
				hookRuns++;
				await gate;
			});

			const docA = new DocumentSession(storage, '', { scheme: 'file', path: '/a.md', name: 'a.md' });
			docA.content = 'A';
			const first = workspace.saveDocument(docA);
			for (let i = 0; i < 50 && hookRuns === 0; i++) await new Promise((r) => setTimeout(r, 1));
			expect(hookRuns).toBe(1);

			const docB = new DocumentSession(storage, '', { scheme: 'file', path: '/b.md', name: 'b.md' });
			docB.content = 'B';
			let secondSettled = false;
			const second = workspace.saveDocument(docB).then((result) => {
				secondSettled = true;
				return result;
			});
			second.catch(() => {});

			// Still blocked on the first save's hook: queued, not rejected.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(host.lastHookError).toBeNull();
			expect(secondSettled).toBe(false);
			expect(hookRuns).toBe(1);

			releaseHook();
			expect(await first).toBe(true);
			expect(await second).toBe(true);
			expect(hookRuns).toBe(2);
		});

		it('rejects delayed save re-entry when async context propagation is unavailable', async () => {
			let getStoreCalls = 0;
			const operationContext = {
				propagation: 'none' as const,
				get: () => {
					getStoreCalls++;
					return undefined;
				},
				run: <T>(_context: unknown, callback: () => T): T => callback()
			};
			const host = new PluginHost({ operationContext, saveQueueTimeoutMs: 25 });
			const storage = createLocalMockStorage({ '/test.md': '', '/other.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
			let caughtReentryError: unknown = null;
			const otherDoc = new DocumentSession(
				storage,
				'',
				{ scheme: 'file', path: '/other.md', name: 'other.md' }
			);

			await hookOwner(host, 'browser-async-saver');
			host.registerBeforeSaveHook('browser-async-saver', async () => {
				await Promise.resolve();
				try {
					await workspace.saveDocument(otherDoc);
				} catch (error) {
					caughtReentryError = error;
					throw error;
				}
			});

			const doc = new DocumentSession(
				storage,
				'',
				{ scheme: 'file', path: '/test.md', name: 'test.md' }
			);
			expect(await workspace.saveDocument(doc)).toBe(true);
			expect(caughtReentryError).toBeInstanceOf(HookReentryError);
			expect((caughtReentryError as HookReentryError).pluginId).toBe('browser-async-saver');
			expect(getStoreCalls).toBeGreaterThan(0);
			errorSpy.mockRestore();
		});

		it('releases the save queue slot when a queued re-entry wait is rejected', async () => {
			// A re-entrant save is refused, but it must not keep the slot it
			// queued behind: an unrelated later save still gets its turn.
			const operationContext = {
				propagation: 'none' as const,
				get: () => undefined,
				run: <T>(_context: unknown, callback: () => T): T => callback()
			};
			const host = new PluginHost({ operationContext, saveQueueTimeoutMs: 25 });
			const storage = createLocalMockStorage({ '/first.md': '', '/other.md': '', '/later.md': '' });
			const workspace = new Workspace(storage, createMockVcsFactory(), new MemorySessionPersistence(), host);
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			await hookOwner(host, 'browser-async-saver');
			let caughtReentryError: unknown = null;
			const reentrantDoc = new DocumentSession(storage, '', { scheme: 'file', path: '/other.md', name: 'other.md' });
			host.registerBeforeSaveHook('browser-async-saver', async () => {
				await Promise.resolve();
				try {
					await workspace.saveDocument(reentrantDoc);
				} catch (error) {
					caughtReentryError = error;
					throw error;
				}
			});

			const firstDoc = new DocumentSession(storage, '', { scheme: 'file', path: '/first.md', name: 'first.md' });
			expect(await workspace.saveDocument(firstDoc)).toBe(true);
			expect(caughtReentryError).toBeInstanceOf(HookReentryError);

			const laterDoc = new DocumentSession(storage, '', { scheme: 'file', path: '/later.md', name: 'later.md' });
			laterDoc.content = 'later content';
			const laterSave = workspace.saveDocument(laterDoc);
			const outcome = await Promise.race([
				laterSave.then((saved) => `saved:${saved}` as const),
				new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500))
			]);
			errorSpy.mockRestore();

			expect(outcome).toBe('saved:true');
		});

		it('flows repository refresh on save through the Git plugin afterSave hook with no behavior change', async () => {
			const host = new PluginHost();
			const { gitRegistration } = await import('./git/registration');
			host.register(gitRegistration);
			const storage = createLocalMockStorage({ '/repo/file.md': '' });
			const persistence = new MemorySessionPersistence();

			const vcsFactory = createMockVcsFactory();
			const workspace = new Workspace(storage, vcsFactory, persistence, host);
			await host.activate('git');

			// Open a folder so workspace.repository is initialized
			const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			const repo = new Repository(rootOrigin, vcsFactory);
			const refreshSpy = spyOn(repo, 'refresh');
			workspace.repository = repo;

			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/file.md', name: 'file.md' };
			const doc = new DocumentSession(storage, '', fileOrigin);
			doc.content = 'Updated file content';

			expect(refreshSpy).not.toHaveBeenCalled();

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);

			// Verify repository.refresh() was called via the Git plugin's afterSave hook
			expect(refreshSpy).toHaveBeenCalled();

			refreshSpy.mockRestore();
		});

		it('performs no repository refresh on save without the Git plugin (no hardwired hook)', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/repo/file.md': '' });
			const persistence = new MemorySessionPersistence();

			const vcsFactory = createMockVcsFactory();
			const workspace = new Workspace(storage, vcsFactory, persistence, host);

			const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			const repo = new Repository(rootOrigin, vcsFactory);
			const refreshSpy = spyOn(repo, 'refresh');
			workspace.repository = repo;

			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/file.md', name: 'file.md' };
			const doc = new DocumentSession(storage, '', fileOrigin);
			doc.content = 'Updated file content';

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);

			// The old hardwired core:repository-refresh hook is gone (#202):
			// without the Git plugin nothing refreshes on save.
			expect(refreshSpy).not.toHaveBeenCalled();

			refreshSpy.mockRestore();
		});

		it('emits document:saved event upon successful save', async () => {
			const host = new PluginHost();
			host.register({
				manifest: { id: 'saved-observer', name: 'Saved Observer', version: 0 },
				setup: () => undefined
			});
			await host.activate('saved-observer');
			const storage = createLocalMockStorage({ '/notes/memo.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const savedEvents: any[] = [];
			host.on('document:saved', (payload) => {
				savedEvents.push(payload);
			}, 'saved-observer');

			const origin: FileOrigin = { scheme: 'file', path: '/notes/memo.md', name: 'memo.md' };
			const doc = new DocumentSession(storage, '', origin);
			doc.content = 'Important memo';

			await workspace.saveDocument(doc);

			expect(savedEvents).toHaveLength(1);
			expect(savedEvents[0].document).toBe(doc);
			expect(savedEvents[0].origin).toEqual(origin);
		});
	});

	describe('Workspace-opened hooks (ADR 0013 containment)', () => {
		it('contains a throwing hook with plugin attribution and still runs remaining hooks', async () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
			const ran: string[] = [];

			await hookOwner(host, 'faulty-plugin');
			host.registerWorkspaceOpenedHook('faulty-plugin', () => {
				throw new Error('Detect blew up');
			});
			await hookOwner(host, 'steady-plugin');
			host.registerWorkspaceOpenedHook('steady-plugin', () => {
				ran.push('steady-plugin');
			});

			const origin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };
			await expect(host.runWorkspaceOpened({ origin, workspace: {} })).resolves.toBeUndefined();

			// Remaining hooks still run; the failure is never an implicit veto.
			expect(ran).toEqual(['steady-plugin']);
			// Attributed and actionable: recorded plus logged with an AI-fixable Action.
			expect(host.lastHookError?.pluginId).toBe('faulty-plugin');
			expect(errorSpy).toHaveBeenCalled();
			const logged = errorSpy.mock.calls.flat().map(String).join('\n');
			expect(logged).toContain('faulty-plugin');
			expect(logged).toContain('Action:');

			errorSpy.mockRestore();
		});

		it('lets folder open proceed with an empty slot when the owning hook fails', async () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
			const { gitRegistration } = await import('./git/registration');
			host.register(gitRegistration);
			const storage = createLocalMockStorage({ '/repo/file.md': '' });
			const persistence = new MemorySessionPersistence();
			const failingFactory = (): VCSAdapter => ({
				detect: mock(async () => {
					throw new Error('probe crashed');
				}),
				getCurrentBranch: async () => 'main',
				getBranches: async () => ['main'],
				getChanges: async () => [],
				getCommits: async () => [],
				getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
				switchBranch: mock(async () => ({ status: 'switched' as const }))
			});
			const workspace = new Workspace(storage, failingFactory, persistence, host);
			await host.activate('git');

			// Folder open proceeds instead of aborting: no throw, empty
			// slot (never stale), tree scan still ran.
			await workspace.openDirectory({ scheme: 'file', path: '/repo', name: 'repo' });
			expect(workspace.repository).toBeNull();
			expect(storage.readDirectory).toHaveBeenCalled();
			expect(host.lastHookError?.pluginId).toBe('git');

			errorSpy.mockRestore();
		});
	});
});
